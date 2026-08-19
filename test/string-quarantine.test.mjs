import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { walkFiles } from '../harness/structural.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const TEST_DIR = path.join(ROOT, 'test');
const SCOPE_DIRS = [
  path.join(ROOT, 'bin'),
  SRC_DIR,
  path.join(ROOT, 'harness'),
  TEST_DIR,
  path.join(ROOT, '.github', 'workflows'),
];
const THIS_FILE_REL = 'test/string-quarantine.test.mjs';

// This is the one file allowed to spell the pattern out plainly; every other
// hit in the sweep must live under an adapter dir, a fixtures/vectors dir, or
// carry its own `quarantine-exempt` marker.
const VENDOR_LITERAL = /claude|codex|gemini|copilot|opencode|CLAUDE_|dangerously/i;

function isOutOfScope(relPath) {
  if (/^src\/adapters\/[^/]+\//.test(relPath)) return true;
  if (relPath === 'src/adapters/index.js') return true;
  if (/(^|\/)fixtures\//.test(relPath)) return true;
  if (/(^|\/)vectors\//.test(relPath)) return true;
  return false;
}

function toRepoRelative(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function scopeFiles() {
  const files = new Set();
  for (const dir of SCOPE_DIRS) {
    for (const file of walkFiles(dir)) files.add(file);
  }
  return [...files];
}

test('no vendor literal outside the adapter/fixture quarantine or a marked line', () => {
  assert.ok(existsSync(SRC_DIR), 'src/ is missing; string-quarantine sweep cannot be checked');
  assert.ok(existsSync(TEST_DIR), 'test/ is missing; string-quarantine sweep cannot be checked');

  const offenses = [];
  const exemptedPaths = new Set();

  for (const absPath of scopeFiles()) {
    const relPath = toRepoRelative(absPath);
    if (isOutOfScope(relPath)) continue;

    if (relPath === THIS_FILE_REL) {
      exemptedPaths.add(relPath);
      continue;
    }

    const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes('quarantine-exempt')) return;
      if (VENDOR_LITERAL.test(line)) offenses.push(`${relPath}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(offenses, [], `vendor-literal offenses:\n${offenses.join('\n')}`);
  assert.deepEqual([...exemptedPaths], [THIS_FILE_REL], 'expected exactly one exempted path: this test file');
});

test('bin/ast contains no vendor literal even though the sweep already covers it', () => {
  const astPath = path.join(ROOT, 'bin', 'ast');
  assert.ok(existsSync(astPath), 'bin/ast is missing');

  const source = readFileSync(astPath, 'utf8');
  assert.equal(VENDOR_LITERAL.test(source), false, 'bin/ast must stay vendor-neutral');
});

test('control: a vendor literal is flagged, a marked line is exempt, an adapter path is out of scope', () => {
  assert.equal(VENDOR_LITERAL.test('const id = "codex";'), true);

  const markedLine = 'const id = "codex"; // quarantine-exempt';
  assert.equal(VENDOR_LITERAL.test(markedLine), true, 'the pattern itself should still match the marked line');
  assert.ok(markedLine.includes('quarantine-exempt'), 'the marker must be present so the sweep skips this line');

  const cleanLine = 'const id = "local";';
  assert.equal(VENDOR_LITERAL.test(cleanLine), false);

  assert.equal(isOutOfScope('src/adapters/anything/x.js'), true);
  assert.equal(isOutOfScope('src/adapters/index.js'), true);
  assert.equal(isOutOfScope('test/fixtures/x.sha256'), true);
  assert.equal(isOutOfScope('src/core/x.js'), false);
});
