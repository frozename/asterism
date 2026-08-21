import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as reconcileCore from '../src/core/reconcile.js';
import {
  compareRecords,
  reconcile,
  statusLabel,
} from '../src/core/reconcile.js';
import { createUlidMinter, ULID_PATTERN } from '../src/core/ulid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS_DIR = path.join(ROOT, 'vectors', 'reconcile');

function loadVector(name) {
  return JSON.parse(readFileSync(path.join(VECTORS_DIR, name), 'utf8'));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function seededMinter() {
  let counter = 0;
  return createUlidMinter({
    now: () => 1_000_000 + counter++,
    random: (n) => {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) bytes[i] = (i * 7 + 1) % 256;
      return bytes;
    },
  });
}

// ---- field disposition ledger ----

test('field disposition ledger is deeply frozen and gives every known field a non-empty reason', () => {
  const { FIELD_DISPOSITION_LEDGER, KNOWN_FIELDS } = reconcileCore;
  assert.ok(Array.isArray(FIELD_DISPOSITION_LEDGER), 'FIELD_DISPOSITION_LEDGER must exist as an array');
  assert.ok(Object.isFrozen(FIELD_DISPOSITION_LEDGER));
  assert.deepEqual(KNOWN_FIELDS, FIELD_DISPOSITION_LEDGER.map((entry) => entry.key));

  for (const entry of FIELD_DISPOSITION_LEDGER) {
    assert.ok(Object.isFrozen(entry), `${entry.key} ledger entry should be frozen`);
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.trim().length > 0, `${entry.key} should have a non-empty disposition reason`);
  }

  const peerFeatures = FIELD_DISPOSITION_LEDGER.find((entry) => entry.key === 'peerFeatures');
  assert.deepEqual(peerFeatures, {
    key: 'peerFeatures',
    disposition: 'deliberately-not-projected',
    reason:
      'The peer\'s advertised capability list was ["notify_idle"] in every live registry record beside peerProtocol. Asterism does not consume registry self-reports today: src/core/caps.js is populated by probes. Project this field only after probe-backed capabilities explicitly reconcile the advertisement.',
    deferredTo: 'probe-backed-peer-feature-reconciliation',
  });
});

test('field disposition ledger and PROJECTED_FIELDS agree in both directions', () => {
  const { fieldDispositionViolations, FIELD_DISPOSITION_LEDGER, PROJECTED_FIELDS } = reconcileCore;
  assert.equal(typeof fieldDispositionViolations, 'function', 'fieldDispositionViolations must exist');
  assert.deepEqual(fieldDispositionViolations(FIELD_DISPOSITION_LEDGER, PROJECTED_FIELDS), []);
});

test('field disposition ledger has no duplicate keys', () => {
  const { fieldDispositionViolations, FIELD_DISPOSITION_LEDGER, PROJECTED_FIELDS } = reconcileCore;
  assert.equal(typeof fieldDispositionViolations, 'function', 'fieldDispositionViolations must exist');
  const violations = fieldDispositionViolations(
    [...FIELD_DISPOSITION_LEDGER, FIELD_DISPOSITION_LEDGER[0]],
    PROJECTED_FIELDS,
  );
  assert.ok(violations.some((violation) => violation.includes('duplicate')));
});

test('control: field ledger audit flags empty reasons and both projection mismatches while a valid ledger passes', () => {
  const { fieldDispositionViolations } = reconcileCore;
  assert.equal(typeof fieldDispositionViolations, 'function', 'fieldDispositionViolations must exist');

  const validLedger = [
    { key: 'alpha', disposition: 'projected', reason: 'alpha is part of the normalized record' },
    { key: 'beta', disposition: 'deliberately-not-projected', reason: 'beta has no normalized destination' },
  ];
  assert.deepEqual(fieldDispositionViolations(validLedger, ['alpha']), []);

  const emptyReason = fieldDispositionViolations(
    [{ key: 'alpha', disposition: 'projected', reason: '' }],
    ['alpha'],
  );
  assert.ok(emptyReason.some((violation) => violation.includes('reason')), 'empty reason was not flagged');

  const missingProjectedField = fieldDispositionViolations(validLedger, []);
  assert.ok(
    missingProjectedField.some((violation) => violation.includes('PROJECTED_FIELDS omits "alpha"')),
    'ledger-to-PROJECTED_FIELDS mismatch was not flagged',
  );

  const wronglyProjectedField = fieldDispositionViolations(validLedger, ['alpha', 'beta']);
  assert.ok(
    wronglyProjectedField.some((violation) => violation.includes('PROJECTED_FIELDS includes "beta"')),
    'PROJECTED_FIELDS-to-ledger mismatch was not flagged',
  );
});

// ---- RED 6 (synthetic): fold determinism ----

