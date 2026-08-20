import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertFormatSafe,
  attachSessionArgv,
  attachSessionForeground,
  execTmux,
  listPanes,
  setUserOption,
  switchClient,
  TARGET_ID,
} from '../src/io/tmuxexec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIM_DIR = path.join(ROOT, 'harness', 'fake-tmux');

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// The genuine end-to-end L2 harness: a real subprocess spawn through the
// fake-tmux PATH shim, argv observed via its JSONL log. Reserved for the
// cases that specifically need to prove real PATH resolution and real
// subprocess argv logging -- every other case below drives execTmux's own
// injected `execute` with an in-memory recorder, which is just as faithful
// to the argv-construction contract and orders of magnitude cheaper, which
// matters here because this file is spawned wholesale, once per mutation,
// by the curated mutant runner.
function newShimHarness() {
  const logPath = path.join(tmpDir('tmuxexec-log-'), 'log.jsonl');
  const fixturesDir = tmpDir('tmuxexec-fixtures-');
  const env = {
    PATH: `${SHIM_DIR}:${process.env.PATH ?? ''}`,
    HOME: tmpDir('tmuxexec-home-'),
    TERM: 'dumb',
    ASTERISM_FAKE_TMUX_LOG: logPath,
    ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir,
  };
  return { env, logPath, fixturesDir, socketPath: path.join(tmpDir('tmuxexec-sock-'), 'asterism-test-x') };
}

function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function writeFixture(fixturesDir, key, contents, rc) {
  writeFileSync(path.join(fixturesDir, `${key}.out`), contents);
  if (typeof rc === 'number') writeFileSync(path.join(fixturesDir, `${key}.rc`), String(rc));
}

// An in-memory stand-in for procexec: records every argv it's called with
// and returns a canned result, with no subprocess spawned at all.
function fakeExecute(calls, response = { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) {
  return async (argv) => {
    calls.push(argv);
    return response;
  };
}

function fakeEnv() {
  return { PATH: 'unused', HOME: 'unused' };
}

test('listPanes: a real shim spawn logs -u/-S/socket and parses canned 7-field rows; a 6-field row rejects the whole listing (control, via a fake execute)', async () => {
  const h = newShimHarness();
  writeFixture(h.fixturesDir, 'list-panes', ['%0|100|$0|@0|0||', '%1|101|$0|@0|0||'].join('\n') + '\n');

  const result = await listPanes({ socketPath: h.socketPath, env: h.env, paneCount: 2 });
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  assert.equal(result.rows.length, 2);
  assert.equal(Object.isFrozen(result.rows[0]), true);

  const log = readLog(h.logPath);
  assert.equal(log.length, 1);
  assert.equal(log[0].argv[0], '-u');
  assert.ok(log[0].argv.includes('-S'));
  assert.ok(log[0].argv.includes(h.socketPath));

  const calls = [];
  const rejected = await listPanes({
    socketPath: 'irrelevant',
    env: fakeEnv(),
    execute: fakeExecute(calls, { code: 0, stdout: Buffer.from('%0|100|$0|@0|0|\n'), stderr: Buffer.alloc(0) }), // 6 fields, one short of 7
  });
  assert.equal(rejected.ok, false);
  assert.equal(calls.length, 1);
});

test('target validation: "main", "sess:1.2", "%12extra" are rejected before any spawn; "%12"/"$0"/"@3" pass TARGET_ID and a real call spawns', async () => {
  const calls = [];
  const opts = { socketPath: 'irrelevant', env: fakeEnv(), execute: fakeExecute(calls) };

  for (const badTarget of ['main', 'sess:1.2', '%12extra']) {
    assert.throws(() => attachSessionArgv(badTarget, { socketPath: 'irrelevant' }));
    await assert.rejects(() => switchClient({ target: badTarget, ...opts }));
    await assert.rejects(() => setUserOption('@x', 'v', { target: badTarget, ...opts }));
  }
  assert.equal(calls.length, 0, 'a rejected target must never reach a spawn');

  for (const goodTarget of ['%12', '$0', '@3']) {
    assert.equal(TARGET_ID.test(goodTarget), true);
    assert.doesNotThrow(() => attachSessionArgv(goodTarget, { socketPath: 'irrelevant' }));
  }

  const result = await switchClient({ target: '%12', ...opts });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'tmux');
  assert.equal(calls[0][1], '-u');
  assert.ok(calls[0].includes('%12'));
});

