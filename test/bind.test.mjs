import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildRegistry } from '../src/adapters/index.js';
import { qualifyPaneServer } from '../src/cli/verbs/bind.js';
import { openStore, readBindings } from '../src/io/store.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const FAKE_TMUX = path.join(ROOT, 'harness', 'fake-tmux', 'tmux');
const NODE = typeof globalThis.Bun === 'undefined' ? process.execPath : globalThis.Bun.which('node');
assert.ok(NODE, 'the test runner could not locate node for the fake-tmux shebang');

async function harness({ panes = '%5|4243|$0|@1|0||\n', serverPid = 4242 } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ast-bind-'));
  const shimDir = path.join(tmp, 'bin');
  const fakeRoot = path.join(tmp, 'fake-root');
  const fixturesDir = path.join(tmp, 'fixtures');
  const socketDir = path.join(tmp, `tmux-${process.getuid()}`);
  const socketFile = path.join(socketDir, 'asterism-test-sock');
  const logPath = path.join(tmp, 'tmux.log');
  await Promise.all([mkdir(shimDir), mkdir(path.join(fakeRoot, 'sessions'), { recursive: true }), mkdir(fixturesDir), mkdir(socketDir)]);
  await copyFile(FAKE_TMUX, path.join(shimDir, 'tmux'));
  await chmod(path.join(shimDir, 'tmux'), 0o755);
  await writeFile(path.join(fakeRoot, 'sessions', '0.json'), JSON.stringify({ id: 'fake-0001', status: 'waiting' }));
  await writeFile(socketFile, '');
  const socketPath = await realpath(socketFile);
  await Promise.all([
    writeFile(path.join(fixturesDir, 'display-message.out'), `${socketPath},${serverPid},3.7c\n`),
    writeFile(path.join(fixturesDir, 'list-panes.out'), panes),
  ]);
  const env = {
    PATH: `${shimDir}${path.delimiter}${path.dirname(NODE)}`, HOME: tmp, XDG_STATE_HOME: tmp, TERM: 'dumb',
    ASTERISM_TEST: '1', ASTERISM_FAKE_ROOT: fakeRoot, ASTERISM_FAKE_TMUX_LOG: logPath,
    ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir, TMUX_TMPDIR: tmp,
  };
  return { tmp, shimDir, socketFile, socketPath, logPath, serverPid, env };
}

async function runAst(h, args, overrides = {}) {
  try {
    const result = await execFileAsync(NODE, [AST_BIN, ...args], { cwd: ROOT, env: { ...h.env, ...overrides }, encoding: 'utf8' });
    return { code: 0, ...result };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function bindings(h) {
  try {
    const store = await openStore({ env: h.env });
    return readBindings(store.stateDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], errors: [] };
    throw error;
  }
}

test('pane-id gate refuses names, windows, and sessions before any spawn, beside a succeeding pane control', async () => {
  for (const paneId of ['mysession', '@1', '$0']) {
    const h = await harness();
    const result = await runAst(h, ['bind', 'fake-0001', paneId]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(paneId.replace('$', '\\$')));
    assert.match(result.stderr, /\^%\\d\+\$/);
    await assert.rejects(() => readFile(h.logPath));
    assert.equal((await bindings(h)).records.length, 0);
  }
  const control = await harness();
  assert.equal((await runAst(control, ['bind', 'fake-0001', '%5'])).code, 0);
});

test('inside tmux writes one HumanAsserted server-qualified binding', async () => {
  const h = await harness();
  const result = await runAst(h, ['bind', 'fake-0001', '%5'], { TMUX: `${h.socketFile},${h.serverPid},0` });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake-0001.*%5.*4242.*human-asserted/);
  const read = await bindings(h);
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0].record.by, 'HumanAsserted');
  assert.equal(read.records[0].record.target, '%5');
  assert.equal(read.records[0].record.serverPid, h.serverPid);
  assert.equal(typeof read.records[0].record.socketPath, 'string');
});

test('qualifyPaneServer refuses two carriers, selects one, and names zero carriers', () => {
  const one = Object.freeze({ socketPath: '/one', serverPid: 1 });
  const two = Object.freeze({ socketPath: '/two', serverPid: 2 });
  const both = qualifyPaneServer([one, two], new Map([['/one', [{ paneId: '%5', paneDead: '0' }]], ['/two', [{ paneId: '%5', paneDead: '0' }]]]), '%5');
  assert.match(both.error, /ambiguous.*\/one.*1.*\/two.*2/i);
  assert.deepEqual(qualifyPaneServer([one, two], new Map([['/one', [{ paneId: '%4', paneDead: '0' }]], ['/two', [{ paneId: '%5', paneDead: '0' }]]]), '%5'), { server: two });
  assert.deepEqual(qualifyPaneServer([one], new Map([['/one', [{ paneId: '%4', paneDead: '0' }]]]), '%5'), { error: 'pane %5 not found on any reachable server' });
});

test('outside tmux binds on one carrier; an absent pane refuses without writing', async () => {
  const present = await harness();
  assert.equal((await runAst(present, ['bind', 'fake-0001', '%5'])).code, 0);
  assert.equal((await bindings(present)).records.length, 1);
  const absent = await harness({ panes: '%4|4243|$0|@1|0||\n' });
  const result = await runAst(absent, ['bind', 'fake-0001', '%5']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pane %5 not found/);
  assert.equal((await bindings(absent)).records.length, 0);
});

test('resolveServers notes precede the pane-not-found refusal', async () => {
  const h = await harness();
  await chmod(path.join(h.shimDir, 'tmux'), 0o644);

  const result = await runAst(h, ['bind', 'fake-0001', '%5']);

  assert.equal(result.code, 1);
  const note = 'note: tmux: socket-probe-failed:';
  const refusal = 'pane %5 not found on any reachable server';
  assert.ok(result.stderr.includes(note), result.stderr);
  assert.ok(result.stderr.indexOf(note) < result.stderr.indexOf(refusal), result.stderr);
});

test('R5 refuses bind before state is written', async () => {
  const h = await harness();
  const marker = buildRegistry({ ASTERISM_FAKE_ROOT: '/x' }).get('fake').agentEnvMarkers[0];
  const result = await runAst(h, ['bind', 'fake-0001', '%5'], { [marker]: '1' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rule R5/);
  assert.equal((await bindings(h)).records.length, 0);
});
