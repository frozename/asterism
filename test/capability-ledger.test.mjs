import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegistry } from '../src/adapters/index.js';
import { AXES, gatedUnknowns, UNKNOWN, unknownAxes } from '../src/core/caps.js';

test('buildRegistry({}) has exactly one adapter, and its ledger gates no unknown axis for phase 1', () => {
  const registry = buildRegistry({});
  assert.equal(registry.size, 1);

  for (const adapter of registry.values()) {
    const offenders = gatedUnknowns(adapter.capabilities, 1);
    assert.deepEqual(
      offenders.map((entry) => entry.axis),
      [],
      `${adapter.id} gates a Phase 1 feature on an unprobed axis: ${offenders.map((entry) => entry.axis).join(', ')}`,
    );

    for (const entry of unknownAxes(adapter.capabilities)) {
      assert.equal(typeof entry.probe, 'string');
      assert.ok(entry.probe.length > 0, `${adapter.id}.${entry.axis} has an empty probe`);
      assert.equal(typeof entry.deferredTo, 'string');
      assert.ok(entry.deferredTo.length > 0, `${adapter.id}.${entry.axis} has an empty deferredTo`);
    }

    assert.equal(typeof adapter.measuredOn.cliVersion, 'string');
    assert.ok(adapter.measuredOn.cliVersion.length > 0, `${adapter.id}.measuredOn.cliVersion should be non-empty`);
  }
});

test('control: a synthetic record with UNKNOWN in a gated axis is reported by gatedUnknowns', () => {
  const record = {};
  for (const axis of Object.keys(AXES)) {
    record[axis] = {
      value: AXES[axis][0],
      evidence: { grade: 'C', probe: `probe for ${axis}`, observedOn: '2026-01-01' },
    };
  }
  record.identity = { value: UNKNOWN, evidence: { probe: 'p', deferredTo: 'Phase 1' } };

  const offenders = gatedUnknowns(record, 1);
  assert.deepEqual(offenders.map((entry) => entry.axis), ['identity']);
});
