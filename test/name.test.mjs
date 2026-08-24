import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import fake from '../src/adapters/fake/index.js';
import { run as runLs } from '../src/cli/verbs/ls.js';
import { run as runName } from '../src/cli/verbs/name.js';
import { displayWidth } from '../src/core/width.js';
import { openStore, readSessions } from '../src/io/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_ID = 'fake-0001';
const SESSION_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function recordFor(overrides = {}) {
  return {
    id: SESSION_ULID,
    adapter: 'fake',
    agent: { sessionId: SESSION_ID },
    observed: { status: 'idle', waitingFor: null, lastSeen: 1, generation: 1 },
    state: 'Unbound',
    flags: { parked: false, attentionStuck: false, writeDisabled: true, reason: null },
    prov: {},
    ...overrides,
  };
}

async function scratch(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function setupRecord(record = recordFor()) {
  const tmp = await scratch('ast-name-');
  const env = { PATH: process.env.PATH ?? '', HOME: tmp, XDG_STATE_HOME: tmp, TERM: 'dumb' };
  const store = await openStore({ env });
  await store.writeSession(record.id, record);
  const filePath = path.join(store.stateDir, 'sessions', `${record.id}.json`);
  return { env, store, filePath, record };
}

/**
 * @param {(argv: string[], ctx: { env: object, adapters: Map<string, unknown>, root: string }) => Promise<number>} run
 * @param {string[]} argv
 * @param {object} env
 * @param {{ now?: number }} [options]
 */
async function runDirect(run, argv, env, { now } = {}) {
  let stdout = '';
  let stderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalNow = Date.now;
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  if (now !== undefined) Date.now = () => now;

  try {
    const code = await run(argv, { env, adapters: new Map([[fake.id, fake]]), root: ROOT });
    return { code, stdout, stderr };
  } finally {
    Date.now = originalNow;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

async function storedRecord(store) {
  const read = await readSessions(store.stateDir);
  assert.deepEqual(read.errors, []);
  assert.equal(read.records.length, 1);
  return read.records[0].record;
}

test('ast name persists an owned display name and provenance', async () => {
  const box = await setupRecord();

  const result = await runDirect(runName, [SESSION_ID, 'daily driver'], box.env, { now: 1111 });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'fake-0001 -> daily driver\n');
  const stored = await storedRecord(box.store);
  assert.equal(stored.name, 'daily driver');
  assert.deepEqual(stored.prov.name, { source: 'human', confidence: 'high', at: 1111 });
});

test('renaming twice keeps the last name and updates provenance time', async () => {
  const box = await setupRecord();

  assert.equal((await runDirect(runName, [SESSION_ID, 'first'], box.env, { now: 1111 })).code, 0);
  assert.equal((await runDirect(runName, [SESSION_ID, 'second'], box.env, { now: 2222 })).code, 0);

  const stored = await storedRecord(box.store);
  assert.equal(stored.name, 'second');
  assert.deepEqual(stored.prov.name, { source: 'human', confidence: 'high', at: 2222 });
});

test('invalid names refuse beside accepting controls without changing session bytes', async () => {
  for (const { invalid, valid, pattern } of [
    { invalid: '', valid: 'empty allowed only with text', pattern: /empty or whitespace-only/ },
    { invalid: '   ', valid: 'spaced label', pattern: /empty or whitespace-only/ },
    { invalid: 'line\nbreak', valid: 'line break', pattern: /control character/ },
    { invalid: 'tab\tbreak', valid: 'tab break', pattern: /control character/ },
    { invalid: 'tmux #{pane_id}', valid: 'tmux # pane_id', pattern: /tmux format sequence/ },
  ]) {
    const box = await setupRecord();
    assert.equal((await runDirect(runName, [SESSION_ID, valid], box.env, { now: 1000 })).code, 0);
    const before = await readFile(box.filePath);

    const result = await runDirect(runName, [SESSION_ID, invalid], box.env, { now: 2000 });

    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
    assert.deepEqual(await readFile(box.filePath), before);
    assert.equal((await storedRecord(box.store)).name, valid);
  }
});

test('name length is bounded by display width instead of string length', async () => {
  const accepted = '界'.repeat(20);
  const rejected = '界'.repeat(21);
  assert.equal(accepted.length, 20);
  assert.equal(displayWidth(accepted), 40);
  assert.equal(rejected.length, 21);
  assert.equal(displayWidth(rejected), 42);
  const box = await setupRecord();

  assert.equal((await runDirect(runName, [SESSION_ID, accepted], box.env, { now: 1000 })).code, 0);
  const before = await readFile(box.filePath);
  const result = await runDirect(runName, [SESSION_ID, rejected], box.env, { now: 2000 });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /display width/);
  assert.deepEqual(await readFile(box.filePath), before);
});

test('unknown session refs resolve to refusal codes and do not write session bytes', async () => {
  const box = await setupRecord();
  const before = await readFile(box.filePath);

  const result = await runDirect(runName, ['missing', 'label'], box.env);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /no session matches "missing"/);
  assert.deepEqual(await readFile(box.filePath), before);
});

test('setting a name survives a later ast ls rewrite', async () => {
  const tmp = await scratch('ast-name-ls-');
  const fakeRoot = path.join(tmp, 'fake-root');
  await mkdir(path.join(fakeRoot, 'sessions'), { recursive: true });
  await writeFile(path.join(fakeRoot, 'sessions', '0000.json'), JSON.stringify({ id: SESSION_ID, status: 'idle' }));
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: tmp,
    XDG_STATE_HOME: tmp,
    TERM: 'dumb',
    ASTERISM_FAKE_ROOT: fakeRoot,
  };

  assert.equal((await runDirect(runLs, [], env)).code, 0);
  assert.equal((await runDirect(runName, [SESSION_ID, 'survivor'], env, { now: 1111 })).code, 0);
  const afterName = await readSessions(path.join(tmp, 'asterism'));
  assert.equal(afterName.records[0].record.name, 'survivor');

  const listed = await runDirect(runLs, [], env);

  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /survivor/);
  const afterLs = await readSessions(path.join(tmp, 'asterism'));
  assert.equal(afterLs.records[0].record.name, 'survivor');
  assert.deepEqual(afterLs.records[0].record.prov.name, { source: 'human', confidence: 'high', at: 1111 });
});
