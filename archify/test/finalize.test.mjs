import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compactFinalizeReceipt,
  defaultFinalizeReceiptPath,
  runFinalize,
} from '../bin/finalize.mjs';

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-finalize-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function result(receipt, status = 0, stderr = '') {
  return { status, signal: null, stdout: `${JSON.stringify(receipt)}\n`, stderr };
}

test('finalize runs the four gates in order and keeps full stage receipts out of its compact summary', t => {
  const directory = workspace(t);
  const input = path.join(directory, 'diagram.json');
  const output = path.join(directory, 'diagram.html');
  const outDir = path.join(directory, 'evidence');
  fs.writeFileSync(input, '{"meta":{"quality_profile":"showcase"}}');
  const calls = [];
  const runCommand = ({ stage, args }) => {
    calls.push({ stage, args });
    if (stage === 'validate') return result({
      schemaVersion: 1, ok: true, command: 'validate', checks: Array.from({ length: 9 }, (_, index) => ({ index })),
    });
    if (stage === 'deliver') {
      fs.writeFileSync(output, '<!doctype html><title>verified</title>');
      return result({ schemaVersion: 1, ok: true, command: 'deliver', artifact: { path: output, sha256: 'delivery-sha', bytes: 46 } });
    }
    if (stage === 'check') return result({ schemaVersion: 1, ok: true, artifact: { sha256: 'check-sha', bytes: 46 }, provenance: 'current' });
    fs.mkdirSync(outDir, { recursive: true });
    for (const file of ['diagram.visual-check.json', 'diagram.visual-check.html', 'diagram.visual-check.contact.png']) {
      fs.writeFileSync(path.join(outDir, file), file);
    }
    return result({
      schemaVersion: 1,
      ok: true,
      command: 'visual-check',
      status: 'pass',
      diagnostics: [],
      sidecars: { directory: outDir, receipt: 'diagram.visual-check.json' },
      captures: {
        contactSheet: 'diagram.visual-check.html',
        contactSheetImage: 'diagram.visual-check.contact.png',
        screenshots: [{ file: 'large-stage-array-is-kept-only-in-full-receipt.png' }],
      },
    });
  };

  const finalized = runFinalize({
    cliPath: '/fake/archify.mjs',
    type: 'architecture',
    input,
    output,
    outDir,
    runCommand,
  });

  assert.equal(finalized.exitCode, 0);
  assert.equal(finalized.receipt.ok, true);
  assert.deepEqual(calls.map(({ stage }) => stage), ['validate', 'deliver', 'check', 'visual-check']);
  assert.deepEqual(finalized.summary.gates, {
    validate: 'pass', deliver: 'pass', check: 'pass', 'visual-check': 'pass',
  });
  assert.equal(finalized.summary.evidence.contactSheetImage, path.join(outDir, 'diagram.visual-check.contact.png'));
  assert.equal('stages' in finalized.summary, false);
  assert.equal(JSON.stringify(finalized.summary).includes('large-stage-array'), false);
  assert.equal(finalized.receipt.stages['visual-check'].receipt.captures.screenshots.length, 1);

  const receiptPath = defaultFinalizeReceiptPath(output, { outDir });
  assert.equal(finalized.summary.evidence.receipt, receiptPath);
  const persisted = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(persisted.ok, true);
  assert.equal(persisted.stages.validate.receipt.checks.length, 9);
});

test('finalize stops at the failed gate and persists actionable failure evidence', t => {
  const directory = workspace(t);
  const input = path.join(directory, 'diagram.json');
  const output = path.join(directory, 'diagram.html');
  fs.writeFileSync(input, '{}');
  const calls = [];
  const finalized = runFinalize({
    cliPath: '/fake/archify.mjs',
    type: 'workflow',
    input,
    output,
    runCommand: ({ stage }) => {
      calls.push(stage);
      if (stage === 'validate') return result({ ok: true, command: 'validate' });
      return result({
        ok: false,
        command: 'deliver',
        diagnostics: [{
          code: 'composition/route-crossing',
          severity: 'error',
          message: 'A route crosses an unrelated node.',
          subject: { edge: 'a-b' },
          evidence: { intersection: [12, 40] },
          supportedFixes: ['move the diagnosed route'],
        }],
      }, 1);
    },
  });

  assert.equal(finalized.exitCode, 1);
  assert.deepEqual(calls, ['validate', 'deliver']);
  assert.equal(finalized.receipt.failedStage, 'deliver');
  assert.equal(finalized.summary.gates.check, 'not-run');
  assert.equal(finalized.summary.gates['visual-check'], 'not-run');
  assert.deepEqual(finalized.summary.diagnostics, [{
    code: 'composition/route-crossing',
    severity: 'error',
    message: 'A route crosses an unrelated node.',
  }]);
  assert.equal(finalized.receipt.diagnostics[0].evidence.intersection[1], 40);
  assert.equal(JSON.parse(fs.readFileSync(finalized.summary.evidence.receipt)).status, 'fail');
});

test('compact finalize receipts preserve the acceptance boundary', () => {
  const compact = compactFinalizeReceipt({
    ok: true,
    status: 'pass',
    type: 'sequence',
    quality: 'showcase',
    specification: { path: '/tmp/spec.json', sha256: 'spec' },
    artifact: { path: '/tmp/artifact.html', sha256: 'artifact' },
    stages: Object.fromEntries(['validate', 'deliver', 'check', 'visual-check'].map((stage) => [stage, { status: 'pass' }])),
    diagnostics: [],
    evidence: { receipt: '/tmp/artifact.finalize.json', contactSheetImage: '/tmp/artifact.visual-check.contact.png' },
    durationMs: 4200,
  });
  assert.equal(compact.ok, true);
  assert.equal(compact.visualReview, 'pending');
  assert.equal(compact.gates['visual-check'], 'pass');
  assert.equal(compact.evidence.contactSheetImage.endsWith('.png'), true);
});

test('finalize refuses a receipt path that aliases a gate sidecar', t => {
  const directory = workspace(t);
  const input = path.join(directory, 'diagram.json');
  const output = path.join(directory, 'diagram.html');
  const visualReceipt = path.join(directory, 'diagram.visual-check.json');
  fs.writeFileSync(input, '{}');
  fs.writeFileSync(visualReceipt, 'preserve me');
  let invoked = false;

  assert.throws(() => runFinalize({
    cliPath: '/fake/archify.mjs',
    type: 'architecture',
    input,
    output,
    receiptPath: visualReceipt,
    runCommand: () => { invoked = true; return result({ ok: true }); },
  }), /gate sidecars/);
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(visualReceipt, 'utf8'), 'preserve me');
});
