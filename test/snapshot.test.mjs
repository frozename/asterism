import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import fake from '../src/adapters/fake/index.js';
import { loadVerb } from '../src/cli/router.js';
import { readLayout, resolveStateDir } from '../src/io/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBS_DIR = path.join(ROOT, 'src', 'cli', 'verbs');

async function scratch(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function setupFake(rows) {
  const tmp = await scratch('ast-snapshot-');
  const fakeRoot = path.join(tmp, 'fake');
  const sessionsDir = path.join(fakeRoot, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  for (let index = 0; index < rows.length; index += 1) {
    await writeFile(path.join(sessionsDir, `${String(index).padStart(4, '0')}.json`), JSON.stringify(rows[index]));
  }
  const env = { ASTERISM_FAKE_ROOT: fakeRoot, HOME: tmp, XDG_STATE_HOME: tmp, PATH: 'unused' };
  return { env, fakeRoot, sessionsDir };
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

async function fileInventory(root) {
  const files = [];
  async function walk(current, relative) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) files.push({ path: childRelative, bytes: await readFile(child) });
    }
  }
  await walk(root, '');
  return files;
}

test('snapshot is loadable as a mutating verb', async () => {
  const verb = await loadVerb('snapshot', VERBS_DIR);
  assert.ok(verb, 'the snapshot verb must be loadable');
  assert.equal(verb.mutating, true);
});

test('snapshot rejects malformed argv with usage before opening state', async () => {
  const verb = await loadVerb('snapshot', VERBS_DIR);
  const result = await captureWrites(process.stderr, () =>
    verb.run(['--unknown'], {
      env: {},
      adapters: new Map(),
    }),
  );

  assert.equal(result.value, 2);
  assert.equal(result.text, 'usage: ast snapshot [--force] [--dry-run]\n');
});

test('snapshot captures only sessions with an adapter, session id, and absolute cwd without tmux', async () => {
  const verb = await loadVerb('snapshot', VERBS_DIR);
  const box = await setupFake([
    { id: 'fake-0001', status: 'idle', cwd: '/work/one' },
    { id: 'fake-0002', status: 'idle' },
    { id: 'fake-0003', status: 'idle', cwd: 'relative/three' },
    { id: 'fake-0004', status: 'waiting', cwd: '/work/four' },
  ]);

  const result = await captureWrites(process.stdout, () =>
    verb.run([], {
      env: box.env,
      adapters: new Map([[fake.id, fake]]),
      execute: async () => {
        throw new Error('snapshot must not execute tmux');
      },
    }),
  );

  assert.equal(result.value, 0);
  const layout = await readLayout(resolveStateDir(box.env));
  assert.equal(layout.version, 1);
  assert.equal(Number.isNaN(Date.parse(layout.capturedAt)), false);
  assert.deepEqual(layout.entries, [
    { adapter: 'fake', sessionId: 'fake-0004', cwd: '/work/four' },
    { adapter: 'fake', sessionId: 'fake-0001', cwd: '/work/one' },
  ]);
  assert.equal(result.text, 'snapshot: captured 2 sessions\n');

  const source = await readFile(path.join(VERBS_DIR, 'snapshot.js'), 'utf8');
  assert.doesNotMatch(source, /tmux|resumeArgv|send-keys/);
});

test('snapshot persists only schema-version and layout files on a fresh capture', async () => {
  const verb = await loadVerb('snapshot', VERBS_DIR);
  const box = await setupFake([{ id: 'fake-0001', status: 'idle', cwd: '/work/one' }]);

  const result = await captureWrites(process.stdout, () =>
    verb.run([], { env: box.env, adapters: new Map([[fake.id, fake]]) }),
  );

  assert.equal(result.value, 0);
  const files = await fileInventory(resolveStateDir(box.env));
  assert.deepEqual(files.map((entry) => entry.path), ['layout.json', 'schema-version']);
});

