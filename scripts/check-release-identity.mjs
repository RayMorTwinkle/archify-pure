#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootFlag = process.argv.indexOf('--root');
const repoRoot = rootFlag === -1 ? scriptRoot : path.resolve(process.argv[rootFlag + 1] || '');
const failures = [];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
  failures.push(message);
}

function read(relativePath) {
  try {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  } catch {
    fail(`${relativePath} is missing or unreadable.`);
    return '';
  }
}

function readJson(relativePath) {
  const source = read(relativePath);
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch {
    fail(`${relativePath} is not valid JSON.`);
    return {};
  }
}

function parseSemver(value) {
  if (typeof value !== 'string' || value.length > 128) {
    throw new Error(`invalid SemVer: ${JSON.stringify(value)}`);
  }
  const match = SEMVER.exec(value);
  if (!match) throw new Error(`invalid SemVer: ${JSON.stringify(value)}`);
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some((identifier) => /^\d+$/.test(identifier)
    && identifier.length > 1 && identifier.startsWith('0'))) {
    throw new Error(`invalid SemVer: ${JSON.stringify(value)}`);
  }
  return {
    core: match.slice(1, 4),
    prerelease,
    build: match[5]?.split('.') ?? null,
  };
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(left[index], right[index]);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericIdentifiers(left.core[index], right.core[index]);
    if (comparison !== 0) return comparison;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function isStableCoreVersion(value) {
  try {
    const parsed = parseSemver(value);
    return parsed.prerelease === null && parsed.build === null;
  } catch {
    return false;
  }
}

function checkSkillRelease(value, version, isDevelopment) {
  const expectedChannel = isDevelopment ? 'development' : 'stable';
  const valid = value?.schemaVersion === 1
    && value?.skillId === 'archify'
    && value?.channel === expectedChannel
    && value?.version === version;
  if (!valid) {
    fail(`archify/skill-release.json must identify archify ${version} as ${expectedChannel}.`);
  }
}

function checkReadme(relativePath, source, version, language, isDevelopment) {
  const markerLabel = language === 'zh'
    ? isDevelopment ? '当前开发版本：' : '当前稳定版本：'
    : isDevelopment ? 'Current development version:' : 'Current stable version:';
  const identity = isDevelopment ? 'development' : 'stable';
  const hasMarker = source.split('\n').some((line) => line.includes(markerLabel) && line.includes(`\`v${version}\``));
  if (!hasMarker) {
    fail(`${relativePath} must advertise ${identity} identity v${version} with an explicit ${identity} marker.`);
  }
}

function checkRoadmap(relativePath, source, version, isDevelopment) {
  const identity = isDevelopment ? 'development line' : 'stable version';
  const marker = `The current ${identity} is \`v${version}\``;
  if (!source.includes(marker)) {
    fail(`${relativePath} must declare the current ${identity} as v${version}.`);
  }
}

const packageJson = readJson('archify/package.json');
const changelog = read('CHANGELOG.md');
const unreleasedStart = changelog.search(/^## \[Unreleased\][^\n]*(?:\n|$)/m);
const afterUnreleased = unreleasedStart === -1
  ? ''
  : changelog.slice(unreleasedStart).replace(/^## \[Unreleased\][^\n]*(?:\n|$)/, '');
const nextRelease = afterUnreleased.search(/^## \[/m);
const unreleased = nextRelease === -1 ? afterUnreleased : afterUnreleased.slice(0, nextRelease);
const hasRealUnreleasedChanges = /^\s*-\s+\S/m.test(unreleased);
const version = packageJson.version;
let parsedVersion = null;
try {
  parsedVersion = parseSemver(version);
} catch {
  // The consolidated error below owns package-version policy reporting.
}
const supportedPrerelease = parsedVersion?.prerelease === null
  || (parsedVersion?.prerelease?.length === 2
    && parsedVersion.prerelease[0] === 'dev'
    && /^\d+$/.test(parsedVersion.prerelease[1]));
const hasSupportedVersion = Boolean(parsedVersion && parsedVersion.build === null && supportedPrerelease);
const isDevelopment = Boolean(hasSupportedVersion && parsedVersion.prerelease);
const publishedLabels = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)]
  .map((match) => match[1])
  .filter((label) => label !== 'Unreleased');
for (const label of publishedLabels) {
  if (!isStableCoreVersion(label)) fail(`CHANGELOG published version is not stable SemVer: ${label}.`);
}
const stableLabels = publishedLabels
  .filter(isStableCoreVersion)
  .sort((left, right) => compareSemver(right, left));
const newestStableLabel = stableLabels[0] ?? null;

if (!hasSupportedVersion) {
  fail(`package version is not a supported SemVer identity: ${JSON.stringify(version)}`);
} else if (hasRealUnreleasedChanges && !isDevelopment) {
  fail(`Unreleased changes require a prerelease package version; found stable ${version}.`);
}

if (hasSupportedVersion && hasRealUnreleasedChanges) {
  const currentCore = parsedVersion.core.join('.');
  if (newestStableLabel && compareSemver(currentCore, newestStableLabel) <= 0) {
    fail(`Unreleased package core ${currentCore} must be newer than published ${newestStableLabel}.`);
  }
}

if (hasSupportedVersion) {
  checkSkillRelease(readJson('archify/skill-release.json'), version, isDevelopment);

  const lock = readJson('archify/package-lock.json');
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    fail(`archify/package-lock.json must match ${version} at the root and packages[""].`);
  }

  const skill = read('archify/SKILL.md');
  const skillVersion = skill.match(/^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  const expectedSkillVersion = `${parsedVersion.core[0]}.${parsedVersion.core[1]}`;
  if (skillVersion !== expectedSkillVersion) {
    fail(`archify/SKILL.md metadata version ${skillVersion || '(missing)'} must map to package ${version} as ${expectedSkillVersion}.`);
  }

  const rendererTemplate = read('archify/assets/template.html');
  const generatorVersions = [...rendererTemplate.matchAll(/<meta\s+name="generator"\s+content="archify\s+([^"]+)"\s*\/?>/g)]
    .map((match) => match[1]);
  if (generatorVersions.length !== 1 || generatorVersions[0] !== version) {
    fail(`archify/assets/template.html generator must be archify ${version}; found ${generatorVersions.join(', ') || '(missing)'}.`);
  }

  const english = read('README.md');
  const englishMirror = read('README_EN.md');
  const chinese = read('README_ZH.md');
  checkReadme('README.md', english, version, 'en', isDevelopment);
  checkReadme('README_EN.md', englishMirror, version, 'en', isDevelopment);
  checkReadme('README_ZH.md', chinese, version, 'zh', isDevelopment);
  if (english !== englishMirror) fail('README_EN.md must remain byte-identical to README.md.');

  if (newestStableLabel && isDevelopment) {
    const stableMinor = newestStableLabel.split('.').slice(0, 2).join('\\.');
    if (new RegExp(`Archify ${stableMinor} includes\\b`).test(english)
      || new RegExp(`Archify ${stableMinor} 已覆盖`).test(chinese)) {
      fail(`README capability summary must describe v${version} as development, not published ${newestStableLabel}.`);
    }
  }

  checkRoadmap('ROADMAP.md', read('ROADMAP.md'), version, isDevelopment);

  const changelogMarker = `Development identity: \`v${version}\``;
  if (hasRealUnreleasedChanges && !unreleased.includes(changelogMarker)) {
    fail(`CHANGELOG.md Unreleased must declare ${changelogMarker}.`);
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`release identity: ${message}`);
  process.exit(1);
}

console.log(`release identity ok: ${version}`);
