import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildRegistry } from '../src/adapters/index.js';
import { chooseClient, qualifyCandidate } from '../src/cli/verbs/go.js';
import { attachSessionArgv } from '../src/io/tmuxexec.js';
import { resolveServers } from '../src/io/tmuxsock.js';
import { openStore } from '../src/io/store.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const FAKE_TMUX = path.join(ROOT, 'harness', 'fake-tmux', 'tmux');
const NODE = typeof globalThis.Bun === 'undefined' ? process.execPath : globalThis.Bun.which('node');
assert.ok(NODE, 'the test runner could not locate node for the fake-tmux shebang');

async function harness({ sessions = [{ id: 'fake-0001', status: 'waiting' }], panes = '%5|4243|$0|@1|0||\n', clients = 'cli-a|$0|100\n', socket = true, serverPid = 4242 } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ast-go-'));
  const shimDir = path.join(tmp, 'bin');
  const fakeRoot = path.join(tmp, 'fake-root');
  const fixturesDir = path.join(tmp, 'fixtures');
  const socketDir = path.join(tmp, `tmux-${process.getuid()}`);
  const socketFile = path.join(socketDir, 'asterism-test-sock');
  const logPath = path.join(tmp, 'tmux.log');
  await Promise.all([
    mkdir(shimDir), mkdir(path.join(fakeRoot, 'sessions'), { recursive: true }), mkdir(fixturesDir), mkdir(socketDir),
  ]);
  await copyFile(FAKE_TMUX, path.join(shimDir, 'tmux'));
  await chmod(path.join(shimDir, 'tmux'), 0o755);
  for (let index = 0; index < sessions.length; index += 1) {
    await writeFile(path.join(fakeRoot, 'sessions', `${index}.json`), JSON.stringify(sessions[index]));
  }
  let socketPath = socketFile;
  if (socket) {
    await writeFile(socketFile, '');
    socketPath = await realpath(socketFile);
    await Promise.all([
      writeFile(path.join(fixturesDir, 'display-message.out'), `${socketPath},${serverPid},3.7c\n`),
      writeFile(path.join(fixturesDir, 'list-panes.out'), panes),
      writeFile(path.join(fixturesDir, 'list-clients.out'), clients),
      writeFile(path.join(fixturesDir, 'switch-client.out'), ''),
      writeFile(path.join(fixturesDir, 'attach-session.out'), ''),
    ]);
  }
  const env = {
    PATH: `${shimDir}${path.delimiter}${path.dirname(NODE)}`,
    HOME: tmp,
    XDG_STATE_HOME: tmp,
    TERM: 'dumb',
    ASTERISM_TEST: '1',
    ASTERISM_FAKE_ROOT: fakeRoot,
    ASTERISM_FAKE_TMUX_LOG: logPath,
    ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir,
    TMUX_TMPDIR: tmp,
  };
  return { tmp, shimDir, fakeRoot, fixturesDir, socketFile, socketPath, logPath, serverPid, env };
}

async function seedBinding(h, record = {}) {
  const store = await openStore({ env: h.env });
  await store.writeBinding('01ARZ3NDEKTSV4RRFFQ69G5FAV', {
    sessionId: 'fake-0001', adapter: 'fake', by: 'HumanAsserted', target: '%5',
    socketPath: h.socketPath, serverPid: h.serverPid, at: '2026-08-20T00:00:00.000Z', ...record,
  });
  return store;
}

