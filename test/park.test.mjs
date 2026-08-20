import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { applyLifecycle } from '../src/core/parkstate.js';
import { run as runPark } from '../src/cli/verbs/park.js';
import { run as runUnpark } from '../src/cli/verbs/unpark.js';
import { openStore, readSessions } from '../src/io/store.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = typeof globalThis.Bun === 'undefined' ? process.execPath : globalThis.Bun.which('node');
assert.ok(NODE, 'the test runner could not locate node for direct verb invocation');

const DIRECT_RUN = `
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  const [verb, ...args] = process.argv.slice(1);
  const moduleUrl = pathToFileURL(path.resolve('src', 'cli', 'verbs', verb + '.js')).href;
  const loaded = await import(moduleUrl);
  process.exitCode = await loaded.run(args, { env: process.env, adapters: new Map(), root: process.cwd() });
`;

function recordFor(lifecycle, { id = '01ARZ3NDEKTSV4RRFFQ69G5FAV', sessionId = 'fake-0001' } = {}) {
  const record = {
    id,
    adapter: 'fake',
    agent: { sessionId },
    state: 'Bound',
    flags: { parked: lifecycle === 'Parked', attentionStuck: false, writeDisabled: false, reason: null },
    prov: {},
  };
  if (lifecycle !== undefined) record.lifecycle = lifecycle;
  return record;
}

async function setupRecord(lifecycle) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ast-park-'));
  const env = { PATH: process.env.PATH ?? '', HOME: tmp, XDG_STATE_HOME: tmp, TERM: 'dumb' };
  const store = await openStore({ env });
  const record = recordFor(lifecycle);
  await store.writeSession(record.id, record);
  const filePath = path.join(store.stateDir, 'sessions', `${record.id}.json`);
  return { env, store, filePath, record };
}

