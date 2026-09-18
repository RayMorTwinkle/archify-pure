import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { pathsAlias } from '../renderers/shared/output-path.mjs';
import { browserCheckSidecarPaths } from './visual-check.mjs';

export const FINALIZE_STAGES = Object.freeze(['validate', 'deliver', 'check', 'browser-check']);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function identity(file) {
  try {
    const bytes = fs.readFileSync(file);
    return { path: path.resolve(file), sha256: sha256(bytes), bytes: bytes.byteLength };
  } catch {
    return { path: path.resolve(file) };
  }
}

function durationMs(start) {
  return Number((process.hrtime.bigint() - start) / 1000000n);
}

function writeJsonAtomic(file, value) {
  const target = path.resolve(file);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function parsedReceipt(stdout) {
  const source = String(stdout || '').trim();
  if (!source) return null;
  try { return JSON.parse(source); } catch { return null; }
}

function stageStatus(exitCode, receipt) {
  if (exitCode === 2 || receipt?.status === 'skipped') return 'skipped';
  return exitCode === 0 && receipt?.ok !== false ? 'pass' : 'fail';
}

function failureDiagnostics(stage, result, receipt) {
  if (Array.isArray(receipt?.diagnostics) && receipt.diagnostics.length) return receipt.diagnostics;
  return [{
    code: 'finalize/stage-failure',
    severity: 'error',
    message: `The ${stage} stage did not complete successfully.`,
    subject: { stage },
    evidence: {
      exitCode: result.status ?? 1,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(result.error?.message ? { reason: result.error.message } : {}),
      ...(String(result.stderr || '').trim() ? { stderr: String(result.stderr).trim() } : {}),
    },
    supportedFixes: ['read the full finalize receipt and the failed stage receipt, repair that stage, then rerun finalize'],
  }];
}

function sidecarFile(directory, value) {
  if (!value) return null;
  return path.resolve(directory, value);
}

function browserEvidence(receipt, artifactPath) {
  if (!receipt) return {};
  const directory = receipt.sidecars?.directory
    ? path.resolve(receipt.sidecars.directory)
    : path.dirname(path.resolve(artifactPath));
  return {
    ...(receipt.sidecars?.receipt ? { browserCheckReceipt: sidecarFile(directory, receipt.sidecars.receipt) } : {}),
  };
}

function defaultRunner({ cliPath, args, cwd, env }) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

function stageArguments({ stage, type, input, output, quality, repoRoot, outDir }) {
  const qualityArgs = ['--quality', quality];
  const repoArgs = repoRoot ? ['--repo-root', repoRoot] : [];
  if (stage === 'validate') return ['validate', type, input, ...qualityArgs, ...repoArgs, '--json'];
  if (stage === 'deliver') return ['deliver', type, input, output, ...qualityArgs, ...repoArgs, '--json'];
  if (stage === 'check') return ['check', output, '--require-provenance'];
  return [
    'browser-check', output, '--json', '--require-provenance',
    ...(outDir ? ['--out-dir', outDir] : []),
  ];
}

export function defaultFinalizeReceiptPath(output, { outDir } = {}) {
  const artifact = path.resolve(output);
  const stem = path.basename(artifact).replace(/\.html?$/i, '');
  return path.join(outDir ? path.resolve(outDir) : path.dirname(artifact), `${stem}.finalize.json`);
}

function reservedFinalizePaths({ input, output, outDir }) {
  const artifact = path.resolve(output);
  const delivery = artifact.replace(/\.html?$/i, '.delivery.json');
  const browser = browserCheckSidecarPaths(artifact, { outDir });
  return [
    path.resolve(input),
    artifact,
    delivery,
    delivery.replace(/\.json$/i, '-pending.json'),
    delivery.replace(/\.json$/i, '-lock.json'),
    browser.receipt,
  ];
}

export function compactFinalizeReceipt(receipt) {
  const gates = {};
  for (const stage of FINALIZE_STAGES) gates[stage] = receipt.stages?.[stage]?.status || 'not-run';
  return {
    schemaVersion: 1,
    ok: receipt.ok,
    command: 'finalize',
    status: receipt.status,
    type: receipt.type,
    quality: receipt.quality,
    specification: receipt.specification,
    artifact: receipt.artifact,
    gates,
    ...(receipt.failedStage ? { failedStage: receipt.failedStage } : {}),
    diagnostics: (receipt.diagnostics || []).map((entry) => ({
      code: entry.code,
      severity: entry.severity || 'error',
      message: entry.message,
    })),
    evidence: receipt.evidence,
    visualReview: receipt.visualReview || 'not-requested',
    durationMs: receipt.durationMs,
  };
}

export function runFinalize({
  cliPath,
  type,
  input,
  output,
  quality = 'showcase',
  repoRoot,
  outDir,
  receiptPath = defaultFinalizeReceiptPath(output, { outDir }),
  cwd = process.cwd(),
  env = process.env,
  runCommand = defaultRunner,
} = {}) {
  if (!cliPath || !type || !input || !output) throw new Error('finalize requires cliPath, type, input, and output.');
  const started = process.hrtime.bigint();
  const startedAt = new Date().toISOString();
  const resolvedInput = path.resolve(input);
  const resolvedOutput = path.resolve(output);
  const resolvedReceipt = path.resolve(receiptPath);
  const resolvedOutDir = outDir ? path.resolve(outDir) : undefined;
  const receiptCollision = reservedFinalizePaths({
    input: resolvedInput,
    output: resolvedOutput,
    outDir: resolvedOutDir,
  }).find((reserved) => pathsAlias(resolvedReceipt, reserved));
  if (receiptCollision) {
    throw new Error(`The finalize receipt must be distinct from the specification, artifact, and gate sidecars: "${receiptCollision}".`);
  }

  const receipt = {
    schemaVersion: 1,
    ok: false,
    command: 'finalize',
    status: 'running',
    type,
    quality,
    startedAt,
    specification: identity(resolvedInput),
    artifact: { path: resolvedOutput },
    stages: {},
    diagnostics: [],
    evidence: { receipt: resolvedReceipt },
    visualReview: 'not-requested',
  };
  writeJsonAtomic(resolvedReceipt, receipt);

  let exitCode = 0;
  for (const stage of FINALIZE_STAGES) {
    const stageStarted = process.hrtime.bigint();
    const args = stageArguments({
      stage,
      type,
      input: resolvedInput,
      output: resolvedOutput,
      quality,
      repoRoot,
      outDir: resolvedOutDir,
    });
    const result = runCommand({ stage, cliPath, args, cwd, env });
    const stageReceipt = parsedReceipt(result.stdout);
    const code = result.status ?? 1;
    const status = stageStatus(code, stageReceipt);
    receipt.stages[stage] = {
      status,
      exitCode: code,
      durationMs: durationMs(stageStarted),
      command: [process.execPath, cliPath, ...args],
      ...(stageReceipt ? { receipt: stageReceipt } : {}),
      ...(!stageReceipt && String(result.stdout || '').trim() ? { stdout: String(result.stdout).trim() } : {}),
      ...(String(result.stderr || '').trim() ? { stderr: String(result.stderr).trim() } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
    };

    if (stage === 'deliver' && stageReceipt?.artifact) receipt.artifact = stageReceipt.artifact;
    if (stage === 'check' && stageReceipt?.artifact) receipt.artifact = {
      path: resolvedOutput,
      ...stageReceipt.artifact,
    };
    if (stage === 'browser-check') {
      receipt.evidence = {
        receipt: resolvedReceipt,
        ...browserEvidence(stageReceipt, resolvedOutput),
      };
    }

    if (status !== 'pass') {
      exitCode = status === 'skipped' ? 2 : (code || 1);
      receipt.status = status;
      receipt.diagnostics = failureDiagnostics(stage, result, stageReceipt);
      receipt.failedStage = stage;
      break;
    }
    writeJsonAtomic(resolvedReceipt, receipt);
  }

  receipt.ok = exitCode === 0;
  receipt.status = receipt.ok ? 'pass' : receipt.status === 'running' ? 'fail' : receipt.status;
  receipt.artifact = receipt.ok ? identity(resolvedOutput) : receipt.artifact;
  receipt.finishedAt = new Date().toISOString();
  receipt.durationMs = durationMs(started);
  writeJsonAtomic(resolvedReceipt, receipt);
  return { exitCode, receipt, summary: compactFinalizeReceipt(receipt) };
}
