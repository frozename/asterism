import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRegistry } from '../src/adapters/index.js';
import { reconcile, statusLabel } from '../src/core/reconcile.js';
import { checkDiscoverySources, collectObservations } from '../src/io/discover.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = buildRegistry({ ASTERISM_FAKE_ROOT: path.join(ROOT, 'vectors', 'fake') });
const vendorId = [...registry.keys()].find((id) => id !== 'fake');
const vendor = registry.get(vendorId);
const MIXED_PATH = path.join(ROOT, 'vectors', vendorId, 'synthetic', 'agents-json', 'mixed.json');
const RECORD_PATH = path.join(ROOT, 'vectors', vendorId, 'synthetic', 'registry', '1234.json');
const NOW = 1_786_000_000_000;

function response(stdout, code = 0, stderr = '') {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), timedOut: false, truncated: false };
}

function successfulExecute(stdout) {
  return async () => response(stdout);
}

function mintCounter() {
  let next = 0;
  return () => `record-${++next}`;
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seedRecord(home, name, transform = (value) => value) {
  const dir = vendor.registryDir(home);
  await mkdir(dir, { recursive: true });
  const parsed = JSON.parse(await readFile(RECORD_PATH, 'utf8'));
  const record = transform(parsed);
  await writeFile(path.join(dir, name), `${JSON.stringify(record)}\n`);
  return record;
}

async function contractBytes() {
  return readFile(MIXED_PATH);
}

test('discovery parsers preserve open-world rows, waiting data, and null status', async () => {
  const mixed = vendor.parseAgentsJson(await readFile(MIXED_PATH, 'utf8'));
  assert.equal(mixed.error, null);
  assert.equal(mixed.rows.length, 5);
  assert.equal(mixed.rows.find((row) => row.status === 'waiting').waitingFor, 'input needed');
  assert.equal(mixed.rows.find((row) => row.name === 'epsilon').status, null);
  assert.deepEqual(mixed.unknownKeys, ['zetaField']);
  assert.ok(mixed.rows.every(Object.isFrozen));

  const nonArray = vendor.parseAgentsJson('{"row":1}');
  assert.equal(nonArray.rows.length, 0);
  assert.equal(typeof nonArray.error, 'string');

  const nonObjectRow = vendor.parseAgentsJson('[{"sessionId":"ok"},7]');
  assert.equal(nonObjectRow.rows.length, 1);
  assert.match(nonObjectRow.error, /index 1/);

  const clean = vendor.parseAgentsJson('[{"sessionId":"one"},{"sessionId":"two","status":"idle"}]');
  assert.equal(clean.error, null);
  assert.deepEqual(clean.unknownKeys, []);

  const parsedRecord = vendor.parseRegistryRecord(await readFile(RECORD_PATH, 'utf8'));
  assert.equal(parsedRecord.error, null);
  assert.equal(Object.keys(parsedRecord.record).length, 18);
  assert.deepEqual(parsedRecord.unknownKeys, []);
  assert.equal(vendor.parseRegistryRecord('not json').record, null);
  assert.equal(typeof vendor.parseRegistryRecord('not json').error, 'string');
});

test('argv discovery wraps contract rows and reconciliation preserves open-world canaries', async (t) => {
  const home = await tempDir(t, 'asterism-discover-argv-');
  const bytes = await contractBytes();
  const result = await collectObservations(vendor, {
    env: { PATH: '/unused', HOME: home },
    home,
    now: NOW,
    execute: successfulExecute(bytes),
  });

  assert.equal(result.notes.length, 0);
  assert.equal(result.observations.length, 5);
  for (const observation of result.observations) {
    assert.equal(observation.source, 'contract');
    assert.equal(observation.adapter, vendorId);
    assert.equal(observation.at, NOW);
    assert.ok(Object.isFrozen(observation));
  }

  const folded = await reconcile(result.observations, { now: NOW, mint: mintCounter() });
  assert.equal(folded.canaries.filter((entry) => entry.key === 'status').length, 1);
  assert.equal(folded.canaries.filter((entry) => entry.key === 'zetaField').length, 1);
  const nullRecord = folded.records.find((entry) => entry.agent.sessionId === 'sess-epsilon-0005');
  assert.equal(nullRecord.observed.status, null);
  assert.equal(statusLabel(null), 'unknown');

  const cleanBytes = JSON.stringify([
    {
      cwd: '/w/clean',
      kind: 'primary',
      name: 'clean',
      pid: 9,
      sessionId: 'clean-session',
      startedAt: '2026-08-18T12:00:00Z',
      status: 'idle',
    },
  ]);
  const clean = await collectObservations(vendor, {
    env: { PATH: '/unused', HOME: home },
    home,
    now: NOW,
    execute: successfulExecute(cleanBytes),
  });
  const cleanFold = await reconcile(clean.observations, { now: NOW, mint: mintCounter() });
  assert.equal(cleanFold.canaries.length, 0);
});

test('default process execution uses only the PATH and HOME allowlist', async (t) => {
  const home = await tempDir(t, 'asterism-discover-real-');
  const shimDir = await tempDir(t, 'asterism-discover-shim-');
  const bytes = await readFile(MIXED_PATH, 'utf8');
  const shimPath = path.join(shimDir, vendor.discoverArgv()[0]);
  await writeFile(shimPath, `#!/bin/sh\n/bin/cat <<'EOF'\n${bytes}\nEOF\n`);
  await chmod(shimPath, 0o755);

  const result = await collectObservations(vendor, {
    env: { PATH: shimDir, HOME: home, SHOULD_NOT_REACH_CHILD: 'secret' },
    home,
  });
  assert.equal(result.observations.filter((entry) => entry.source === 'contract').length, 5);
  assert.equal(result.notes.length, 0);
});

test('an unavailable contract source never reads pre-seeded enrichment', async (t) => {
  const home = await tempDir(t, 'asterism-discover-absent-');
  const emptyPath = await tempDir(t, 'asterism-discover-empty-path-');
  await seedRecord(home, '111.json', (record) => ({ ...record, pid: 111 }));

  const absent = await collectObservations(vendor, { env: { PATH: emptyPath, HOME: home }, home });
  assert.deepEqual(absent.observations, []);
  assert.ok(absent.notes.some((entry) => entry.note === 'adapter-unavailable'));
  assert.equal(absent.observations.some((entry) => entry.source === 'registry-file'), false);

  const shimDir = await tempDir(t, 'asterism-discover-seeded-shim-');
  const shimPath = path.join(shimDir, vendor.discoverArgv()[0]);
  const bytes = await readFile(MIXED_PATH, 'utf8');
  await writeFile(shimPath, `#!/bin/sh\n/bin/cat <<'EOF'\n${bytes}\nEOF\n`);
  await chmod(shimPath, 0o755);
  const available = await collectObservations(vendor, { env: { PATH: shimDir, HOME: home }, home });
  assert.equal(available.observations.filter((entry) => entry.source === 'registry-file').length, 1);
});

test('registry enrichment merges a protocol-one canonical record', async (t) => {
  const home = await tempDir(t, 'asterism-discover-enrich-');
  await seedRecord(home, '111.json', (record) => ({ ...record, pid: 111 }));

  const result = await collectObservations(vendor, {
    env: { PATH: '/unused', HOME: home },
    home,
    now: NOW,
    execute: successfulExecute(await contractBytes()),
  });
  const folded = await reconcile(result.observations, { now: NOW, mint: mintCounter() });
  const enriched = folded.records.find((entry) => entry.agent.sessionId === 'sess-alpha-0001');

  assert.equal(enriched.flags.writeDisabled, false);
  assert.equal(enriched.prov.procStart.source, 'registry-file');
});

test('registry enrichment gates peer protocol, byte size, and canonical filenames', async (t) => {
  const home = await tempDir(t, 'asterism-discover-gates-');
  await seedRecord(home, '111.json', (record) => ({ ...record, pid: 111 }));
  await seedRecord(home, '2222.json', (record) => ({
    ...record,
    pid: 2222,
    sessionId: 'peer-two-session',
    peerProtocol: 2,
  }));
  await seedRecord(home, '3333.json', (record) => ({
    ...record,
    pid: 3333,
    sessionId: 'oversized-session',
    padding: 'x'.repeat(vendor.ENRICHMENT.maxFileBytes),
  }));
  await seedRecord(home, 'evil.json', (record) => ({ ...record, pid: 901, sessionId: 'evil-session' }));
  await seedRecord(home, '12a4.json', (record) => ({ ...record, pid: 902, sessionId: 'mixed-name-session' }));

  const result = await collectObservations(vendor, {
    env: { PATH: '/unused', HOME: home },
    home,
    execute: successfulExecute(await contractBytes()),
  });
  const registryRows = result.observations.filter((entry) => entry.source === 'registry-file');
  assert.equal(registryRows.length, 1);
  assert.equal(registryRows[0].fields.pid, 111);
  const peerNote = result.notes.find((entry) => entry.note === 'enrichment-peer-protocol');
  assert.match(peerNote.detail, /2222\.json/);
  assert.match(peerNote.detail, /2/);
  assert.match(peerNote.detail, /1/);
  const capNote = result.notes.find((entry) => entry.note === 'enrichment-file-too-large');
  assert.match(capNote.detail, /3333\.json/);
});

test('missing enrichment preserves contract session ids and makes every record read-only', async (t) => {
  const home = await tempDir(t, 'asterism-discover-no-registry-');
  const result = await collectObservations(vendor, {
    env: { PATH: '/unused', HOME: home },
    home,
    execute: successfulExecute(await contractBytes()),
  });
  const folded = await reconcile(result.observations, { now: NOW, mint: mintCounter() });
  const ids = folded.records.map((entry) => entry.agent.sessionId).sort();
  assert.deepEqual(ids, [
    'sess-alpha-0001',
    'sess-beta-0002',
    'sess-delta-0004',
    'sess-epsilon-0005',
    'sess-gamma-0003',
  ]);
  for (const record of folded.records) {
    assert.equal(Object.hasOwn(record.prov, 'procStart'), false);
    assert.equal(record.flags.writeDisabled, true);
    assert.match(record.flags.reason, /procStart/);
  }
});

test('function discovery maps fake sidecars and fails closed on a malformed file', async (t) => {
  const root = await tempDir(t, 'asterism-discover-function-');
  await mkdir(path.join(root, 'sessions'));
  await writeFile(path.join(root, 'sessions', '0001.json'), '{ "id": "fake-0001", "status": "idle" }\n');
  const adapter = buildRegistry({ ASTERISM_FAKE_ROOT: root }).get('fake');
  const env = { ASTERISM_FAKE_ROOT: root };

  const valid = await collectObservations(adapter, { env, home: root, now: NOW });
  assert.equal(valid.notes.length, 0);
  assert.equal(valid.observations.length, 1);
  assert.equal(valid.observations[0].source, 'contract');
  assert.equal(valid.observations[0].adapter, 'fake');
  assert.equal(valid.observations[0].fields.sessionId, 'fake-0001');

  await writeFile(path.join(root, 'sessions', '0002.json'), 'nope');
  const malformed = await collectObservations(adapter, { env, home: root, now: NOW });
  assert.deepEqual(malformed.observations, []);
  assert.ok(malformed.notes.some((entry) => entry.note === 'adapter-unavailable'));
});

test('checkDiscoverySources reports unavailable, matching, and disagreement states', async (t) => {
  const unavailableHome = await tempDir(t, 'asterism-discovery-check-unavailable-');
  const unavailable = await checkDiscoverySources(vendor, {
    env: { PATH: '/unused', HOME: unavailableHome },
    home: unavailableHome,
    execute: async () => {
      throw new Error('absent');
    },
  });
  assert.equal(unavailable.status, 'unknown');

  const matchedHome = await tempDir(t, 'asterism-discovery-check-match-');
  await seedRecord(matchedHome, '111.json', (record) => ({ ...record, pid: 111 }));
  const matched = await checkDiscoverySources(vendor, {
    env: { PATH: '/unused', HOME: matchedHome },
    home: matchedHome,
    execute: successfulExecute(await contractBytes()),
  });
  assert.equal(matched.status, 'pass');

  const mismatchHome = await tempDir(t, 'asterism-discovery-check-mismatch-');
  await seedRecord(mismatchHome, '1234.json');
  const mismatch = await checkDiscoverySources(vendor, {
    env: { PATH: '/unused', HOME: mismatchHome },
    home: mismatchHome,
    execute: successfulExecute(await contractBytes()),
  });
  assert.equal(mismatch.status, 'fail');
  assert.match(mismatch.detail, /pid/);
  assert.match(mismatch.detail, /sess-alpha-0001/);
});

test('collectObservations rejects an adapter with no discovery contract', async () => {
  await assert.rejects(() => collectObservations({ id: 'none' }, { env: {}, home: '/unused' }), TypeError);
});
