import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { walkFiles } from '../harness/structural.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(ROOT, 'bin');
const SRC_DIR = path.join(ROOT, 'src');

const EXEMPT = Object.freeze(['src/capture/run.js', 'src/io/cfgedit.js', 'src/io/store.js']);

const WRITE_NAME =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|copyFile|copyFileSync|truncate|truncateSync|ftruncate|ftruncateSync|chmod|chmodSync|fchmod|fchmodSync|chown|chownSync|symlink|symlinkSync|link|linkSync|utimes|utimesSync|futimes|futimesSync|createWriteStream)\b/;
const OPEN_CALL = /\bopen(?:Sync)?\s*\(/;
const WRITE_FLAG_TOKEN = /['"`][rsx]*[wa+][rwaxs+]*['"`]/;

function toRepoRelative(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function offendingLines(relPath, source) {
  const offenses = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const hasWriteName = WRITE_NAME.test(line);
    const hasOpenWithWriteFlag = OPEN_CALL.test(line) && WRITE_FLAG_TOKEN.test(line);
    if (hasWriteName || hasOpenWithWriteFlag) {
      offenses.push(`${relPath}:${index + 1}: ${line.trim()}`);
    }
  });
  return offenses;
}

function scopeFiles() {
  const files = new Set();
  for (const file of [...walkFiles(BIN_DIR), ...walkFiles(SRC_DIR)]) files.add(file);
  return [...files];
}

test('EXEMPT is pinned to exactly the three allowed writer files', () => {
  assert.deepEqual(EXEMPT, ['src/capture/run.js', 'src/io/cfgedit.js', 'src/io/store.js']);
});

test('no fs write call outside bin/, src/io/store.js, or src/capture/run.js', () => {
  assert.ok(existsSync(BIN_DIR), 'bin/ is missing');
  assert.ok(existsSync(SRC_DIR), 'src/ is missing');

  const scanned = scopeFiles();
  const scannedRel = scanned.map(toRepoRelative);
  assert.ok(scannedRel.includes('bin/ast'), 'sweep did not visit bin/ast');
  assert.ok(scannedRel.includes('src/io/procexec.js'), 'sweep did not visit src/io/procexec.js');

  const exemptAndExisting = new Set(EXEMPT.filter((relPath) => existsSync(path.join(ROOT, relPath))));
  assert.ok(exemptAndExisting.has('src/io/store.js'), 'src/io/store.js should exist and be exempt');
  assert.ok(exemptAndExisting.has('src/capture/run.js'), 'src/capture/run.js should exist and be exempt');
  assert.ok(EXEMPT.includes('src/io/cfgedit.js'), 'src/io/cfgedit.js must remain in EXEMPT even if absent today');

  const offenses = [];
  for (const absPath of scanned) {
    const relPath = toRepoRelative(absPath);
    if (EXEMPT.includes(relPath)) continue;
    offenses.push(...offendingLines(relPath, readFileSync(absPath, 'utf8')));
  }

  assert.deepEqual(offenses, []);
});

test('control: a synthetic offender is flagged; the same source under src/io/store.js is exempt', () => {
  const offenderSource = "import { writeFile } from 'node:fs/promises';\n";

  const offense = offendingLines('src/cli/verbs/evil.js', offenderSource);
  assert.ok(offense.length > 0, 'a writeFile import outside the exemption was not flagged');

  const exempted = EXEMPT.includes('src/io/store.js') ? [] : offendingLines('src/io/store.js', offenderSource);
  assert.deepEqual(exempted, [], 'src/io/store.js must be exempt regardless of its own content');
});

test('control: a read-only line and a read-mode open pass; open with a write flag and a sync writer are flagged', () => {
  assert.deepEqual(offendingLines('src/core/thing.js', 'const data = await readFile(p);\n'), []);
  assert.deepEqual(offendingLines('src/core/thing.js', "await open(p, 'r')\n"), []);

  assert.ok(offendingLines('src/core/thing.js', "openSync(p, 'wx')\n").length > 0);
  assert.ok(offendingLines('src/core/thing.js', 'fs.writeFileSync(p, s)\n').length > 0);
});