async function runAst(h, args, overrides = {}) {
  try {
    const result = await execFileAsync(NODE, [AST_BIN, ...args], {
      cwd: ROOT, env: { ...h.env, ...overrides }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function logRows(h) {
  try {
    return (await readFile(h.logPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function calls(rows, command) {
  return rows.filter((row) => row.argv.includes(command)).map((row) => row.argv);
}

function switchArgv(socketPath, clientName, paneId = '%5') {
  return ['-u', '-S', socketPath, 'switch-client', ...(clientName ? ['-c', clientName] : []), '-t', paneId];
}

test('inside tmux switches the invoking client to the bound pane without -c', async () => {
  const h = await harness();
  await seedBinding(h);
  const result = await runAst(h, ['go', 'fake-0001'], { TMUX: `${h.socketFile},${h.serverPid},0` });
  assert.equal(result.code, 0, result.stderr);
  const rows = await logRows(h);
  assert.deepEqual(calls(rows, 'switch-client'), [switchArgv(h.socketPath, null)]);
  for (const row of rows.filter((entry) => !entry.argv.includes('display-message'))) {
    if (row.argv.includes('-S')) assert.equal(row.argv[row.argv.indexOf('-S') + 1], h.socketPath);
  }
  assert.match(result.stdout, /fake-0001.*%5.*human-asserted/);
});

test('zero clients warns before foreground attach', async () => {
  const h = await harness({ clients: '' });
  await seedBinding(h);
  const result = await runAst(h, ['go', 'fake-0001']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /attach-session will block this terminal/);
  assert.deepEqual(calls(await logRows(h), 'attach-session'), [['-u', '-S', h.socketPath, 'attach-session', '-t', '%5']]);
  assert.deepEqual(attachSessionArgv('%5', { socketPath: h.socketPath }), ['tmux', '-u', '-S', h.socketPath, 'attach-session', '-t', '%5']);
});

test('one client is named and selected', async () => {
  const h = await harness();
  await seedBinding(h);
  const result = await runAst(h, ['go', 'fake-0001']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /cli-a/);
  assert.deepEqual(calls(await logRows(h), 'switch-client'), [switchArgv(h.socketPath, 'cli-a')]);
});

for (const [activities, expected] of [[['100', '200'], 'cli-b'], [['200', '100'], 'cli-a'], [['999', '1000'], 'cli-b']]) {
  test(`multiple clients compare ${activities.join('/')} numerically`, async () => {
    const h = await harness({ clients: `cli-a|$0|${activities[0]}\ncli-b|$0|${activities[1]}\n` });
    await seedBinding(h);
    const result = await runAst(h, ['go', 'fake-0001']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(expected));
    assert.deepEqual(calls(await logRows(h), 'switch-client'), [switchArgv(h.socketPath, expected)]);
  });
}

test('--client overrides activity and an unknown name refuses with known-name controls', async () => {
  const h = await harness({ clients: 'cli-a|$0|100\ncli-b|$0|200\n' });
  await seedBinding(h);
  const bad = await runAst(h, ['go', 'fake-0001', '--client', 'zz']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /zz.*cli-a.*cli-b/);
  const good = await runAst(h, ['go', 'fake-0001', '--client', 'cli-a']);
  assert.equal(good.code, 0, good.stderr);
  assert.deepEqual(calls(await logRows(h), 'switch-client'), [switchArgv(h.socketPath, 'cli-a')]);
});

test('no reachable server is distinct from an empty pane list', async () => {
  const h = await harness({ socket: false });
  await seedBinding(h, { socketPath: h.socketFile });
  const result = await runAst(h, ['go', 'fake-0001']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no tmux server reachable/);
  assert.equal(calls(await logRows(h), 'list-panes').length, 0);
  const control = await harness();
  await seedBinding(control);
  assert.equal((await runAst(control, ['go', 'fake-0001'])).code, 0);
});

test('collectSessions notes precede the no-sessions refusal', async () => {
  const h = await harness({ sessions: [] });
  await writeFile(path.join(h.fakeRoot, 'sessions', 'malformed.json'), '{');

  const result = await runAst(h, ['go']);

  assert.equal(result.code, 1);
  const note = 'note: fake: adapter-unavailable:';
  const refusal = 'no sessions';
  assert.ok(result.stderr.includes(note), result.stderr);
  assert.ok(result.stderr.indexOf(note) < result.stderr.indexOf(refusal), result.stderr);
});

test('resolveServers notes precede the no-server refusal', async () => {
  const h = await harness();
  await chmod(path.join(h.shimDir, 'tmux'), 0o644);

  const result = await runAst(h, ['go', 'fake-0001']);

  assert.equal(result.code, 1);
  const note = 'note: tmux: socket-probe-failed:';
  const refusal = 'no tmux server reachable';
  assert.ok(result.stderr.includes(note), result.stderr);
  assert.ok(result.stderr.indexOf(note) < result.stderr.indexOf(refusal), result.stderr);
});

test('no-arg go chooses waiting first; ambiguous refs fail while a unique prefix resolves', async () => {
  const h = await harness({ sessions: [{ id: 'idle-one', status: 'idle' }, { id: 'waiting-one', status: 'waiting' }] });
  await seedBinding(h, { sessionId: 'waiting-one', target: '%9' });
  await writeFile(path.join(h.fixturesDir, 'list-panes.out'), '%9|4243|$0|@1|0||\n');
  const picked = await runAst(h, ['go']);
  assert.equal(picked.code, 0, picked.stderr);
  assert.deepEqual(calls(await logRows(h), 'switch-client'), [switchArgv(h.socketPath, 'cli-a', '%9')]);

  const ambiguous = await harness({ sessions: [{ id: 'session-alpha', status: 'idle' }, { id: 'session-alpine', status: 'idle' }] });
  const store = await openStore({ env: ambiguous.env });
  for (const [id, sessionId] of [['row-alpha', 'session-alpha'], ['row-alpine', 'session-alpine']]) {
    await store.writeSession(id, { id, adapter: 'fake', agent: { sessionId } });
  }
  await store.writeBinding('01ARZ3NDEKTSV4RRFFQ69G5FAV', { sessionId: 'session-alpha', adapter: 'fake', by: 'HumanAsserted', target: '%5', socketPath: ambiguous.socketPath, serverPid: ambiguous.serverPid, at: '2026-08-20T00:00:00.000Z' });
  const refused = await runAst(ambiguous, ['go', 'session-al']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /ambiguous session ref.*row-alpha.*row-alpine/);
  assert.equal((await runAst(ambiguous, ['go', 'session-alpha'])).code, 0);
});

test('dead bound panes refuse before switching, beside an alive control', async () => {
  const dead = await harness({ panes: '%5|4243|$0|@1|1||\n' });
  await seedBinding(dead);
  const result = await runAst(dead, ['go', 'fake-0001']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /%5/);
  assert.equal(calls(await logRows(dead), 'switch-client').length, 0);
  const alive = await harness();
  await seedBinding(alive);
  assert.equal((await runAst(alive, ['go', 'fake-0001'])).code, 0);
});

test('unbound heuristic qualification switches without persisting a weak binding', async () => {
  const h = await harness({ sessions: [{ id: 'fake-0001', status: 'waiting', pid: 300 }], panes: '%7|200|$0|@1|0||\n', serverPid: 100 });
  await writeFile(path.join(h.shimDir, 'ps'), '#!/usr/bin/env node\nprocess.stdout.write("300 200\\n200 100\\n100 1\\n");\n');
  await chmod(path.join(h.shimDir, 'ps'), 0o755);
  const result = await runAst(h, ['go', 'fake-0001']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /heuristic match/);
  assert.deepEqual(calls(await logRows(h), 'switch-client'), [switchArgv(h.socketPath, 'cli-a', '%7')]);
  assert.deepEqual(await readdir(path.join(h.tmp, 'asterism', 'bindings')), []);
});

test('a server-qualified weak spool witness is honoured but never writes', async () => {
  const h = await harness();
  await seedBinding(h, { by: 'VendorRegistry' });
  const result = await runAst(h, ['go', 'fake-0001']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /vendor-registry \(server-qualified\)/);
  assert.equal((await readdir(path.join(h.tmp, 'asterism', 'bindings'))).length, 1);
});

test('chooseClient and qualifyCandidate pin numeric ordering and right-to-left witnesses', () => {
  const rows = [{ clientName: 'a', clientActivity: '999' }, { clientName: 'b', clientActivity: '1000' }];
  assert.deepEqual(chooseClient(rows, { override: null }), { clientName: 'b' });
  assert.match(chooseClient(rows, { override: 'z' }).error, /a.*b/);
  const panes = [{ paneId: '%7', panePid: '200', paneDead: '0' }];
  assert.deepEqual(qualifyCandidate({ record: { agent: { pid: null } }, panes, pidTable: new Map(), serverPid: 100, witness: 'my:sess.io:@12.%7' }), { paneId: '%7', by: 'VendorRegistry' });
  assert.equal(qualifyCandidate({ record: { agent: { pid: null } }, panes, pidTable: new Map(), serverPid: 100, witness: 'my:sess.io:@12.%8' }), null);
  assert.equal(qualifyCandidate({ record: { agent: {} }, panes, pidTable: new Map([[300, 200], [200, 100]]), serverPid: 100, witness: null }), null);
});

test('R5 refuses go while the same marker does not refuse ls', async () => {
  const h = await harness();
  const marker = buildRegistry({ ASTERISM_FAKE_ROOT: '/x' }).get('fake').agentEnvMarkers[0];
  const refused = await runAst(h, ['go'], { [marker]: '1' });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /rule R5/);
  const control = await runAst(h, ['ls'], { [marker]: '1' });
  assert.doesNotMatch(control.stderr, /rule R5/);
});

test('resolveServers returns every live realpathed server, dedupes, skips dead files, and freezes empty', async () => {
  const mappings = { '/env/a': '/real/a', '/custom/tmux-501/a': '/real/a', '/custom/tmux-501/b': '/real/b' };
  const servers = await resolveServers({
    env: { TMUX: '/env/a,11,0', TMUX_TMPDIR: '/custom' }, uid: 501,
    exists: (candidate) => !candidate.endsWith('/dead'),
    listDir: (dir) => dir === '/custom/tmux-501' ? ['a', 'dead', 'b'] : [],
    realpath: (candidate) => mappings[candidate] ?? candidate,
    probe: async ({ socketPath }) => ({ ok: true, socketPath, pid: socketPath.endsWith('/b') ? 22 : 11, version: '3.7c' }),
  });
  assert.deepEqual(servers.map(({ socketPath, serverPid }) => ({ socketPath, serverPid })), [{ socketPath: '/real/a', serverPid: 11 }, { socketPath: '/real/b', serverPid: 22 }]);
  assert.equal(Object.isFrozen(servers), true);
  assert.ok(servers.every(Object.isFrozen));
  const empty = await resolveServers({ env: {}, uid: 501, exists: () => false, listDir: () => ['dead'], realpath: (p) => p, probe: async () => ({ ok: false }) });
  assert.deepEqual(empty, []);
  assert.equal(Object.isFrozen(empty), true);
});

test('resolveServers probes through non-ENOENT realpath failures, notes the candidate, and dedupes by server pid', async () => {
  const notes = [];
  const socketPath = '/env/asterism-test-live';
  const servers = await resolveServers({
    env: { TMUX: `${socketPath},41,0`, TMUX_TMPDIR: '/custom' },
    uid: 501,
    exists: () => true,
    listDir: (dir) => dir === '/custom/tmux-501' ? ['asterism-test-alias'] : [],
    realpath: () => { throw Object.assign(new Error('socket lstat is unsupported'), { code: 'EOPNOTSUPP' }); },
    probe: async ({ socketPath: probedPath }) => ({ ok: true, socketPath: probedPath, pid: 41, version: '3.7c' }),
    notes,
  });

  assert.deepEqual(servers, [{ socketPath, serverPid: 41, version: '3.7c' }]);
  assert.ok(notes.some((entry) => entry.adapter === 'tmux' && entry.note === 'socket-canonicalization-failed' && entry.detail.includes(socketPath)));
});

test('resolveServers silently skips a candidate whose realpath reports ENOENT', async () => {
  const notes = [];
  let probes = 0;
  const servers = await resolveServers({
    env: { TMUX: '/env/asterism-test-gone,41,0' },
    uid: 501,
    exists: () => true,
    listDir: () => [],
    realpath: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
    probe: async () => { probes += 1; return { ok: true, socketPath: '/env/asterism-test-gone', pid: 41, version: '3.7c' }; },
    notes,
  });

  assert.deepEqual(servers, []);
  assert.equal(probes, 0);
  assert.deepEqual(notes, []);
});

test('resolveServers notes non-ENOENT probe failures but keeps ENOENT probe failures silent', async () => {
  const notes = [];
  const probeErrors = [
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    Object.assign(new Error('gone'), { code: 'ENOENT' }),
  ];
  const servers = await resolveServers({
    env: { TMUX: '/env/asterism-test-denied,41,0' },
    uid: 501,
    exists: () => true,
    listDir: (dir) => dir === '/tmp/tmux-501' ? ['asterism-test-gone'] : [],
    realpath: (candidate) => candidate,
    probe: async () => { throw probeErrors.shift(); },
    notes,
  });

  assert.deepEqual(servers, []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].adapter, 'tmux');
  assert.equal(notes[0].note, 'socket-probe-failed');
  assert.match(notes[0].detail, /\/env\/asterism-test-denied/);
});
