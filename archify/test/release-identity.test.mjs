import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const checker = path.join(repoRoot, 'scripts', 'check-release-identity.mjs');

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function runCheck(root) {
  return spawnSync(process.execPath, [checker, '--root', root], {
    encoding: 'utf8',
  });
}

function writeValidDevelopmentFixture(root, overrides = {}) {
  const version = '2.13.0-dev.0';
  const english = [
    '![Version](https://example.invalid/badge.svg)',
    '',
    `Current development version: \`v${version}\``,
  ].join('\n');
  const chinese = [
    '![版本](https://example.invalid/badge.svg)',
    '',
    `当前开发版本：\`v${version}\``,
  ].join('\n');
  const files = {
    'archify/package.json': JSON.stringify({ version }),
    'archify/package-lock.json': JSON.stringify({ version, packages: { '': { version } } }),
    'archify/skill-release.json': JSON.stringify({
      schemaVersion: 1,
      skillId: 'archify',
      channel: 'development',
      version,
    }),
    'archify/SKILL.md': '---\nmetadata:\n  version: "2.13"\n---\n',
    'archify/assets/template.html': '<meta name="generator" content="archify 2.13.0-dev.0">',
    'CHANGELOG.md': [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      `> Development identity: \`v${version}\`. Not a stable release.`,
      '',
      '### Added',
      '- Real unreleased work.',
      '',
      '## [2.12.0] — 2026-07-23',
      '',
    ].join('\n'),
    'README.md': english,
    'README_EN.md': english,
    'README_ZH.md': chinese,
    'ROADMAP.md': `The current development line is \`v${version}\`; it contains the work under Changelog Unreleased and is not a stable release.`,
  };
  for (const [relativePath, content] of Object.entries({ ...files, ...overrides })) {
    writeFile(root, relativePath, content);
  }
}

function writeValidStableFixture(root, overrides = {}) {
  const version = '2.13.0';
  const english = [
    `Current stable version: \`v${version}\``,
  ].join('\n');
  const chinese = [
    `当前稳定版本：\`v${version}\``,
  ].join('\n');
  const files = {
    'archify/package.json': JSON.stringify({ version }),
    'archify/package-lock.json': JSON.stringify({ version, packages: { '': { version } } }),
    'archify/skill-release.json': JSON.stringify({
      schemaVersion: 1,
      skillId: 'archify',
      channel: 'stable',
      version,
    }),
    'archify/SKILL.md': '---\nmetadata:\n  version: "2.13"\n---\n',
    'archify/assets/template.html': '<meta name="generator" content="archify 2.13.0">',
    'CHANGELOG.md': [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [2.13.0] — 2026-07-29',
      '- Published work.',
      '',
    ].join('\n'),
    'README.md': english,
    'README_EN.md': english,
    'README_ZH.md': chinese,
    'ROADMAP.md': `The current stable version is \`v${version}\`.`,
  };
  for (const [relativePath, content] of Object.entries({ ...files, ...overrides })) {
    writeFile(root, relativePath, content);
  }
}