async function runVerb(verb, ref, env) {
  try {
    const { stdout, stderr } = await execFileAsync(
      NODE,
      ['--input-type=module', '--eval', DIRECT_RUN, verb, ref],
      { cwd: ROOT, encoding: 'utf8', env },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function runDirect(run, ref, env) {
  let stdout = '';
  let stderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalWrite = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };

  try {
    const code = await run([ref], { env, adapters: new Map(), root: ROOT });
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalWrite;
  }
}

async function storedRecord(store) {
  const read = await readSessions(store.stateDir);
  assert.deepEqual(read.errors, []);
  assert.equal(read.records.length, 1);
  return read.records[0].record;
}

function assertInvariant(record) {
  assert.equal(record.flags.parked, record.lifecycle === 'Parked');
}

test('applyLifecycle defaults an unparked record to Live and derives both owned fields from one transition', () => {
  const original = recordFor(undefined);
  const updated = applyLifecycle(original, 'park', { at: 4242 });

  assert.equal(Object.hasOwn(original, 'lifecycle'), false);
  assert.equal(original.flags.parked, false);
  assert.equal(updated.lifecycle, 'Parked');
  assert.equal(updated.flags.parked, true);
  assert.deepEqual(updated.prov.lifecycle, { source: 'human', confidence: 'high', at: 4242 });
  assert.equal(updated.prov['flags.parked'], updated.prov.lifecycle);
  assertInvariant(updated);
});

test('park then unpark persists the Live-Parked-Live round-trip', async () => {
  const box = await setupRecord(undefined);

  const parkedResult = await runVerb('park', 'fake-0001', box.env);
  assert.equal(parkedResult.code, 0, parkedResult.stderr);
  assert.match(parkedResult.stdout, /fake-0001.*Parked/);
  const parked = await storedRecord(box.store);
  assert.equal(parked.lifecycle, 'Parked');
  assertInvariant(parked);

  const liveResult = await runVerb('unpark', parked.id, box.env);
  assert.equal(liveResult.code, 0, liveResult.stderr);
  assert.match(liveResult.stdout, /fake-0001.*Live/);
  const live = await storedRecord(box.store);
  assert.equal(live.lifecycle, 'Live');
  assertInvariant(live);
});

test('every illegal park/unpark pair refuses with its state and preserves record bytes beside accepting controls', async () => {
  const parkedBox = await setupRecord(undefined);
  assert.equal((await runVerb('park', 'fake-0001', parkedBox.env)).code, 0);
  const parkedBefore = await readFile(parkedBox.filePath);
  const repeatedPark = await runVerb('park', 'fake-0001', parkedBox.env);
  assert.equal(repeatedPark.code, 1);
  assert.match(repeatedPark.stderr, /Parked/);
  assert.match(repeatedPark.stderr, /lifecycle: illegal transition "Parked" \+ "park"/);
  assert.deepEqual(await readFile(parkedBox.filePath), parkedBefore);
  assertInvariant(await storedRecord(parkedBox.store));

  assert.equal((await runVerb('unpark', 'fake-0001', parkedBox.env)).code, 0);
  const liveBefore = await readFile(parkedBox.filePath);
  const repeatedUnpark = await runVerb('unpark', 'fake-0001', parkedBox.env);
  assert.equal(repeatedUnpark.code, 1);
  assert.match(repeatedUnpark.stderr, /Live/);
  assert.match(repeatedUnpark.stderr, /lifecycle: illegal transition "Live" \+ "unpark"/);
  assert.deepEqual(await readFile(parkedBox.filePath), liveBefore);
  assertInvariant(await storedRecord(parkedBox.store));

  for (const verb of ['park', 'unpark']) {
    const archivedBox = await setupRecord('Archived');
    const before = await readFile(archivedBox.filePath);
    const result = await runVerb(verb, 'fake-0001', archivedBox.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Archived/);
    assert.match(result.stderr, new RegExp(`lifecycle: illegal transition "Archived" \\+ "${verb}"`));
    assert.deepEqual(await readFile(archivedBox.filePath), before);
    assertInvariant(await storedRecord(archivedBox.store));
  }
});

test('lifecycle runs resolve shaped refusals instead of rejecting on illegal transitions', async () => {
  for (const { verb, run, lifecycle } of [
    { verb: 'park', run: runPark, lifecycle: 'Parked' },
    { verb: 'unpark', run: runUnpark, lifecycle: 'Live' },
  ]) {
    const box = await setupRecord(lifecycle);
    const before = await readFile(box.filePath);

    const result = await runDirect(run, 'fake-0001', box.env);

    assert.equal(result.code, 1);
    assert.equal(result.stderr, `ast ${verb}: ${lifecycle}: lifecycle: illegal transition "${lifecycle}" + "${verb}"\n`);
    assert.deepEqual(await readFile(box.filePath), before);
    assertInvariant(await storedRecord(box.store));
  }
});

test('an inconsistent unrelated record does not block a healthy lifecycle transition', async () => {
  for (const { run, lifecycle, expected } of [
    { run: runPark, lifecycle: 'Live', expected: 'Parked' },
    { run: runUnpark, lifecycle: 'Parked', expected: 'Live' },
  ]) {
    const box = await setupRecord(lifecycle);
    const inconsistent = recordFor('Parked', {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
      sessionId: 'fake-poisoned',
    });
    inconsistent.flags.parked = false;
    await box.store.writeSession(inconsistent.id, inconsistent);

    const result = await runDirect(run, 'fake-0001', box.env);

    assert.equal(result.code, 0);
    const stored = await readSessions(box.store.stateDir);
    const healthy = stored.records.find((entry) => entry.record.id === box.record.id).record;
    const poisoned = stored.records.find((entry) => entry.record.id === inconsistent.id).record;
    assert.equal(healthy.lifecycle, expected);
    assertInvariant(healthy);
    assert.equal(poisoned.lifecycle, 'Parked');
    assert.equal(poisoned.flags.parked, false);
  }
});

test('an inconsistent target is rejected before its lifecycle or bytes change', async () => {
  for (const { run, lifecycle, parked } of [
    { run: runPark, lifecycle: 'Live', parked: true },
    { run: runUnpark, lifecycle: 'Parked', parked: false },
  ]) {
    const box = await setupRecord(lifecycle);
    box.record.flags.parked = parked;
    await box.store.writeSession(box.record.id, box.record);
    const before = await readFile(box.filePath);

    await assert.rejects(
      () => runDirect(run, 'fake-0001', box.env),
      { message: `lifecycle invariant failed for ${box.record.id}` },
    );
    assert.deepEqual(await readFile(box.filePath), before);
  }
});

test('an unknown session ref refuses without changing any session bytes', async () => {
  const box = await setupRecord(undefined);
  const before = await readFile(box.filePath);

  for (const verb of ['park', 'unpark']) {
    const result = await runVerb(verb, 'missing', box.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no session matches "missing"/);
    assert.deepEqual(await readFile(box.filePath), before);
    const unchanged = await storedRecord(box.store);
    assert.equal(Object.hasOwn(unchanged, 'lifecycle'), false);
    assert.equal(unchanged.flags.parked, false);
  }
});
