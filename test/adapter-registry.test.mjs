import assert from 'node:assert/strict';
import test from 'node:test';
import { adapters } from '../src/adapters/index.js';

const MARKER_NAME = /^[A-Z][A-Z0-9_]*$/;

test('the adapter registry is a Map keyed by each entry\'s own id', () => {
  assert.ok(adapters instanceof Map);
  assert.ok(adapters.size > 0, 'expected at least one registered adapter');

  for (const [key, adapter] of adapters) {
    assert.equal(adapter.id, key);
  }
});

test('every adapter lists non-empty, frozen, uniquely-named uppercase env markers', () => {
  for (const adapter of adapters.values()) {
    assert.ok(Object.isFrozen(adapter.agentEnvMarkers), `${adapter.id} markers should be frozen`);
    assert.ok(adapter.agentEnvMarkers.length > 0, `${adapter.id} should list at least one marker`);
    assert.equal(
      new Set(adapter.agentEnvMarkers).size,
      adapter.agentEnvMarkers.length,
      `${adapter.id} should not repeat a marker`,
    );

    for (const marker of adapter.agentEnvMarkers) {
      assert.ok(MARKER_NAME.test(marker), `${marker} does not look like an env var name`);
    }
  }
});

test('every adapter exposes a non-empty static probe symbol list', () => {
  for (const adapter of adapters.values()) {
    assert.ok(adapter.staticProbe.symbols.length > 0, `${adapter.id} should list at least one symbol`);
  }
});

test('binaryCandidates is pure and scopes every directory under the given home', () => {
  for (const adapter of adapters.values()) {
    const candidates = adapter.staticProbe.binaryCandidates('/h');
    assert.ok(candidates.length > 0, `${adapter.id} should return at least one candidate`);

    for (const candidate of candidates) {
      assert.ok(candidate.dir.startsWith('/h/'), `${candidate.dir} should be scoped under the given home`);
    }
  }
});