test('an empty Unreleased section accepts a coherent stable release identity', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
  try {
    writeValidStableFixture(fixture);

    const result = runCheck(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release identity ok: 2\.13\.0/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('the embedded release identity must match the package release exactly', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
  try {
    writeValidDevelopmentFixture(fixture, {
      'archify/skill-release.json': JSON.stringify({
        schemaVersion: 1,
        skillId: 'archify',
        channel: 'stable',
        version: '2.12.0',
      }),
    });

    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archify\/skill-release\.json must identify archify 2\.13\.0-dev\.0 as development/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('package identities reject leading-zero core and prerelease identifiers', () => {
  for (const version of ['02.13.0', '2.13.0-dev.01']) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
    try {
      writeValidDevelopmentFixture(fixture, {
        'archify/package.json': JSON.stringify({ version }),
      });
      const result = runCheck(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not a supported SemVer identity/, version);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test('the newest stable release is selected by SemVer rather than changelog order', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
  try {
    writeValidDevelopmentFixture(fixture, {
      'CHANGELOG.md': [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '> Development identity: `v2.13.0-dev.0`. Not a stable release.',
        '',
        '### Added',
        '- Real unreleased work.',
        '',
        '## [2.11.0] — 2026-07-16',
        '',
        '## [2.12.0] — 2026-07-23',
        '',
      ].join('\n'),
    });

    const result = runCheck(fixture);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('real Unreleased changes cannot reuse a stable published package identity', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
  try {
    writeFile(fixture, 'archify/package.json', JSON.stringify({ version: '2.12.0' }));
    writeFile(fixture, 'CHANGELOG.md', [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '- Real unreleased work.',
      '',
      '## [2.12.0] — 2026-07-23',
      '',
    ].join('\n'));

    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unreleased changes require a prerelease package version/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('package, lockfile, Skill metadata, README marker, and roadmap share one development identity', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
  try {
    writeFile(fixture, 'archify/package.json', JSON.stringify({ version: '2.13.0-dev.0' }));
    writeFile(fixture, 'archify/package-lock.json', JSON.stringify({
      version: '2.12.0',
      packages: { '': { version: '2.12.0' } },
    }));
    writeFile(fixture, 'archify/SKILL.md', '---\nmetadata:\n  version: "2.12"\n---\n');
    writeFile(fixture, 'CHANGELOG.md', [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '- Real unreleased work.',
      '',
      '## [2.12.0] — 2026-07-23',
      '',
    ].join('\n'));
    const staleEnglish = [
      'Archify 2.12 includes unreleased capabilities.',
    ].join('\n');
    writeFile(fixture, 'README.md', staleEnglish);
    writeFile(fixture, 'README_EN.md', staleEnglish);
    writeFile(fixture, 'README_ZH.md', 'Archify 2.12 包含未发布能力。\n');

    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package-lock\.json must match 2\.13\.0-dev\.0/);
    assert.match(result.stderr, /SKILL\.md metadata version 2\.12 must map to package 2\.13\.0-dev\.0/);
    assert.match(result.stderr, /README\.md must advertise development identity v2\.13\.0-dev\.0/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('the English README mirror cannot drift from README.md', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
  try {
    writeValidDevelopmentFixture(fixture, {
      'README_EN.md': 'Current development version: `v2.99.0-dev.0`\n',
    });

    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /README_EN\.md must remain byte-identical to README\.md/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('the renderer template generator carries the complete package prerelease identity', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
  try {
    writeValidDevelopmentFixture(fixture, {
      'archify/assets/template.html': '<meta name="generator" content="archify 2.12.0">',
    });

    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archify\/assets\/template\.html generator must be archify 2\.13\.0-dev\.0/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('roadmap current identity follows the package release state', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
  try {
    writeValidDevelopmentFixture(fixture, {
      'ROADMAP.md': 'The current development line is `v2.12.0`; it is not a stable release.',
    });

    const result = runCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROADMAP\.md must declare the current development line as v2\.13\.0-dev\.0/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('a development build cannot describe the newest stable minor as shipped', () => {
  for (const offending of [
    'Archify 2.12 includes the new reader layout.',
    'Archify 2.12 已覆盖新的 reader layout。',
  ]) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-release-identity-'));
    try {
      writeValidDevelopmentFixture(fixture, {
        'README.md': `Current development version: \`v2.13.0-dev.0\`\n\n${offending}\n`,
        'README_EN.md': `Current development version: \`v2.13.0-dev.0\`\n\n${offending}\n`,
        'README_ZH.md': `当前开发版本：\`v2.13.0-dev.0\`\n\n${offending}\n`,
      });

      const result = runCheck(fixture);
      assert.notEqual(result.status, 0, offending);
      assert.match(result.stderr, /README capability summary must describe v2\.13\.0-dev\.0 as development, not published 2\.12\.0/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test('the release gate never reaches for a remote update manifest', () => {
  const source = fs.readFileSync(checker, 'utf8');
  assert.doesNotMatch(source, /updateManifestUrl|stable\.json|update-contract|fetch\(/);
  assert.doesNotMatch(source, /https?:\/\/[^\s'"]+/);
});
