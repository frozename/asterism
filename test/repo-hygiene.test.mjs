import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import {
  digestOf,
  listFiles,
  listUnpushedCommits,
  loadDigests,
  normalize,
  parseLogOutput,
  parseFixture,
  scanText,
} from '../harness/secret-scan.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('fixture loads and is non-empty', () => {
  const result = loadDigests({ root: ROOT });

  assert.ok(result.committedCount >= 1);
  assert.ok(result.digests instanceof Set);
});

test('fixture fails closed', () => {
  assert.throws(() => parseFixture('', { source: 'empty.fixture' }), /empty\.fixture/);
  assert.throws(() => parseFixture('not-a-digest\n', { source: 'garbage.fixture' }), /garbage\.fixture/);
  assert.throws(() => parseFixture(`${'a'.repeat(63)}\n`, { source: 'short.fixture' }), /short\.fixture/);

  assert.throws(
    () => loadDigests({ root: path.join(ROOT, 'missing-fixture-root') }),
    /secret-digests\.sha256/,
  );
});

test('round-trip control', () => {
  const syntheticValue = 'Synthetic Control Value';
  const digest = digestOf(syntheticValue);

  const findings = scanText('prefix SYNTHETIC control\nvalue suffix\n', new Set([digest]));

  assert.deepEqual(findings, [{ line: 1, digest }]);
});

test('punctuation-wrapped values are still caught', () => {
  const syntheticValue = 'synthetic-secret_value/123=+@~$%&';
  const digest = digestOf(syntheticValue);
  const renderings = [
    syntheticValue,
    `\`${syntheticValue}\``,
    `${syntheticValue}.`,
    `${syntheticValue},`,
    `"${syntheticValue}"`,
    `(${syntheticValue})`,
    `**${syntheticValue}**`,
    `${syntheticValue}\n`,
  ];

  for (const rendering of renderings) {
    assert.deepEqual(scanText(`prefix ${rendering} suffix`, new Set([digest])), [{ line: 1, digest }], rendering);
  }

  assert.equal(normalize(normalize(` **${syntheticValue}.** `)), normalize(` **${syntheticValue}.** `));
});

test('findings never carry the matched text', () => {
  const syntheticValue = 'private control token';
  const digest = digestOf(syntheticValue);

  const [finding] = scanText(`before ${syntheticValue} after`, new Set([digest]));

  assert.deepEqual(Object.keys(finding).sort(), ['digest', 'line']);
  assert.equal(finding.line, 1);
  assert.match(finding.digest, HEX64);
  for (const value of Object.values(finding)) {
    assert.ok(!String(value).includes('private'));
    assert.ok(!String(value).includes('control token'));
  }
});

test('scan over tracked and untracked files', async () => {
  const { digests, committedCount, overlayCount } = loadDigests({ root: ROOT });
  const files = await listFiles(ROOT);
  let iterated = 0;
  const findings = [];

  for (const file of files) {
    const absolutePath = path.join(ROOT, file);
    const statText = existsSync(absolutePath) ? await readUtf8TextUnderLimit(absolutePath) : null;
    if (statText === null) continue;

    iterated += 1;
    for (const finding of scanText(statText, digests)) {
      findings.push(`${file}:${finding.line} ${finding.digest}`);
    }
  }

  assert.ok(iterated > 0, 'iterated 0 files');
  const counts = `files iterated count ${iterated}; committedCount ${committedCount}; overlayCount ${overlayCount}`;
  assert.deepEqual(findings, [], `${counts}; findings:\n${findings.join('\n')}`);

  const canaryValue = 'file enumeration canary';
  const canaryDigest = digestOf(canaryValue);
  const controlDigests = new Set(digests);
  controlDigests.add(canaryDigest);
  assert.deepEqual(scanText(`clean synthetic text\n${canaryValue}\n`, controlDigests), [
    { line: 2, digest: canaryDigest },
  ]);
});

test('scan over unpushed commit messages', async () => {
  const { digests } = loadDigests({ root: ROOT });
  const commits = await listUnpushedCommits(ROOT);
  const findings = [];

  for (const commit of commits) {
    for (const finding of scanText(commit.message, digests)) {
      findings.push(`${commit.sha}:${finding.line} ${finding.digest}`);
    }
  }

  assert.deepEqual(findings, [], `commits ${commits.length}; findings:\n${findings.join('\n')}`);
});

test('log output records are trimmed before sha splitting', () => {
  assert.deepEqual(parseLogOutput('\nabc123\0subject line\0\x1e'), [{ sha: 'abc123', message: 'subject line' }]);
});

test('overlay reporting', () => {
  const result = loadDigests({ root: ROOT, overlayPath: path.join(ROOT, 'private', 'missing-secret-digests.sha256') });

  assert.equal(result.overlayPath, path.join(ROOT, 'private', 'missing-secret-digests.sha256'));
  assert.equal(result.overlayCount, 0);
});

async function readUtf8TextUnderLimit(file) {
  const bytes = await readFile(file);
  if (bytes.byteLength > 2 * 1024 * 1024) return null;

  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0) return null;

  return text;
}