test('RED 6 (synthetic): fold determinism -- batched vs shuffled-async-iterator input produce identical output', async () => {
  const vector = loadVector('basic.json');
  const now = 5_000_000;

  const observationsA = deepFreeze(structuredClone(vector.observations));
  const runA = await reconcile(observationsA, { now, mint: seededMinter() });

  const permutedOrder = [...vector.observations.keys()].reverse();
  const observationsB = permutedOrder.map((index) => structuredClone(vector.observations[index]));
  deepFreeze(observationsB);

  async function* asyncPermuted(list) {
    for (const item of list) {
      await Promise.resolve();
      yield item;
    }
  }

  const runB = await reconcile(asyncPermuted(observationsB), { now, mint: seededMinter() });

  assert.deepEqual(runA, runB);

  // Order-dependent control (must hit): a deliberately order-dependent fold
  // (last-arrival-wins, no sort) over the same two orders must disagree --
  // proving the permutation really does reorder the contended field, which is
  // what makes the deepEqual above load-bearing rather than a vacuous pass.
  function lastArrivalWinsFold(list) {
    const map = new Map();
    for (const observation of list) map.set(observation.fields.sessionId, observation.fields);
    return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  const orderDependentForward = lastArrivalWinsFold(vector.observations);
  const orderDependentReversed = lastArrivalWinsFold(permutedOrder.map((index) => vector.observations[index]));
  assert.notDeepEqual(orderDependentForward, orderDependentReversed);
});

// ---- RED 9 (synthetic): open-world ----

test('RED 9 (synthetic): open-world -- an unknown key and a null status each land exactly one canary, never a throw', async () => {
  const vector = loadVector('open-world.json');
  const observations = deepFreeze(structuredClone(vector.observations));

  const result = await reconcile(observations, { now: 9000, mint: seededMinter() });

  assert.equal(result.canaries.length, 2);
  const pairs = result.canaries.map((c) => `${c.adapter}:${c.key}`).sort();
  const expectedPairs = vector.expect.canaries.map((c) => `${c.adapter}:${c.key}`).sort();
  assert.deepEqual(pairs, expectedPairs);

  const nullStatusRecord = result.records.find((r) => r.agent.sessionId === vector.expect.nullStatusSessionId);
  assert.equal(nullStatusRecord.observed.status, null);
  assert.equal(statusLabel(nullStatusRecord.observed.status), 'unknown');
  assert.equal(statusLabel('busy'), 'busy'); // pass-through control

  const cleanRecord = result.records.find((r) => r.agent.sessionId === vector.expect.cleanSessionId);
  assert.ok(cleanRecord, 'the clean session must still produce a record'); // must-pass control
  assert.equal(result.records.length, vector.observations.length);
});

// ---- RED 8 (synthetic): enrichment-absent ----

test('RED 8 (synthetic): enrichment-absent -- no procStart anywhere means no synthesized epoch, record is read-only', async () => {
  const vector = loadVector('enrichment-absent.json');
  const observations = deepFreeze(structuredClone(vector.observations));

  const result = await reconcile(observations, { now: 4242, mint: seededMinter() });

  assert.equal(result.records.length, vector.expect.sessionIds.length);
  const serialized = JSON.stringify(result.records);
  assert.ok(!/"procStartEpoch":\d/.test(serialized), 'procStartEpoch must never be synthesized as a number');

  for (const record of result.records) {
    assert.ok(vector.expect.sessionIds.includes(record.agent.sessionId));
    assert.equal(record.agent.procStartEpoch, null);
    assert.equal(record.flags.writeDisabled, true);
    assert.ok(record.flags.reason.includes('procStart'));
    assert.equal(record.prov.liveness.source, 'pid-only');
  }
});

test('control: basic.json enriched session has a real procStartEpoch, writeDisabled false, prov.liveness proc-start', async () => {
  const vector = loadVector('basic.json');
  const observations = deepFreeze(structuredClone(vector.observations));
  const result = await reconcile(observations, { now: 5000, mint: seededMinter() });

  const enriched = result.records.find((r) => r.agent.sessionId === vector.expect.enrichedSessionId);
  assert.equal(enriched.agent.procStartEpoch, vector.expect.procStartEpoch);
  assert.equal(enriched.flags.writeDisabled, false);
  assert.equal(enriched.flags.reason, null);
  assert.equal(enriched.prov.liveness.source, 'proc-start');
});

// ---- merge precedence ----

test('merge precedence: the contended field in basic.json resolves to the expected winner', async () => {
  const vector = loadVector('basic.json');
  const observations = deepFreeze(structuredClone(vector.observations));
  const result = await reconcile(observations, { now: 5000, mint: seededMinter() });

  const record = result.records.find((r) => r.agent.sessionId === vector.expect.contendedSessionId);
  assert.equal(record.agent[vector.expect.contendedField], vector.expect.contendedWinnerValue);
  assert.equal(record.prov[vector.expect.contendedField].source, vector.expect.contendedWinnerSource);
});

// ---- compareRecords ----

test('compareRecords: sorting basic.json records yields the vector expected order (waiting first)', async () => {
  const vector = loadVector('basic.json');
  const observations = deepFreeze(structuredClone(vector.observations));
  const result = await reconcile(observations, { now: 5000, mint: seededMinter() });

  assert.deepEqual(result.records.map((r) => r.agent.sessionId), vector.expect.order);
  assert.deepEqual(
    result.records.map((r) => r.observed.status),
    vector.expect.order.map((sessionId) => vector.expect.statuses[sessionId]),
  );
});

test('compareRecords: tie on status ranks newer lastSeen first', () => {
  const a = { id: 'A', observed: { status: 'busy', lastSeen: 100 } };
  const b = { id: 'B', observed: { status: 'busy', lastSeen: 200 } };
  assert.deepEqual([a, b].sort(compareRecords), [b, a]);
});

test('compareRecords: two identical rank/lastSeen records order by id ascending (determinism control)', () => {
  const a = { id: 'B', observed: { status: 'idle', lastSeen: 100 } };
  const b = { id: 'A', observed: { status: 'idle', lastSeen: 100 } };
  assert.deepEqual([a, b].sort(compareRecords), [b, a]);
});

// ---- envelope failures ----

test('reconcile rejects a bad envelope: unknown source, non-numeric at, non-object fields -- beside a clean control', async () => {
  await assert.rejects(
    () => reconcile([{ source: 'bogus', adapter: 'alpha', at: 1, fields: {} }], { now: 1, mint: seededMinter() }),
    TypeError,
  );
  await assert.rejects(
    () =>
      reconcile([{ source: 'contract', adapter: 'alpha', at: 'nope', fields: {} }], {
        now: 1,
        mint: seededMinter(),
      }),
    TypeError,
  );
  await assert.rejects(
    () =>
      reconcile([{ source: 'contract', adapter: 'alpha', at: 1, fields: null }], { now: 1, mint: seededMinter() }),
    TypeError,
  );

  const clean = await reconcile([{ source: 'contract', adapter: 'alpha', at: 1, fields: { sessionId: 's' } }], {
    now: 1,
    mint: seededMinter(),
  });
  assert.equal(clean.records.length, 1);
});

// ---- missing sessionId ----

test('a missing sessionId lands one sessionId canary, record count unchanged, no throw', async () => {
  const observations = [
    { source: 'contract', adapter: 'alpha', at: 1, fields: { status: 'busy' } },
    { source: 'contract', adapter: 'alpha', at: 1, fields: { sessionId: 'ok-session', status: 'idle' } },
  ];
  const result = await reconcile(observations, { now: 1, mint: seededMinter() });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].agent.sessionId, 'ok-session');
  assert.equal(result.canaries.filter((c) => c.key === 'sessionId').length, 1);
});

