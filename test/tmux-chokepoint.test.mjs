import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { walkFiles } from '../harness/structural.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const BIN_DIR = path.join(ROOT, 'bin');

const ARGV_TMUX_LITERAL = /\[\s*['"]tmux['"]\s*,/;
const ALLOWED_ARGV_FILES = Object.freeze(['src/io/tmuxexec.js', 'src/capture/tmux.js']);

const LITERAL_PATTERN = /send-keys|respawn-pane|capture-pane/;
const LITERAL_EXEMPT_DIR = /^src\/adapters\/[^/]+\//;
const LITERAL_EXEMPT_FILE = 'src/capture/tmux.js';
const LITERAL_EXEMPT_COUNT = 4;

function toRepoRelative(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function readFilesAsRepoRelative(root) {
  return walkFiles(root).map((absPath) => ({
    path: toRepoRelative(absPath),
    source: readFileSync(absPath, 'utf8'),
  }));
}

function scopeFiles() {
  return [...readFilesAsRepoRelative(SRC_DIR), ...readFilesAsRepoRelative(BIN_DIR)];
}

function matchingLineCount(source, pattern) {
  return source.split(/\r?\n/).filter((line) => pattern.test(line)).length;
}

// (a) an array literal opening with the tmux binary name may only appear in
// the two declared chokepoint files -- anything else building a tmux argv
// bypasses execTmux's -u-always and target-validation guards.
function argvViolation(file) {
  if (ALLOWED_ARGV_FILES.includes(file.path)) return null;
  return matchingLineCount(file.source, ARGV_TMUX_LITERAL) > 0
    ? `${file.path}: builds a ['tmux', ...] argv literal outside the declared chokepoints`
    : null;
}

test('(a) a ["tmux", ...] array literal appears only in the two declared chokepoint files', () => {
  assert.ok(existsSync(SRC_DIR), 'src/ is missing');
  assert.ok(existsSync(BIN_DIR), 'bin/ is missing');

  const violations = scopeFiles().map(argvViolation).filter(Boolean);
  assert.deepEqual(violations, []);
  assert.deepEqual([...ALLOWED_ARGV_FILES], ['src/io/tmuxexec.js', 'src/capture/tmux.js']);
});

test('(a) control: a synthetic offender is caught; the real "segment === tmux" and "source: \'tmux\'" near-misses pass', () => {
  const offender = argvViolation({ path: 'src/cli/verbs/go.js', source: "procexec(['tmux', '-V']);\n" });
  assert.ok(offender, 'a synthetic argv-literal offender was not flagged');
  const fieldList = argvViolation({ path: 'src/core/reconcile.js', source: "paneWitness: Object.freeze(['tmux']),\n" });
  assert.equal(fieldList, null, "a single-element field-name list ['tmux'] must not read as an argv");

  const nearMiss1 = argvViolation({ path: 'src/capture/run.js', source: "if (segment === 'tmux') {\n" });
  assert.equal(nearMiss1, null);

  const nearMiss2 = argvViolation({ path: 'src/adapters/fake/index.js', source: "source: 'tmux',\n" });
  assert.equal(nearMiss2, null);

  const allowed = argvViolation({ path: 'src/io/tmuxexec.js', source: "execute(['tmux', '-u', '-S', socketPath]);\n" });
  assert.equal(allowed, null, 'an allowed chokepoint file must never be flagged, no matter how many argv literals it builds');
});

// (b) send-keys/respawn-pane/capture-pane are Phase 1 non-goals everywhere
// except adapter provoke/evidence prose (caller data, not a tmux call site)
// and the one counted, pre-existing exemption in src/capture/tmux.js.
test('(b) send-keys/respawn-pane/capture-pane are absent outside adapter prose, except the one counted exemption', () => {
  assert.ok(existsSync(SRC_DIR), 'src/ is missing');
  assert.ok(existsSync(BIN_DIR), 'bin/ is missing');

  const offenders = [];
  let exemptCount = null;

  for (const file of scopeFiles()) {
    if (LITERAL_EXEMPT_DIR.test(file.path)) continue;

    const count = matchingLineCount(file.source, LITERAL_PATTERN);
    if (file.path === LITERAL_EXEMPT_FILE) {
      exemptCount = count;
      continue;
    }
    if (count > 0) offenders.push(file.path);
  }

  assert.deepEqual(offenders, []);
  assert.equal(
    exemptCount,
    LITERAL_EXEMPT_COUNT,
    `${LITERAL_EXEMPT_FILE} should carry exactly ${LITERAL_EXEMPT_COUNT} matching line(s); a fifth forces the recorded migration follow-up`,
  );
});

test('(b) control: a must-hit offender under src/io/ is caught; adapter-scoped prose is out of scope; a clean file passes', () => {
  const offenderCount = matchingLineCount("exec(['send-keys', target]);\n", LITERAL_PATTERN);
  assert.ok(offenderCount > 0, 'a synthetic src/io/paneio.js offender was not flagged');

  assert.equal(LITERAL_EXEMPT_DIR.test('src/adapters/x/captures.js'), true, 'adapter prose must be recognized as out of scope');

  const outOfScopeCount = matchingLineCount("'run tmux capture-pane -p'\n", LITERAL_PATTERN);
  assert.ok(outOfScopeCount > 0, 'the pattern itself must still match inside adapter prose -- the directory check is what exempts it, not the regex');

  const cleanCount = matchingLineCount("export function noop() {}\n", LITERAL_PATTERN);
  assert.equal(cleanCount, 0);
});
