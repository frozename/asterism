import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRegistry } from '../src/adapters/index.js';
import fake from '../src/adapters/fake/index.js';
import { collectSessions, resolveSessionRef, stableIds } from '../src/cli/pipeline.js';
import { applyLifecycle } from '../src/core/parkstate.js';
import { ULID_PATTERN } from '../src/core/ulid.js';
import { openStore, readArchive, readSessions } from '../src/io/store.js';

async function scratch(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fakeRoot(rows) {
  const root = await scratch('ast-pipeline-fake-');
  const sessionsDir = path.join(root, 'sessions');
  await mkdir(sessionsDir);
  for (let index = 0; index < rows.length; index += 1) {
    await writeFile(path.join(sessionsDir, `${String(index).padStart(4, '0')}.json`), JSON.stringify(rows[index]));
  }
  return root;
}

async function setup(rows) {
  const tmp = await scratch('ast-pipeline-state-');
  const root = await fakeRoot(rows);
  const env = { ASTERISM_FAKE_ROOT: root, HOME: tmp, XDG_STATE_HOME: tmp };
  const store = await openStore({ env });
  const adapters = new Map([[fake.id, fake]]);
  return { tmp, root, env, store, adapters };
}

test('collectSessions discovers fake rows and preserves their ids across persisted runs', async () => {
  const setupData = await setup([
    { id: 'fake-0001', status: 'idle' },
    { id: 'fake-0002', status: 'waiting', waitingFor: 'input' },
  ]);
  const first = await collectSessions(setupData);
  assert.equal(first.records.length, 2);
  assert.deepEqual(first.records.map((record) => record.observed.status).sort(), ['idle', 'waiting']);
  assert.deepEqual(first.notes, []);
  assert.ok(first.records.every((record) => ULID_PATTERN.test(record.id)));

  await writeFile(
    path.join(setupData.root, 'sessions', '0002.json'),
    JSON.stringify({ id: 'fake-0003', status: 'busy' }),
  );
  const second = await collectSessions(setupData);
  const firstIds = new Map(first.records.map((record) => [record.agent.sessionId, record.id]));
  for (const record of second.records.filter((entry) => firstIds.has(entry.agent.sessionId))) {
    assert.equal(record.id, firstIds.get(record.agent.sessionId));
  }
  const added = second.records.find((record) => record.agent.sessionId === 'fake-0003');
  assert.ok(added);
  assert.match(added.id, ULID_PATTERN);
  assert.equal([...firstIds.values()].includes(added.id), false);
});

test('collectSessions does not mint or re-materialise a still-live archived session', async () => {
  const setupData = await setup([{ id: 'fake-0001', status: 'idle' }]);
  const first = await collectSessions(setupData);
  const archived = { ...first.records[0], lifecycle: 'Archived' };
  await setupData.store.archiveSession(archived.id, archived);
  const archiveFile = path.join(setupData.store.stateDir, 'archive', `${archived.id}.json`);
  const archiveBefore = await readFile(archiveFile);
  let mintCalls = 0;

  const second = await collectSessions({
    ...setupData,
    mint: () => {
      mintCalls += 1;
      return '01ARZ3NDEKTSV4RRFFQ69G5FAA';
    },
  });

  assert.equal(mintCalls, 0);
  assert.deepEqual(second.records, []);
  assert.deepEqual(await readdir(path.join(setupData.store.stateDir, 'sessions')), []);
  assert.deepEqual(await readFile(archiveFile), archiveBefore);
  assert.equal((await readArchive(setupData.store.stateDir)).records.length, 1);
});

test('stableIds re-keys matching records and leaves a new group untouched', () => {
  const records = [
    { id: 'new-a', adapter: 'fake', agent: { sessionId: 'a' }, observed: { status: 'idle', lastSeen: 1 } },
    { id: 'new-b', adapter: 'fake', agent: { sessionId: 'b' }, observed: { status: 'idle', lastSeen: 1 } },
  ];
  const prior = [{ record: { id: 'old-a', adapter: 'fake', agent: { sessionId: 'a' } } }];
  const result = stableIds(records, prior);
  assert.equal(result.find((record) => record.agent.sessionId === 'a').id, 'old-a');
  assert.equal(result.find((record) => record.agent.sessionId === 'b').id, 'new-b');
});

test('collectSessions preserves lifecycle-owned fields and provenance from a parked record', async () => {
  const setupData = await setup([{ id: 'fake-0001', status: 'idle' }]);
  const first = await collectSessions(setupData);
  const parked = applyLifecycle(first.records[0], 'park', { at: 4242 });
  await setupData.store.writeSession(parked.id, parked);

  const reconciled = await collectSessions(setupData);
  assert.equal(reconciled.records.length, 1);
  assert.equal(reconciled.records[0].lifecycle, 'Parked');
  assert.equal(reconciled.records[0].flags.parked, true);
  assert.deepEqual(reconciled.records[0].prov.lifecycle, parked.prov.lifecycle);
  assert.deepEqual(reconciled.records[0].prov['flags.parked'], parked.prov['flags.parked']);

  const persisted = await readSessions(setupData.store.stateDir);
  assert.deepEqual(persisted.errors, []);
  assert.equal(persisted.records[0].record.lifecycle, 'Parked');
  assert.equal(persisted.records[0].record.flags.parked, true);
});

test('collectSessions preserves a prior Bound state, binding, and their provenance', async () => {
  const setupData = await setup([{ id: 'fake-0001', status: 'idle' }]);
  const first = await collectSessions(setupData);
  const prior = first.records[0];
  const binding = Object.freeze({
    serverPid: 4242,
    tmuxSession: null,
    windowId: null,
    paneId: '%7',
    by: 'SpawnMinted',
    at: '2026-08-20T00:00:00.000Z',
  });
  const stateProv = Object.freeze({ source: 'spawn-minted', confidence: 'authoritative', at: 1 });
  const bindingProv = Object.freeze({ source: 'spawn-minted', confidence: 'authoritative', at: 2 });
  await setupData.store.writeSession(prior.id, {
    ...prior,
    state: 'Bound',
    binding,
    prov: { ...prior.prov, state: stateProv, binding: bindingProv },
  });

  const second = await collectSessions(setupData);
  assert.equal(second.records[0].id, prior.id);
  assert.equal(second.records[0].state, 'Bound');
  assert.deepEqual(second.records[0].binding, binding);
  assert.deepEqual(second.records[0].prov.state, stateProv);
  assert.deepEqual(second.records[0].prov.binding, bindingProv);

  const persisted = await readSessions(setupData.store.stateDir);
  assert.deepEqual(persisted.errors, []);
  assert.equal(persisted.records[0].record.state, 'Bound');
  assert.deepEqual(persisted.records[0].record.binding, binding);
});

test('collectSessions preserves asterism-owned name and provenance across rewrites', async () => {
  const setupData = await setup([{ id: 'fake-0001', status: 'idle' }]);
  const first = await collectSessions(setupData);
  const named = Object.freeze({
    ...first.records[0],
    name: 'human label',
    prov: Object.freeze({
      ...first.records[0].prov,
      name: Object.freeze({ source: 'human', confidence: 'high', at: 4242 }),
    }),
  });
  await setupData.store.writeSession(named.id, named);

  const reconciled = await collectSessions(setupData);
  assert.equal(reconciled.records.length, 1);
  assert.equal(reconciled.records[0].name, 'human label');
  assert.deepEqual(reconciled.records[0].prov.name, named.prov.name);

  const persisted = await readSessions(setupData.store.stateDir);
  assert.deepEqual(persisted.errors, []);
  assert.equal(persisted.records[0].record.name, 'human label');
  assert.deepEqual(persisted.records[0].record.prov.name, named.prov.name);
});

test('collectSessions projects vendor names separately from asterism-owned names', async () => {
  const setupData = await setup([{ id: 'fake-0001', status: 'idle', name: 'vendor label', nameSource: 'user' }]);

  const reconciled = await collectSessions(setupData);

  assert.equal(Object.hasOwn(reconciled.records[0], 'name'), false);
  assert.equal(reconciled.records[0].agent.name, 'vendor label');
  assert.equal(reconciled.records[0].prov['agent.name'].source, 'contract');
});

test('binding spool increments generation and corrupt bindings are reported without losing sessions', async () => {
  const setupData = await setup([
    { id: 'fake-0001', status: 'idle' },
    { id: 'fake-0002', status: 'idle' },
  ]);
  const first = await collectSessions(setupData);
  const target = first.records.find((record) => record.agent.sessionId === 'fake-0001');
  await setupData.store.writeBinding(target.id, { target: '%5', adapter: 'fake', sessionId: 'fake-0001' });

  const clean = await collectSessions(setupData);
  const enriched = clean.records.find((record) => record.agent.sessionId === 'fake-0001');
  const sibling = clean.records.find((record) => record.agent.sessionId === 'fake-0002');
  assert.equal(enriched.observed.generation, sibling.observed.generation + 1);
  assert.equal(clean.notes.some((note) => note.note === 'binding-unreadable'), false);

  await writeFile(path.join(setupData.store.stateDir, 'bindings', 'corrupt.bind'), '{ nope');
  const degraded = await collectSessions(setupData);
  assert.equal(degraded.records.length, 2);
  assert.ok(degraded.notes.some((note) => note.note === 'binding-unreadable' && note.detail.includes('corrupt.bind')));
});

test('collectSessions reports unreadable archive records without losing live sessions', async () => {
  const setupData = await setup([{ id: 'fake-0001', status: 'idle' }]);
  await writeFile(path.join(setupData.store.stateDir, 'archive', 'broken.json'), '{ nope');

  const degraded = await collectSessions(setupData);

  assert.equal(degraded.records.length, 1);
  assert.ok(
    degraded.notes.some(
      (note) =>
        note.adapter === 'store' &&
        note.note === 'archive-unreadable' &&
        note.detail.startsWith('broken.json: ') &&
        note.detail.length > 'broken.json: '.length,
    ),
    JSON.stringify(degraded.notes),
  );
});

test('unavailable argv adapter becomes a note while function adapter rows remain', async () => {
  const setupData = await setup([{ id: 'fake-0001', status: 'idle' }]);
  const adapters = buildRegistry({ ASTERISM_FAKE_ROOT: setupData.root });
  const result = await collectSessions({
    ...setupData,
    adapters,
    env: { PATH: '', HOME: setupData.tmp, ASTERISM_FAKE_ROOT: setupData.root },
  });
  assert.ok(result.notes.some((note) => note.note === 'adapter-unavailable' && note.adapter !== 'fake'));
  assert.ok(result.records.some((record) => record.adapter === 'fake'));
});

test('pid observations use one batched process-table call and pid-free input uses none', async () => {
  const withPid = await setup([{ id: 'fake-0001', status: 'idle', pid: 4242 }]);
  const calls = [];
  const execute = async (argv, options) => {
    calls.push({ argv, options });
    return { code: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
  };
  await collectSessions({ ...withPid, execute });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['ps', '-o', 'pid=,lstart=', '-p', '4242']);

  const withoutPid = await setup([{ id: 'fake-0002', status: 'idle' }]);
  const emptyCalls = [];
  await collectSessions({
    ...withoutPid,
    execute: async (...args) => {
      emptyCalls.push(args);
      return { code: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    },
  });
  assert.equal(emptyCalls.length, 0);
});

test('resolveSessionRef handles exact, prefix, ambiguous, and absent references', () => {
  const records = [
    { id: '01ALPHA', agent: { sessionId: 'worker-alpha' } },
    { id: '01BETA', agent: { sessionId: 'worker-beta' } },
    { id: '01GAMMA', agent: { sessionId: 'workshop' } },
  ];

  assert.equal(resolveSessionRef(records, '01ALPHA').record, records[0]);
  assert.equal(resolveSessionRef(records, 'worker-beta').record, records[1]);
  assert.equal(resolveSessionRef(records, '01G').record, records[2]);
  assert.equal(resolveSessionRef(records, 'worker-a').record, records[0]);
  assert.deepEqual(resolveSessionRef(records, 'work'), {
    error: 'ambiguous session ref "work": matches 01ALPHA, 01BETA, 01GAMMA',
  });
  assert.deepEqual(resolveSessionRef(records, 'missing'), { error: 'no session matches "missing"' });
});