test('assertFormatSafe: each unsafe byte embedded in a setUserOption value is rejected before any spawn; a ULID-shaped value passes and spawns', async () => {
  const calls = [];
  const opts = { target: '%1', socketPath: 'irrelevant', env: fakeEnv(), execute: fakeExecute(calls) };

  const unsafeBytes = ['#', ';', '$', '\n', '\r', '\x00', '\x1f'];
  for (const ch of unsafeBytes) {
    assert.throws(() => assertFormatSafe(`a${ch}b`));
    await assert.rejects(() => setUserOption('@x', `a${ch}b`, opts));
  }
  assert.equal(calls.length, 0);

  const safeValue = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  assert.doesNotThrow(() => assertFormatSafe(safeValue));
  const result = await setUserOption('@x', safeValue, opts);
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'tmux');
  assert.equal(calls[0][1], '-u');
});

test('ASTERISM_TEST=1 refuses a non-prefixed socket basename before any spawn; a prefixed basename spawns; ASTERISM_TEST unset allows a non-prefixed socket', async () => {
  const calls = [];
  const execute = fakeExecute(calls);
  const testEnv = { ...fakeEnv(), ASTERISM_TEST: '1' };

  await assert.rejects(() => execTmux(['list-clients'], { socketPath: '/tmp/sockets/default', env: testEnv, execute }));
  assert.equal(calls.length, 0);

  const passed = await execTmux(['list-clients'], { socketPath: '/tmp/sockets/asterism-test-x', env: testEnv, execute });
  assert.equal(passed.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'tmux');
  assert.equal(calls[0][1], '-u');

  const unsetResult = await execTmux(['list-clients'], { socketPath: '/tmp/sockets/default', env: fakeEnv(), execute });
  assert.equal(unsetResult.code, 0);
  assert.equal(calls.length, 2);
});

test('attachSessionArgv returns a frozen argv exactly and calls nothing', () => {
  const argv = attachSessionArgv('%1', { socketPath: '/tmp/sockets/x' });
  assert.deepEqual(argv, ['tmux', '-u', '-S', '/tmp/sockets/x', 'attach-session', '-t', '%1']);
  assert.equal(Object.isFrozen(argv), true);
});

test('attachSessionForeground spawns -u/-S/attach-session/-t against the real shim and resolves with the shim exit code', async () => {
  const h = newShimHarness();
  writeFixture(h.fixturesDir, 'attach-session', '', 0);

  const code = await attachSessionForeground('%1', { socketPath: h.socketPath, env: h.env });
  assert.equal(code, 0);

  const log = readLog(h.logPath);
  assert.equal(log.length, 1);
  assert.equal(log[0].argv[0], '-u');
  assert.ok(log[0].argv.includes('-S'));
  assert.ok(log[0].argv.includes('attach-session'));
  assert.ok(log[0].argv.includes('-t'));
});

test('every argv this file observed -- real shim log lines and fake-execute recordings alike -- begins with "-u"', async () => {
  const calls = [];
  const execute = fakeExecute(calls);
  await execTmux(['list-clients'], { socketPath: '/tmp/sockets/asterism-test-x', env: fakeEnv(), execute });
  await switchClient({ target: '%2', socketPath: '/tmp/sockets/asterism-test-x', env: fakeEnv(), execute });

  for (const argv of calls) {
    assert.equal(argv[0], 'tmux');
    assert.equal(argv[1], '-u', `argv ${JSON.stringify(argv)} must open with tmux -u`);
  }
  assert.equal(calls.length, 2);
});