test('snapshot growth changes the layout bytes', async () => {
  const verb = await loadVerb('snapshot', VERBS_DIR);
  const box = await setupFake([{ id: 'fake-0001', status: 'idle', cwd: '/work/one' }]);
  const ctx = { env: box.env, adapters: new Map([[fake.id, fake]]) };
  const layoutPath = path.join(resolveStateDir(box.env), 'layout.json');

  const first = await captureWrites(process.stdout, () => verb.run([], ctx));
  assert.equal(first.value, 0);
  const before = await readFile(layoutPath);

  await writeFile(
    path.join(box.sessionsDir, '0001.json'),
    JSON.stringify({ id: 'fake-0002', status: 'idle', cwd: '/work/two' }),
  );
  const second = await captureWrites(process.stdout, () => verb.run([], ctx));
  assert.equal(second.value, 0);
  const after = await readFile(layoutPath);

  assert.notDeepEqual(after, before);
  assert.equal((await readLayout(resolveStateDir(box.env))).entries.length, 2);
  assert.equal(second.text, 'snapshot: captured 2 sessions\n');
});

test('snapshot dry-run previews a changed capture without replacing layout bytes', async () => {
  const verb = await loadVerb('snapshot', VERBS_DIR);
  const box = await setupFake([{ id: 'fake-0001', status: 'idle', cwd: '/work/one' }]);
  const ctx = { env: box.env, adapters: new Map([[fake.id, fake]]) };
  const layoutPath = path.join(resolveStateDir(box.env), 'layout.json');

  assert.equal((await captureWrites(process.stdout, () => verb.run([], ctx))).value, 0);
  const before = await readFile(layoutPath);
  await writeFile(
    path.join(box.sessionsDir, '0001.json'),
    JSON.stringify({ id: 'fake-0002', status: 'idle', cwd: '/work/two' }),
  );

  const dry = await captureWrites(process.stdout, () => verb.run(['--dry-run'], ctx));
  assert.equal(dry.value, 0);
  assert.equal(dry.text, 'snapshot: would capture 2 sessions\n');
  assert.deepEqual(await readFile(layoutPath), before);
});

test('snapshot dry-run creates no state when previewing a fresh capture', async () => {
  const verb = await loadVerb('snapshot', VERBS_DIR);
  const box = await setupFake([{ id: 'fake-0001', status: 'idle', cwd: '/work/one' }]);
  const stateDir = resolveStateDir(box.env);
  await assert.rejects(() => access(stateDir), { code: 'ENOENT' });

  const dry = await captureWrites(process.stdout, () =>
    verb.run(['--dry-run'], { env: box.env, adapters: new Map([[fake.id, fake]]) }),
  );

  assert.equal(dry.value, 0);
  assert.equal(dry.text, 'snapshot: would capture 1 session\n');
  await assert.rejects(() => access(stateDir), { code: 'ENOENT' });
});

test('snapshot shapes shrink refusal and --force replaces the guarded layout', async () => {
  const verb = await loadVerb('snapshot', VERBS_DIR);
  const box = await setupFake([
    { id: 'fake-0001', status: 'idle', cwd: '/work/one' },
    { id: 'fake-0002', status: 'idle', cwd: '/work/two' },
  ]);
  const ctx = { env: box.env, adapters: new Map([[fake.id, fake]]) };

  assert.equal((await captureWrites(process.stdout, () => verb.run([], ctx))).value, 0);
  const before = await fileInventory(resolveStateDir(box.env));
  await unlink(path.join(box.sessionsDir, '0001.json'));

  const refused = await captureWrites(process.stderr, () => verb.run([], ctx));
  assert.equal(refused.value, 1);
  assert.match(refused.text, /^ast snapshot: writeLayout: refusing to replace 2 entries with 1\n$/);
  assert.deepEqual(await fileInventory(resolveStateDir(box.env)), before);

  const forced = await captureWrites(process.stdout, () => verb.run(['--force'], ctx));
  assert.equal(forced.value, 0);
  assert.equal(forced.text, 'snapshot: captured 1 session\n');
  assert.equal((await readLayout(resolveStateDir(box.env))).entries.length, 1);
});
