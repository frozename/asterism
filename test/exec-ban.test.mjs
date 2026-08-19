import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { filesWithExtensions } from '../harness/structural.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const TEST_DIR = path.join(ROOT, 'test');
const SCOPE_DIRS = [path.join(ROOT, 'bin'), SRC_DIR, path.join(ROOT, 'harness'), TEST_DIR];
const THIS_FILE_REL = 'test/exec-ban.test.mjs';

const WHOLE_WORD_BANNED = /\b(execSync|execFileSync|spawnSync)\b/;
const EXEC_IMPORT_PATTERNS = [
  /\{\s*exec\s*\}/, // bare `{ exec }` destructure or named import
  /\{\s*exec\s*,/, // `{ exec, ...`
  /,\s*exec\s*\}/, // `..., exec }`
  /\bexec\s*:/, // `exec: renamed`
  /promisify\(\s*exec\s*\)/,
  /child_process\.exec\(/,
  /\bcp\.exec\(/,
];
const SHELL_TRUE = /\bshell\s*:\s*true\b/;

function execBanOffense(line) {
  if (WHOLE_WORD_BANNED.test(line)) return true;
  if (EXEC_IMPORT_PATTERNS.some((pattern) => pattern.test(line))) return true;
  if (SHELL_TRUE.test(line)) return true;
  return false;
}

function toRepoRelative(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function scopeFiles() {
  const files = new Set();
  for (const dir of SCOPE_DIRS) {
    for (const file of filesWithExtensions(dir, ['.js', '.mjs'])) files.add(file);
  }
  const astPath = path.join(ROOT, 'bin', 'ast');
  if (existsSync(astPath)) files.add(astPath);
  return [...files];
}

test('no banned exec/shell-true patterns outside the declared exemptions', () => {
  assert.ok(existsSync(SRC_DIR), 'src/ is missing; exec-ban sweep cannot be checked');
  assert.ok(existsSync(TEST_DIR), 'test/ is missing; exec-ban sweep cannot be checked');

  const offenses = [];
  const exemptedPaths = new Set();

  for (const absPath of scopeFiles()) {
    const relPath = toRepoRelative(absPath);

    if (relPath === THIS_FILE_REL) {
      exemptedPaths.add(relPath);
      continue;
    }

    const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes('exec-ban-exempt')) return;
      if (execBanOffense(line)) offenses.push(`${relPath}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(offenses, [], `exec-ban offenses:\n${offenses.join('\n')}`);
  assert.deepEqual([...exemptedPaths], [THIS_FILE_REL], 'expected exactly one exempted path: this test file');
});

test('control: banned patterns are flagged; execFile and a standalone shell var are not', () => {
  assert.equal(execBanOffense("const { exec } = require('node:child_process');"), true);
  assert.equal(execBanOffense("execSync('ls');"), true);
  assert.equal(execBanOffense("spawn('x', [], { shell: true });"), true);
  assert.equal(execBanOffense('const run = promisify(exec);'), true);
  assert.equal(execBanOffense("child_process.exec('ls');"), true);
  assert.equal(execBanOffense("cp.exec('ls');"), true);

  assert.equal(execBanOffense("execFile('x', ['a']);"), false);
  assert.equal(execBanOffense('const shell = true;'), false);
  assert.equal(execBanOffense("spawn('x', ['a']);"), false);
});
