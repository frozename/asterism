import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRegistry } from '../src/adapters/index.js';
import { rank, validateRecord } from '../src/core/caps.js';
import { createUuidMinter } from '../src/core/uuid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_ROOT = path.join(ROOT, 'vectors', 'fake');
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function enumerationMessage(n) {
  return `conformance enumerated ${n} adapter(s); expected ≥2 — is ASTERISM_FAKE_ROOT set?`;
}

function assertEnumeration(registry) {
  assert.ok(registry.size >= 2, enumerationMessage(registry.size));
}

function sourcePurityOffenses(source) {
  return ['node:fs', 'node:child_process', 'process.env', 'Date.now', 'Math.random'].filter((needle) =>
    source.includes(needle),
  );
}

function mintedUuid() {
  const mint = createUuidMinter({
    random: () => Uint8Array.from([0, 1, 2, 3, 4, 5, 70, 135, 136, 9, 10, 11, 12, 13, 14, 15]),
  });
  return mint();
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

// ---- T14: spawn argv ----

const { readFile: readSpawnSource } = await import('node:fs/promises');
const SHELL_META = /[;&|`$<>]/;

test('control: spawn source purity scan flags process, filesystem, clock, and random sources', () => {
  const synthetic = "import fs from 'node:fs';\nprocess.env.X; Date.now(); Math.random();\n";
  assert.deepEqual(sourcePurityOffenses(synthetic), ['node:fs', 'process.env', 'Date.now', 'Math.random']);
});

for (const adapter of registry.values()) {
  test(`${adapter.id}: resumeArgv is distinct from spawnArgv`, () => {
    const sessionId = mintedUuid();
    const resume = adapter.resumeArgv({ sessionId });
    const spawn = adapter.spawnArgv({ sessionId });
    assert.notDeepEqual(resume, spawn);
    assert.equal(resume.includes('--session-id'), false);
    assert.equal(spawn.includes('--resume'), false);
  });

  test(`${adapter.id}: resumeArgv exists unconditionally and returns frozen string argv`, () => {
    assert.equal(typeof adapter.resumeArgv, 'function');

    const argv = adapter.resumeArgv({ sessionId: mintedUuid() });
    assert.equal(Array.isArray(argv), true);
    assert.equal(Object.isFrozen(argv), true);
    assert.ok(argv.length > 0);
    assert.equal(argv.every((entry) => typeof entry === 'string'), true);
    assert.equal(argv.every((entry) => !SHELL_META.test(entry)), true);
  });

  test(`${adapter.id}: resumeArgv rejects non-UUID session ids`, () => {
    assert.throws(() => adapter.resumeArgv({ sessionId: '01ARYZ6S410000000000000000' }), /sessionId/);
  });

  test(`${adapter.id}: resumeArgv rejects a canonical lowercase v1 UUID and names the v4 constraint`, () => {
    assert.throws(
      () => adapter.resumeArgv({ sessionId: '00010203-0405-1687-8809-0a0b0c0d0e0f' }),
      /version-4/,
    );
  });

  test(`${adapter.id}: spawnArgv exists unconditionally and returns frozen string argv`, () => {
    assert.equal(typeof adapter.spawnArgv, 'function');

    const argv = adapter.spawnArgv({ sessionId: mintedUuid() });
    assert.equal(Array.isArray(argv), true);
    assert.equal(Object.isFrozen(argv), true);
    assert.ok(argv.length > 0);
    assert.equal(argv.every((entry) => typeof entry === 'string'), true);
    assert.equal(argv.every((entry) => !SHELL_META.test(entry)), true);
  });

  test(`${adapter.id}: spawnArgv rejects non-UUID session ids`, () => {
    assert.throws(() => adapter.spawnArgv({ sessionId: '01ARYZ6S410000000000000000' }), /sessionId/);
  });

  test(`${adapter.id}: spawnArgv rejects a canonical lowercase v1 UUID and names the v4 constraint`, () => {
    assert.throws(
      () => adapter.spawnArgv({ sessionId: '00010203-0405-1687-8809-0a0b0c0d0e0f' }),
      /version-4/,
    );
  });

  test(`${adapter.id}: spawn argv source is filesystem-, process-, clock-, and random-free`, async () => {
    const source = await readSpawnSource(path.join(ROOT, 'src', 'adapters', adapter.id, 'spawn.js'), 'utf8');
    assert.deepEqual(sourcePurityOffenses(source), []);
  });
}

// ---- T7: lister tier ----

const { readFile: readListerVector } = await import('node:fs/promises');
const { collectObservations: collectListerObservations } = await import('../src/io/discover.js');
const { OBSERVATION_SOURCES, reconcile: reconcileListings } = await import('../src/core/reconcile.js');

function listerShape(adapter) {
  const argv = typeof adapter.discoverArgv === 'function';
  const func = typeof adapter.discover === 'function';
  if (argv && func) return 'both';
  if (argv) return 'argv';
  if (func) return 'function';
  return 'none';
}

test('listerShape controls distinguish both and none', () => {
  assert.equal(listerShape({ discoverArgv() {}, discover() {} }), 'both');
  assert.equal(listerShape({}), 'none');
});

for (const adapter of registry.values()) {
  test(`${adapter.id}: exposes exactly one discovery lister`, () => {
    assert.ok(['argv', 'function'].includes(listerShape(adapter)));
  });

  test(`${adapter.id}: discovery envelopes satisfy the reconciler`, async () => {
    const shape = listerShape(adapter);
    const env = shape === 'function' ? { ASTERISM_FAKE_ROOT: FAKE_ROOT } : { PATH: '/unused', HOME: ROOT };
    const options = { env, home: ROOT, now: 0 };
    if (shape === 'argv') {
      const vectorPath = path.join(ROOT, 'vectors', adapter.id, 'synthetic', 'agents-json', 'mixed.json');
      const bytes = await readListerVector(vectorPath);
      options.execute = async () => ({ code: 0, stdout: bytes, stderr: Buffer.alloc(0) });
    }

    const { observations } = await collectListerObservations(adapter, options);
    assert.ok(observations.length >= 1);
    for (const observation of observations) {
      assert.ok(OBSERVATION_SOURCES.includes(observation.source));
      assert.equal(observation.adapter, adapter.id);
    }

    let counter = 0;
    const folded = await reconcileListings(observations, { now: 0, mint: () => `conformance-${++counter}` });
    assert.ok(folded.records.length >= 1);
  });
}

// ---- T10: install plans ----

const { readFile: readInstallSource } = await import('node:fs/promises');
const { MANAGED_FILE_MARKER } = await import('../src/io/cfgedit.js');

/**
 * Structural shape of the subset of registered adapters that implement the install-plan tier.
 * Only 'installPlan'/'profileFile' are asserted here -- other registered adapters (e.g. the
 * fake) genuinely omit them at runtime, which is exactly what the `typeof ... === 'function'`
 * guards below check for before this shape is trusted.
 * @typedef {{
 *   id: string,
 *   installPlan: (root: string, home: string) => readonly { targetPath: string, content: string }[],
 *   profileFile: (home: string) => string,
 * }} InstallCapableAdapter
 */

function isFrozenInstallPlan(plan) {
  return (
    Object.isFrozen(plan) &&
    plan.length >= 2 &&
    plan.every(
      (entry) =>
        Object.isFrozen(entry) && typeof entry.targetPath === 'string' && typeof entry.content === 'string',
    )
  );
}

test('install-plan tier has at least one implementation', () => {
  assert.ok(
    [.../** @type {Iterable<InstallCapableAdapter>} */ (registry.values())].some(
      (adapter) => typeof adapter.installPlan === 'function',
    ),
    'install-plan conformance enumerated no adapter implementation',
  );
});

test('control: a mutable synthetic install plan fails the frozen-plan predicate', () => {
  assert.equal(isFrozenInstallPlan([{ targetPath: '/home/u/x', content: MANAGED_FILE_MARKER }]), false);
});

for (const adapter of /** @type {Iterable<InstallCapableAdapter>} */ (registry.values())) {
  if (typeof adapter.installPlan !== 'function') continue;

  test(`${adapter.id}: install plan is frozen, owned, marked, profile-disjoint, and uses the absolute hook binary`, () => {
    const plan = adapter.installPlan('/repo', '/home/u');
    assert.ok(isFrozenInstallPlan(plan));
    assert.ok(plan.every((entry) => entry.targetPath.startsWith('/home/u/')));
    assert.ok(plan.every((entry) => entry.targetPath !== adapter.profileFile('/home/u')));
    assert.ok(plan.every((entry) => entry.content.includes(MANAGED_FILE_MARKER)));
    assert.ok(plan.some((entry) => entry.content.includes('/repo/bin/ast-hook ')));
  });

  test(`${adapter.id}: install plan source is filesystem- and process-exec-free`, async () => {
    const source = await readInstallSource(path.join(ROOT, 'src', 'adapters', adapter.id, 'install.js'), 'utf8');
    assert.equal(source.includes('node:fs'), false);
    assert.equal(source.includes('node:child_process'), false);
  });
}
