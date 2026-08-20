import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import fake from '../src/adapters/fake/index.js';
import { loadVerb } from '../src/cli/router.js';
import { ULID_PATTERN } from '../src/core/ulid.js';
import { UUID_PATTERN } from '../src/core/uuid.js';
import { readBindings, readSessions, resolveStateDir } from '../src/io/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBS_DIR = path.join(ROOT, 'src', 'cli', 'verbs');

async function scratch(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function loadNewVerb() {
  const verb = await loadVerb('new', VERBS_DIR);
  assert.ok(verb, 'the new verb must be loadable');
  return verb;
}

async function captureWrites(stream, fn) {
  const chunks = [];
  const original = stream.write;
  stream.write = function write(chunk) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  try {
    return { value: await fn(), text: Buffer.concat(chunks).toString('utf8') };
  } finally {
    stream.write = original;
  }
}

test('new writes Unbound before spawn, then persists a SpawnMinted Bound record and strong binding without hooks', async () => {
  const verb = await loadNewVerb();
  const tmp = await scratch('ast-new-');
  const env = { HOME: tmp, XDG_STATE_HOME: tmp, PATH: 'unused' };
  const server = Object.freeze({ socketPath: path.join(tmp, 'asterism-test-sock'), serverPid: 4242, version: '3.7c' });
  let sawUnboundBeforeSpawn = false;
  const calls = [];
  const adapter = {
    id: fake.id,
    spawnArgv: fake.spawnArgv,
    get hooks() {
      throw new Error('new must not inspect adapter hooks');
    },
  };
  const execute = async (argv) => {
    calls.push(argv);
    assert.equal(argv.includes('new-window'), true);
    const duringSpawn = await readSessions(resolveStateDir(env));
    assert.equal(duringSpawn.errors.length, 0);
    assert.equal(duringSpawn.records.length, 1, 'the session row must exist when new-window arrives');
    assert.equal(duringSpawn.records[0].record.state, 'Unbound');
    assert.equal(duringSpawn.records[0].record.binding, null);
    assert.match(duringSpawn.records[0].record.id, ULID_PATTERN);
    assert.match(duringSpawn.records[0].record.agent.sessionId, UUID_PATTERN);
    assert.equal(duringSpawn.records[0].record.agent.cwd, '/tmp/project');
    sawUnboundBeforeSpawn = true;
    return { code: 0, stdout: Buffer.from('%7\n'), stderr: Buffer.alloc(0) };
  };

  const result = await captureWrites(process.stdout, () =>
    verb.run(['/tmp/project'], {
      env,
      adapters: new Map([[adapter.id, adapter]]),
      root: ROOT,
      execute,
      resolveServers: async () => [server],
    }),
  );
  assert.equal(result.value, 0);
  assert.equal(sawUnboundBeforeSpawn, true);
  assert.equal(calls.length, 1);

  const sessions = await readSessions(resolveStateDir(env));
  assert.equal(sessions.errors.length, 0);
  assert.equal(sessions.records.length, 1);
  const record = sessions.records[0].record;
  assert.equal(record.state, 'Bound');
  assert.equal(record.binding.by, 'SpawnMinted');
  assert.equal(record.binding.paneId, '%7');
  assert.equal(record.binding.serverPid, 4242);
  assert.match(result.text, new RegExp(`${record.id}.*%7`));

  assert.deepEqual(calls[0].slice(-4), ['--', 'fake-agent', '--session-id', record.agent.sessionId]);
  assert.equal(calls[0].includes('-d'), true);

  const bindings = await readBindings(resolveStateDir(env));
  assert.equal(bindings.errors.length, 0);
  assert.equal(bindings.records.length, 1);
  const bindingId = path.basename(bindings.records[0].file, '.bind');
  assert.match(bindingId, ULID_PATTERN);
  assert.notEqual(bindingId, record.id);
  assert.deepEqual(bindings.records[0].record, {
    sessionId: record.agent.sessionId,
    adapter: 'fake',
    by: 'SpawnMinted',
    target: '%7',
    socketPath: server.socketPath,
    serverPid: 4242,
    at: record.binding.at,
  });

  const source = await readFile(path.join(VERBS_DIR, 'new.js'), 'utf8');
  assert.doesNotMatch(source, /(?:from\s+['"][^'"]*hook|\.hooks\b)/);
});

test('new no-server refusal resolves and creates no store', async () => {
  const verb = await loadNewVerb();
  const tmp = await scratch('ast-new-no-server-');
  const env = { HOME: tmp, XDG_STATE_HOME: tmp, PATH: 'unused' };
  const result = await captureWrites(process.stderr, () =>
    verb.run([], {
      env,
      adapters: new Map([[fake.id, fake]]),
      root: ROOT,
      resolveServers: async () => [],
      execute: async () => {
        throw new Error('no tmux command should run');
      },
    }),
  );

  assert.equal(result.value, 1);
  assert.match(result.text, /no tmux server is reachable/i);
  await assert.rejects(() => access(resolveStateDir(env)), { code: 'ENOENT' });
});

test('new --switch omits detached mode and suppresses the detached-session receipt', async () => {
  const verb = await loadNewVerb();
  const tmp = await scratch('ast-new-switch-');
  const env = { HOME: tmp, XDG_STATE_HOME: tmp, PATH: 'unused' };
  const server = Object.freeze({ socketPath: path.join(tmp, 'asterism-test-sock'), serverPid: 4242, version: '3.7c' });
  const calls = [];
  const result = await captureWrites(process.stdout, () =>
    verb.run(['--switch'], {
      env,
      adapters: new Map([[fake.id, fake]]),
      root: ROOT,
      resolveServers: async () => [server],
      execute: async (argv) => {
        calls.push(argv);
        return { code: 0, stdout: Buffer.from('%8\n'), stderr: Buffer.alloc(0) };
      },
    }),
  );

  assert.equal(result.value, 0);
  assert.equal(result.text, '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('-d'), false);
});

test('new selects the sole adapter and its multi-adapter refusal resolves without writes', async () => {
  const verb = await loadNewVerb();
  assert.equal(verb.selectAdapter(new Map([[fake.id, fake]])).adapter, fake);

  const adapters = new Map([
    ['zeta', { id: 'zeta', spawnArgv: fake.spawnArgv }],
    ['alpha', { id: 'alpha', spawnArgv: fake.spawnArgv }],
  ]);
  const selected = verb.selectAdapter(adapters);
  assert.match(selected.error, /alpha, zeta/);
  assert.match(selected.error, /--adapter/);

  const tmp = await scratch('ast-new-multi-adapter-');
  const env = { HOME: tmp, XDG_STATE_HOME: tmp, PATH: 'unused' };
  const result = await captureWrites(process.stderr, () =>
    verb.run([], {
      env,
      adapters,
      root: ROOT,
      resolveServers: async () => {
        throw new Error('server resolution must not run after adapter refusal');
      },
    }),
  );
  assert.equal(result.value, 1);
  assert.match(result.text, /alpha, zeta/);
  await assert.rejects(() => access(resolveStateDir(env)), { code: 'ENOENT' });
});

test('new parses one optional cwd and one --switch, rejecting every other shape', async () => {
  const { parseArgs } = await loadNewVerb();
  assert.deepEqual(parseArgs([]), { cwd: process.cwd(), switchWindow: false });
  assert.deepEqual(parseArgs(['/tmp/project']), { cwd: '/tmp/project', switchWindow: false });
  assert.deepEqual(parseArgs(['relative/project', '--switch']), {
    cwd: path.resolve('relative/project'),
    switchWindow: true,
  });
  assert.deepEqual(parseArgs(['--switch', '/tmp/project']), { cwd: '/tmp/project', switchWindow: true });
  for (const argv of [['a', 'b'], ['--switch', '--switch'], ['--unknown']]) assert.equal(parseArgs(argv), null);
});

test('new malformed argv resolves to usage refusal before any write', async () => {
  const verb = await loadNewVerb();
  const tmp = await scratch('ast-new-usage-');
  const env = { HOME: tmp, XDG_STATE_HOME: tmp, PATH: 'unused' };
  const result = await captureWrites(process.stderr, () =>
    verb.run(['--unknown'], {
      env,
      adapters: new Map([[fake.id, fake]]),
      root: ROOT,
      resolveServers: async () => { throw new Error('server resolution must not run after usage refusal'); },
      execute: async () => { throw new Error('tmux must not run after usage refusal'); },
    }),
  );

  assert.equal(result.value, 2);
  assert.match(result.text, /^usage: ast new /);
  await assert.rejects(() => access(resolveStateDir(env)), { code: 'ENOENT' });
});