// ---- ULID unit cases ----

test('ULID_PATTERN matches a minted id', () => {
  const mint = createUlidMinter({ now: () => 1469918176385, random: () => new Uint8Array(10) });
  assert.match(mint(), ULID_PATTERN);
});

test('ULID time prefix is exactly 01ARYZ6S41 at the known vector timestamp', () => {
  const mint = createUlidMinter({ now: () => 1469918176385, random: () => new Uint8Array(10) });
  assert.equal(mint().slice(0, 10), '01ARYZ6S41');
});

test('same-ms double mint strictly increases with an identical 10-char prefix', () => {
  const mint = createUlidMinter({ now: () => 1469918176385, random: () => new Uint8Array(10) });
  const first = mint();
  const second = mint();
  assert.equal(second.slice(0, 10), first.slice(0, 10));
  assert.ok(second > first);
});

test('clock regression still strictly increases', () => {
  const times = [1000, 500];
  let calls = 0;
  const mint = createUlidMinter({ now: () => times[calls++], random: () => new Uint8Array(10) });
  const first = mint();
  const second = mint();
  assert.ok(second > first);
});

test('two fresh minters with identical injected inputs mint identical first ULIDs (determinism control)', () => {
  const factory = () => createUlidMinter({ now: () => 1469918176385, random: () => new Uint8Array(10) });
  assert.equal(factory()(), factory()());
});

test('createUlidMinter throws when now or random is missing or not a function', () => {
  assert.throws(() => createUlidMinter({ now: () => 1, random: null }), TypeError);
  assert.throws(() => createUlidMinter({ now: null, random: () => new Uint8Array(10) }), TypeError);
  assert.throws(() => createUlidMinter({}), TypeError);
});

// ---- benchmark ----

test('benchmark: 200 synthetic session groups fold within 30ms wall time', async () => {
  const observations = [];
  for (let i = 0; i < 200; i += 1) {
    const sessionId = `bench-${String(i).padStart(4, '0')}`;
    observations.push({ source: 'contract', adapter: 'alpha', at: 1000 + i, fields: { sessionId, status: 'idle', pid: i } });
    observations.push({
      source: 'registry-file',
      adapter: 'alpha',
      at: 1000 + i + 1,
      fields: { sessionId, pid: i + 10000 },
    });
  }

  const start = performance.now();
  await reconcile(observations, { now: 999999, mint: seededMinter() });
  const elapsed = performance.now() - start;

  assert.ok(elapsed <= 30, `reconcile of ${observations.length} observations took ${elapsed}ms, expected <= 30ms`);
});
