import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRegistry } from '../src/adapters/index.js';
import { rank, validateRecord } from '../src/core/caps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_ROOT = path.join(ROOT, 'vectors', 'fake');
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function enumerationMessage(n) {
  return `conformance enumerated ${n} adapter(s); expected ≥2 — is ASTERISM_FAKE_ROOT set?`;
}

function assertEnumeration(registry) {
  assert.ok(registry.size >= 2, enumerationMessage(registry.size));
}

// ---- L0: registry gating ----

test('buildRegistry({}) has exactly one entry and no "fake" adapter', () => {
  const registry = buildRegistry({});
  assert.equal(registry.size, 1);
  assert.equal(registry.has('fake'), false);
});

test('buildRegistry({ ASTERISM_FAKE_ROOT: "" }) has exactly one entry (empty string is unset)', () => {
  const registry = buildRegistry({ ASTERISM_FAKE_ROOT: '' });
  assert.equal(registry.size, 1);
  assert.equal(registry.has('fake'), false);
});

test('buildRegistry({ ASTERISM_FAKE_ROOT: "/x" }) has two entries', () => {
  const registry = buildRegistry({ ASTERISM_FAKE_ROOT: '/x' });
  assert.equal(registry.size, 2);
});

test('control: the enumeration predicate applied to a one-entry Map yields the expected message', () => {
  const oneEntry = new Map([['solo', {}]]);
  assert.throws(() => assertEnumeration(oneEntry), { message: enumerationMessage(1) });
});

// ---- conformance suite, parameterized over every registered adapter ----

const registry = buildRegistry({ ASTERISM_FAKE_ROOT: FAKE_ROOT });

test('the conformance registry enumerated at least two adapters', () => {
  assertEnumeration(registry);
});

for (const adapter of registry.values()) {
  test(`${adapter.id}: id matches the id grammar`, () => {
    assert.match(adapter.id, ID_PATTERN);
  });

  test(`${adapter.id}: capabilities passes validateRecord`, () => {
    assert.equal(validateRecord(adapter.capabilities), adapter.capabilities);
  });

  test(`${adapter.id}: measuredOn has a cliVersion key`, () => {
    assert.ok(Object.hasOwn(adapter.measuredOn, 'cliVersion'));
  });

  test(`${adapter.id}: detectSamples has full, lockedDown, oldVersion`, () => {
    assert.equal(typeof adapter.detectSamples.full, 'object');
    assert.equal(typeof adapter.detectSamples.lockedDown, 'object');
    assert.equal(typeof adapter.detectSamples.oldVersion, 'object');
  });

  test(`${adapter.id}: detect and effectiveCapabilities are functions`, () => {
    assert.equal(typeof adapter.detect, 'function');
    assert.equal(typeof adapter.effectiveCapabilities, 'function');
  });

  test(`${adapter.id}: effectiveCapabilities(detect(full)) equals the ledger on every axis`, () => {
    const detected = adapter.detect(adapter.detectSamples.full);
    const result = adapter.effectiveCapabilities(detected);
    assert.equal(validateRecord(result), result);

    for (const axis of Object.keys(adapter.capabilities)) {
      assert.deepEqual(result[axis], adapter.capabilities[axis], `${adapter.id}.${axis} should equal the ledger`);
    }
  });

  for (const sampleName of ['lockedDown', 'oldVersion']) {
    test(`${adapter.id}: ${sampleName} degrades monotonically from the ledger`, () => {
      const detected = adapter.detect(adapter.detectSamples[sampleName]);
      const result = adapter.effectiveCapabilities(detected);
      assert.equal(validateRecord(result), result);

      for (const axis of Object.keys(adapter.capabilities)) {
        const ledgerRank = rank(axis, adapter.capabilities[axis].value);
        const resultRank = rank(axis, result[axis].value);
        assert.ok(resultRank >= ledgerRank, `${adapter.id}.${axis} got better under ${sampleName}`);
      }
    });
  }

  for (const sampleName of ['lockedDown', 'oldVersion']) {
    test(`${adapter.id}: ${sampleName} alone strictly degrades at least one axis`, () => {
      const detected = adapter.detect(adapter.detectSamples[sampleName]);
      const result = adapter.effectiveCapabilities(detected);

      let sawStrictlyWorse = false;
      for (const axis of Object.keys(adapter.capabilities)) {
        const ledgerRank = rank(axis, adapter.capabilities[axis].value);
        const resultRank = rank(axis, result[axis].value);
        if (resultRank > ledgerRank) sawStrictlyWorse = true;
      }

      assert.ok(sawStrictlyWorse, `${adapter.id}: ${sampleName} did not degrade any axis -- dead control`);
    });
  }

  test(`${adapter.id}: detect is pure -- same facts deep-equal, facts object not mutated`, () => {
    const frozenFacts = Object.freeze({ ...adapter.detectSamples.full });
    const expected = { ...frozenFacts };

    const first = adapter.detect(frozenFacts);
    const second = adapter.detect(frozenFacts);
    assert.deepEqual(first, second);
    assert.deepEqual(frozenFacts, expected);
  });

  test(`${adapter.id}: detect and effectiveCapabilities return frozen objects`, () => {
    const detected = adapter.detect(adapter.detectSamples.full);
    assert.ok(Object.isFrozen(detected));

    const result = adapter.effectiveCapabilities(detected);
    assert.ok(Object.isFrozen(result));
  });
}
