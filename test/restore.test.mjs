import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import fake from '../src/adapters/fake/index.js';
import { loadVerb } from '../src/cli/router.js';
import { readBindings, readSessions, resolveStateDir } from '../src/io/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBS_DIR = path.join(ROOT, 'src', 'cli', 'verbs');
const LIVE_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SAVED_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const AMBIGUOUS_SESSION_ID = '33333333-3333-4333-8333-333333333334';

async function scratch(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
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

async function captureIo(fn) {
  const stdout = [];
  const stderr = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = function write(chunk) {
    stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  process.stderr.write = function write(chunk) {
    stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  try {
    return {
      code: await fn(),
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

async function setupLayout(entries) {
  const tmp = await scratch('ast-restore-');
  const fakeRoot = path.join(tmp, 'fake');
  const sessionsDir = path.join(fakeRoot, 'sessions');
  const env = { ASTERISM_FAKE_ROOT: fakeRoot, HOME: tmp, XDG_STATE_HOME: tmp, PATH: 'unused' };
  const stateDir = resolveStateDir(env);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, 'layout.json'),
    `${JSON.stringify({ version: 1, capturedAt: '2026-08-23T12:00:00.000Z', entries }, null, 2)}\n`,
  );
  return { env, fakeRoot, sessionsDir, stateDir };
}

async function writeLayout(box, doc) {
  await mkdir(box.stateDir, { recursive: true });
  await writeFile(path.join(box.stateDir, 'layout.json'), `${JSON.stringify(doc, null, 2)}\n`);
}

async function filesUnder(root) {
  const files = [];
  async function walk(dir, relative) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      const entryRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(entryPath, entryRelative);
      else files.push(entryRelative);
    }
  }
  await walk(root, '');
  return files.sort();
}

function serverFor(box) {
  return Object.freeze({
    socketPath: path.join(box.stateDir, 'asterism-test-sock'),
    serverPid: 4242,
    version: '3.7c',
  });
}

function contextFor(box, overrides = {}) {
  return {
    env: box.env,
    adapters: new Map([[fake.id, fake]]),
    root: ROOT,
    resolveServers: async () => [serverFor(box)],
    execute: async () => ({ code: 0, stdout: Buffer.from('%9\n'), stderr: Buffer.alloc(0) }),
    ...overrides,
  };
}

async function runRestore(box, argv = [], overrides = {}) {
  const verb = await loadVerb('restore', VERBS_DIR);
  assert.ok(verb, 'the restore verb must be loadable');
  return captureIo(() => verb.run(argv, contextFor(box, overrides)));
}

test('restore hands resume argv to the tmux chokepoint and leaves binding to the hook', async () => {
  const cwd = await scratch('ast-restore-cwd-');
  const box = await setupLayout([{ adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd }]);
  const verb = await loadVerb('restore', VERBS_DIR);
  assert.ok(verb, 'the restore verb must be loadable');

  const calls = [];
  const before = await filesUnder(box.stateDir);
  const result = await captureWrites(process.stdout, () =>
    verb.run([], {
      env: box.env,
      adapters: new Map([[fake.id, fake]]),
      root: ROOT,
      resolveServers: async () => [
        Object.freeze({ socketPath: path.join(box.stateDir, 'asterism-test-sock'), serverPid: 4242, version: '3.7c' }),
      ],
      execute: async (argv) => {
        calls.push(argv);
        return { code: 0, stdout: Buffer.from('%9\n'), stderr: Buffer.alloc(0) };
      },
    }),
  );

  assert.deepEqual(calls.at(-1).slice(-3), ['fake-agent', '--resume', SAVED_SESSION_ID]);
  assert.equal(result.value, 0);
  assert.equal(
    result.text,
    `${SAVED_SESSION_ID} -> %9 (resumed; unbound until the session-start hook fires)\n`,
  );
  assert.deepEqual(await filesUnder(box.stateDir), before);
  assert.deepEqual(await readSessions(box.stateDir), { records: [], errors: [] });
  assert.deepEqual(await readBindings(box.stateDir), { records: [], errors: [] });
});

test('restore skips an already-live entry while a restorable control creates exactly one window', async () => {
  const liveCwd = await scratch('ast-restore-live-cwd-');
  const savedCwd = await scratch('ast-restore-saved-cwd-');
  const box = await setupLayout([
    { adapter: fake.id, sessionId: LIVE_SESSION_ID, cwd: liveCwd },
    { adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd: savedCwd },
  ]);
  await writeFile(
    path.join(box.sessionsDir, '0000.json'),
    JSON.stringify({ id: LIVE_SESSION_ID, status: 'idle', cwd: liveCwd }),
  );
  const calls = [];

  const result = await runRestore(box, [], {
    execute: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: Buffer.from('%10\n'), stderr: Buffer.alloc(0) };
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls.length, 1, 'the live entry must skip while its restorable control still creates one window');
  assert.deepEqual(calls[0].slice(-3), ['fake-agent', '--resume', SAVED_SESSION_ID]);
  assert.equal(
    result.stdout,
    `restore: skip ${LIVE_SESSION_ID} (already live)\n` +
      `${SAVED_SESSION_ID} -> %10 (resumed; unbound until the session-start hook fires)\n`,
  );
});

test('restore refuses no layout and a layout control reaches window creation', async () => {
  const tmp = await scratch('ast-restore-no-layout-');
  const box = {
    env: { ASTERISM_FAKE_ROOT: path.join(tmp, 'fake'), HOME: tmp, XDG_STATE_HOME: tmp, PATH: 'unused' },
    stateDir: path.join(tmp, 'asterism'),
  };
  const refused = await runRestore(box, [], {
    resolveServers: async () => { throw new Error('server resolution must not run without a layout'); },
  });
  assert.deepEqual(refused, { code: 1, stdout: '', stderr: 'ast restore: no layout is available\n' });

  const cwd = await scratch('ast-restore-no-layout-control-');
  await mkdir(path.join(box.env.ASTERISM_FAKE_ROOT, 'sessions'), { recursive: true });
  await writeLayout(box, {
    version: 1,
    capturedAt: '2026-08-23T12:00:00.000Z',
    entries: [{ adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd }],
  });
  const control = await runRestore(box);
  assert.equal(control.code, 0, control.stderr);
  assert.match(control.stdout, new RegExp(`${SAVED_SESSION_ID} -> %9`));
});

test('restore reports schema checker paths and a schema-valid control reaches window creation', async () => {
  const cwd = await scratch('ast-restore-schema-cwd-');
  const box = await setupLayout([{ adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd }]);
  await writeLayout(box, {
    version: 1,
    capturedAt: '2026-08-23T12:00:00.000Z',
    entries: [{ adapter: fake.id, sessionId: SAVED_SESSION_ID, extra: true }],
  });
  const refused = await runRestore(box, [], {
    resolveServers: async () => { throw new Error('server resolution must not run for an invalid schema'); },
  });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^ast restore: schema-invalid:/);
  assert.match(refused.stderr, /entries\[0\]\.cwd: required property is missing/);
  assert.match(refused.stderr, /entries\[0\]\.extra: additional property is not allowed/);

  await writeLayout(box, {
    version: 1,
    capturedAt: '2026-08-23T12:00:00.000Z',
    entries: [{ adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd }],
  });
  assert.equal((await runRestore(box)).code, 0);
});

test('restore refuses an unknown adapter and a registered-adapter control reaches window creation', async () => {
  const cwd = await scratch('ast-restore-adapter-cwd-');
  const box = await setupLayout([{ adapter: 'unknown', sessionId: SAVED_SESSION_ID, cwd }]);
  const refused = await runRestore(box, [], {
    resolveServers: async () => { throw new Error('server resolution must not run for an unknown adapter'); },
  });
  assert.deepEqual(refused, {
    code: 1,
    stdout: '',
    stderr: `ast restore: adapter-unknown: "unknown" for ${SAVED_SESSION_ID}\n`,
  });

  await writeLayout(box, {
    version: 1,
    capturedAt: '2026-08-23T12:00:00.000Z',
    entries: [{ adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd }],
  });
  assert.equal((await runRestore(box)).code, 0);
});

test('restore refuses a missing cwd and the same entry succeeds after the directory exists', async () => {
  const tmp = await scratch('ast-restore-missing-parent-');
  const missing = path.join(tmp, 'missing');
  const box = await setupLayout([{ adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd: missing }]);
  const refused = await runRestore(box, [], {
    resolveServers: async () => { throw new Error('server resolution must not run for a missing cwd'); },
  });
  assert.deepEqual(refused, {
    code: 1,
    stdout: '',
    stderr: `ast restore: cwd-missing: ${JSON.stringify(missing)} for ${SAVED_SESSION_ID}\n`,
  });

  await mkdir(missing);
  assert.equal((await runRestore(box)).code, 0);
});

test('restore shapes an unsafe cwd refusal before newWindow and a safe control reaches it', async () => {
  const unsafe = `${await scratch('ast-restore-unsafe-parent-')}/line\nbreak`;
  await mkdir(unsafe);
  const box = await setupLayout([{ adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd: unsafe }]);
  const refused = await runRestore(box, [], {
    resolveServers: async () => { throw new Error('server resolution must not run for an unsafe cwd'); },
  });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^ast restore: cwd-unsafe:/);
  assert.match(refused.stderr, /format-unsafe character/);

  const safe = await scratch('ast-restore-safe-control-');
  await writeLayout(box, {
    version: 1,
    capturedAt: '2026-08-23T12:00:00.000Z',
    entries: [{ adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd: safe }],
  });
  assert.equal((await runRestore(box)).code, 0);
});

