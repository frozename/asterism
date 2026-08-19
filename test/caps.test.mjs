import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AXES,
  atLeast,
  compareVersions,
  GATED_AXES_BY_PHASE,
  GRADES,
  gatedUnknowns,
  rank,
  UNKNOWN,
  unknownAxes,
  validateRecord,
} from '../src/core/caps.js';

function validRecord() {
  const record = {};
  for (const axis of Object.keys(AXES)) {
    record[axis] = {
      value: AXES[axis][0],
      evidence: { grade: 'C', probe: `probe for ${axis}`, observedOn: '2026-01-01' },
    };
  }
  return record;
}

// ---- AXES / GRADES ----

test('AXES is frozen and every rung list is frozen, non-empty, and unique', () => {
  assert.ok(Object.isFrozen(AXES));
  for (const [axis, rungs] of Object.entries(AXES)) {
    assert.ok(Object.isFrozen(rungs), `${axis} rung list should be frozen`);
    assert.ok(rungs.length > 0, `${axis} should have at least one rung`);
    assert.equal(new Set(rungs).size, rungs.length, `${axis} should not repeat a rung`);
  }
});

test('keyModel has exactly one rung', () => {
  assert.deepEqual(AXES.keyModel, ['Probed']);
});

test('GRADES is frozen with exactly C-me, C, I', () => {
  assert.ok(Object.isFrozen(GRADES));
  assert.deepEqual(GRADES, ['C-me', 'C', 'I']);
});

// ---- rank ----

test('rank orders best (0) to worst, and UNKNOWN is Infinity', () => {
  assert.equal(rank('identity', 'Assignable'), 0);
  assert.equal(rank('identity', 'Scraped'), AXES.identity.length - 1);
  assert.equal(rank('identity', UNKNOWN), Infinity);
});

test('rank throws on an unknown axis or a value that is neither a rung nor UNKNOWN', () => {
  assert.throws(() => rank('bogus-axis', 'Assignable'));
  assert.throws(() => rank('identity', 'NotARung'));
});

// ---- atLeast ----

test('atLeast is true when value ranks at or better than floor, false when worse', () => {
  assert.equal(atLeast('identity', 'Assignable', 'RegistryFile'), true);
  assert.equal(atLeast('identity', 'RegistryFile', 'RegistryFile'), true);
  assert.equal(atLeast('identity', 'Scraped', 'RegistryFile'), false);
});

test('atLeast is always false when value is UNKNOWN, even against the worst floor', () => {
  assert.equal(atLeast('identity', UNKNOWN, 'Scraped'), false);
});

test('atLeast throws on a bad axis, a bad value, or a bad floor', () => {
  assert.throws(() => atLeast('bogus-axis', 'Assignable', 'Scraped'));
  assert.throws(() => atLeast('identity', 'NotARung', 'Scraped'));
  assert.throws(() => atLeast('identity', 'Assignable', 'NotARung'));
});

// ---- validateRecord ----

test('validateRecord accepts a fully valid synthetic record (control)', () => {
  const record = validRecord();
  assert.equal(validateRecord(record), record);
});

test('validateRecord rejects a record missing an axis', () => {
  const record = validRecord();
  delete record.identity;
  assert.throws(() => validateRecord(record), /identity/);
});

test('validateRecord rejects a record with an extra key', () => {
  const record = validRecord();
  record.bogus = { value: 'x', evidence: {} };
  assert.throws(() => validateRecord(record), /bogus/);
});

test('validateRecord rejects a value outside the axis', () => {
  const record = validRecord();
  record.identity = { value: 'NotARung', evidence: { grade: 'C', probe: 'p', observedOn: '2026-01-01' } };
  assert.throws(() => validateRecord(record));
});

test('validateRecord rejects a bad grade', () => {
  const record = validRecord();
  record.identity = { value: 'Assignable', evidence: { grade: 'bogus', probe: 'p', observedOn: '2026-01-01' } };
  assert.throws(() => validateRecord(record));
});

