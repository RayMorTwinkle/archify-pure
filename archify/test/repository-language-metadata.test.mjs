import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function linguistGenerated(relativePath) {
  const output = execFileSync(
    'git',
    ['check-attr', 'linguist-generated', '--', relativePath],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  return output.slice(output.lastIndexOf(':') + 1).trim();
}

test('repository language metadata separates generated artifacts from implementation source', () => {
  for (const generatedPath of [
    'archify/assets/template.html',
    'archify/examples/web-app-rendered.html',
    'examples/web-app.html',
    'examples/maka-architecture.html',
    'docs/cases/mco-runtime.architecture.html',
    'docs/gallery/artifacts/web-app.architecture.html',
    'docs/gallery/artifacts/agent-tool-call.workflow.html',
    'experiments/mco-showcase/mco-runtime.html',
    'archify/renderers/shared/generated-brand-marks.mjs',
    'archify/renderers/shared/generated-validators.mjs',
  ]) {
    assert.equal(
      linguistGenerated(generatedPath),
      'true',
      `${generatedPath} must be excluded from GitHub language statistics`,
    );
  }

  for (const sourcePath of [
    'viewer/template.source.html',
    'viewer/reader-layout.js',
    'viewer/viewer-chrome-layout.js',
    'viewer/viewer-camera.js',
    'viewer/semantic-radar.js',
    'viewer/motion-governor.js',
    'viewer/node-finder.js',
    'viewer/intent-trace.js',
    'viewer/semantic-lens.js',
    'viewer/route-probe.js',
    'viewer/guided-views.js',
    'viewer/focus.js',
    'viewer/export.js',
    'viewer/export-cleanup.js',
    'scripts/generate-viewer.mjs',
    'scripts/build-gallery.mjs',
    'scripts/write-deterministic-zip.mjs',
    'scripts/stage-clean-skill.mjs',
    'docs/gallery/manifest.json',
    'archify/renderers/shared/geometry.mjs',
  ]) {
    assert.equal(
      linguistGenerated(sourcePath),
      'unspecified',
      `${sourcePath} must remain visible as implementation source`,
    );
  }
});