test('restore refuses no reachable server and a reachable-server control creates a window', async () => {
  const cwd = await scratch('ast-restore-server-cwd-');
  const box = await setupLayout([{ adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd }]);
  const refused = await runRestore(box, [], {
    resolveServers: async ({ notes }) => {
      notes.push(Object.freeze({ adapter: 'tmux', note: 'socket-probe-failed', detail: '/tmp/socket: denied' }));
      return [];
    },
    execute: async () => { throw new Error('new-window must not run without a server'); },
  });
  assert.equal(refused.code, 1);
  assert.ok(refused.stderr.includes('note: tmux: socket-probe-failed: /tmp/socket: denied'));
  assert.ok(refused.stderr.endsWith('ast restore: no tmux server is reachable\n'));

  assert.equal((await runRestore(box)).code, 0);
});

test('restore dry-run prints the ordered resume plan and rollback for every entry without creating a window', async () => {
  const firstCwd = await scratch('ast-restore-dry-first-');
  const secondCwd = await scratch('ast-restore-dry-second-');
  const box = await setupLayout([
    { adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd: firstCwd },
    { adapter: fake.id, sessionId: OTHER_SESSION_ID, cwd: secondCwd },
  ]);
  const result = await runRestore(box, ['--dry-run'], {
    execute: async () => { throw new Error('dry-run must not execute tmux'); },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    `restore: would resume ${SAVED_SESSION_ID} (fake) in ${JSON.stringify(firstCwd)} with ` +
      `${JSON.stringify(['fake-agent', '--resume', SAVED_SESSION_ID])} -- rollback: tmux kill-window -t %N\n` +
      `restore: would resume ${OTHER_SESSION_ID} (fake) in ${JSON.stringify(secondCwd)} with ` +
      `${JSON.stringify(['fake-agent', '--resume', OTHER_SESSION_ID])} -- rollback: tmux kill-window -t %N\n`,
  );
});

test('restore --only selects a unique session-id ref and refuses missing or ambiguous refs', async () => {
  const firstCwd = await scratch('ast-restore-only-first-');
  const secondCwd = await scratch('ast-restore-only-second-');
  const box = await setupLayout([
    { adapter: fake.id, sessionId: SAVED_SESSION_ID, cwd: firstCwd },
    { adapter: fake.id, sessionId: OTHER_SESSION_ID, cwd: secondCwd },
    { adapter: fake.id, sessionId: AMBIGUOUS_SESSION_ID, cwd: secondCwd },
  ]);
  const calls = [];
  const selected = await runRestore(box, ['--only', OTHER_SESSION_ID], {
    execute: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: Buffer.from('%11\n'), stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(selected.code, 0, selected.stderr);
  assert.deepEqual(calls[0].slice(-3), ['fake-agent', '--resume', OTHER_SESSION_ID]);

  const missing = await runRestore(box, ['--only', '99999999']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no layout entry matches "99999999"/);

  const ambiguous = await runRestore(box, ['--only', '33333333']);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /ambiguous layout ref/);
});

test('restore --force resumes an already-live entry that the default run skips', async () => {
  const cwd = await scratch('ast-restore-force-cwd-');
  const box = await setupLayout([{ adapter: fake.id, sessionId: LIVE_SESSION_ID, cwd }]);
  await writeFile(
    path.join(box.sessionsDir, '0000.json'),
    JSON.stringify({ id: LIVE_SESSION_ID, status: 'idle', cwd }),
  );
  let calls = 0;
  const overrides = {
    execute: async () => {
      calls += 1;
      return { code: 0, stdout: Buffer.from('%12\n'), stderr: Buffer.alloc(0) };
    },
  };

  const skipped = await runRestore(box, [], overrides);
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.equal(calls, 0);
  assert.equal(skipped.stdout, `restore: skip ${LIVE_SESSION_ID} (already live)\n`);

  const forced = await runRestore(box, ['--force'], overrides);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(calls, 1);
  assert.match(forced.stdout, new RegExp(`${LIVE_SESSION_ID} -> %12`));
});

test('restore rejects malformed flags with usage before reading layout', async () => {
  const tmp = await scratch('ast-restore-usage-');
  const box = {
    env: { HOME: tmp, XDG_STATE_HOME: tmp, PATH: 'unused' },
    stateDir: path.join(tmp, 'asterism'),
  };
  for (const argv of [
    ['--unknown'],
    ['--dry-run', '--dry-run'],
    ['--force', '--force'],
    ['--only'],
    ['--only', '--force'],
    ['--only', 'one', '--only', 'two'],
  ]) {
    const result = await runRestore(box, argv);
    assert.deepEqual(result, {
      code: 2,
      stdout: '',
      stderr: 'usage: ast restore [--dry-run] [--only <ref>] [--force]\n',
    });
  }
});

test('layout entry schema fields and restore consumers stay identical in both directions', async () => {
  const schema = JSON.parse(await readFile(path.join(ROOT, 'schema', 'layout-1.json'), 'utf8'));
  const source = await readFile(path.join(VERBS_DIR, 'restore.js'), 'utf8');
  const schemaFields = Object.keys(schema.properties.entries.items.properties).sort();
  const consumedFields = [...new Set([...source.matchAll(/\bentry\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]))].sort();

  assert.deepEqual(schemaFields, ['adapter', 'cwd', 'sessionId']);
  assert.deepEqual(consumedFields, schemaFields);
});