test('validateRecord rejects a malformed date', () => {
  const record = validRecord();
  record.identity = { value: 'Assignable', evidence: { grade: 'C', probe: 'p', observedOn: 'not-a-date' } };
  assert.throws(() => validateRecord(record));
});

test('validateRecord rejects an empty probe', () => {
  const record = validRecord();
  record.identity = { value: 'Assignable', evidence: { grade: 'C', probe: '', observedOn: '2026-01-01' } };
  assert.throws(() => validateRecord(record));
});

test('validateRecord rejects an unknown without deferredTo', () => {
  const record = validRecord();
  record.identity = { value: UNKNOWN, evidence: { probe: 'p' } };
  assert.throws(() => validateRecord(record));
});

test('validateRecord accepts an unknown with probe and deferredTo', () => {
  const record = validRecord();
  record.identity = { value: UNKNOWN, evidence: { probe: 'p', deferredTo: 'Phase 4' } };
  assert.equal(validateRecord(record), record);
});

// ---- unknownAxes / gatedUnknowns ----

test('unknownAxes reports every UNKNOWN axis with its probe and deferral', () => {
  const record = validRecord();
  record.ipcChannel = { value: UNKNOWN, evidence: { probe: 'probe ipc', deferredTo: 'Phase 4' } };
  record.identity = { value: UNKNOWN, evidence: { probe: 'probe identity', deferredTo: 'Phase 1' } };

  const unknowns = unknownAxes(record);
  assert.deepEqual(
    unknowns.map((entry) => entry.axis).sort(),
    ['identity', 'ipcChannel'],
  );
  const identityEntry = unknowns.find((entry) => entry.axis === 'identity');
  assert.equal(identityEntry.probe, 'probe identity');
  assert.equal(identityEntry.deferredTo, 'Phase 1');
});

test('gatedUnknowns filters to the gated axis set for the phase, and throws for an unphased phase', () => {
  const record = validRecord();
  record.identity = { value: UNKNOWN, evidence: { probe: 'probe identity', deferredTo: 'Phase 1' } };
  record.transcript = { value: UNKNOWN, evidence: { probe: 'probe transcript', deferredTo: 'never' } };

  const gated = gatedUnknowns(record, 1);
  assert.deepEqual(gated.map((entry) => entry.axis), ['identity']);

  assert.throws(() => gatedUnknowns(record, 99));
});

test('control: a synthetic record with UNKNOWN in a gated axis is reported by gatedUnknowns', () => {
  assert.ok(GATED_AXES_BY_PHASE[1].includes('identity'));
  const record = validRecord();
  record.identity = { value: UNKNOWN, evidence: { probe: 'p', deferredTo: 'Phase 1' } };
  assert.ok(gatedUnknowns(record, 1).some((entry) => entry.axis === 'identity'));
});

// ---- compareVersions ----

test('compareVersions orders dotted numeric versions', () => {
  assert.equal(compareVersions('2.0.14', '2.1.0'), -1);
  assert.equal(compareVersions('2.1.0', '2.0.14'), 1);
  assert.equal(compareVersions('2.0.14', '2.0.14'), 0);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
});

test('compareVersions ignores a leading v and a pre-release suffix', () => {
  assert.equal(compareVersions('v2.0.14', '2.0.14'), 0);
  assert.equal(compareVersions('2.0.14-beta.1', '2.0.14'), 0);
  assert.equal(compareVersions('v2.0.14-beta.1', '2.0.14'), 0);
});

test('compareVersions returns null, never throws, on garbage', () => {
  assert.equal(compareVersions('not-a-version', '2.0.14'), null);
  assert.equal(compareVersions('2.0.14', 'also-not'), null);
  assert.equal(compareVersions(null, '2.0.14'), null);
  assert.equal(compareVersions(undefined, undefined), null);
});
