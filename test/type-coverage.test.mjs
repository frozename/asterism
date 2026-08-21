import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listTrackedTypeCheckableFiles,
  readTsconfigInclude,
  typeCoverageViolations,
  TYPE_COVERAGE_LEDGER,
} from '../harness/type-coverage.mjs';

test('type coverage ledger is frozen and gives every excluded file a non-empty reason', () => {
  assert.ok(Array.isArray(TYPE_COVERAGE_LEDGER));
  assert.ok(Object.isFrozen(TYPE_COVERAGE_LEDGER));
  for (const entry of TYPE_COVERAGE_LEDGER) {
    assert.ok(Object.isFrozen(entry), `${entry.file} ledger entry should be frozen`);
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.trim().length > 0, `${entry.file} should have a non-empty exclusion reason`);
  }
});

test('every tracked bin/src/harness/test file is either tsconfig-included or ledger-excluded, never both', () => {
  const trackedFiles = listTrackedTypeCheckableFiles();
  const includeList = readTsconfigInclude();
  const violations = typeCoverageViolations({ trackedFiles, includeList, ledger: TYPE_COVERAGE_LEDGER });
  assert.deepEqual(violations, []);
});

test('every tsconfig include entry and every ledger key exists on disk', () => {
  const trackedFiles = new Set(listTrackedTypeCheckableFiles());
  const includeList = readTsconfigInclude();

  for (const file of includeList) {
    assert.ok(trackedFiles.has(file), `tsconfig include entry "${file}" does not exist on disk`);
  }
  for (const entry of TYPE_COVERAGE_LEDGER) {
    assert.ok(trackedFiles.has(entry.file), `ledger entry "${entry.file}" does not exist on disk`);
  }
});

test('control: an unlisted file is flagged, an empty-reason ledger entry is flagged, a well-formed pair passes', () => {
  const trackedFiles = ['a.js', 'b.js', 'c.js'];

  // A well-formed pair: a.js included, b.js ledgered with a real reason, c.js
  // named in neither list -- must be the one and only violation.
  const orphanOnly = typeCoverageViolations({
    trackedFiles,
    includeList: ['a.js'],
    ledger: [{ file: 'b.js', reason: 'does not type-check: synthetic control error' }],
  });
  assert.deepEqual(orphanOnly, ['"c.js" is neither tsconfig-included nor ledger-excluded']);

  // Empty-reason control (must hit): a ledger entry with a blank reason is
  // flagged even though the file/include split is otherwise well-formed.
  const emptyReason = typeCoverageViolations({
    trackedFiles: ['a.js', 'b.js'],
    includeList: ['a.js'],
    ledger: [{ file: 'b.js', reason: '   ' }],
  });
  assert.ok(
    emptyReason.some((v) => v.includes('missing a non-empty reason')),
    'empty ledger reason was not flagged',
  );

  // Pass-through control: every tracked file accounted for, exactly once,
  // with a real reason -- zero violations.
  const clean = typeCoverageViolations({
    trackedFiles: ['a.js', 'b.js'],
    includeList: ['a.js'],
    ledger: [{ file: 'b.js', reason: 'does not type-check: synthetic control error' }],
  });
  assert.deepEqual(clean, []);
});

test('control: a file listed both included and ledgered is flagged', () => {
  const violations = typeCoverageViolations({
    trackedFiles: ['a.js'],
    includeList: ['a.js'],
    ledger: [{ file: 'a.js', reason: 'does not type-check: synthetic control error' }],
  });
  assert.deepEqual(violations, ['"a.js" is both tsconfig-included and ledger-excluded']);
});

test('control: an include entry or ledger key naming a file absent from disk is flagged', () => {
  const missingInclude = typeCoverageViolations({
    trackedFiles: ['a.js'],
    includeList: ['a.js', 'ghost.js'],
    ledger: [],
  });
  assert.ok(missingInclude.some((v) => v.includes('"ghost.js"') && v.includes('does not exist on disk')));

  const missingLedger = typeCoverageViolations({
    trackedFiles: ['a.js'],
    includeList: [],
    ledger: [{ file: 'ghost.js', reason: 'does not type-check: synthetic control error' }],
  });
  assert.ok(missingLedger.some((v) => v.includes('"ghost.js"') && v.includes('does not exist on disk')));
});

test('control: a duplicate ledger key is flagged', () => {
  const entry = { file: 'a.js', reason: 'does not type-check: synthetic control error' };
  const violations = typeCoverageViolations({
    trackedFiles: ['a.js'],
    includeList: [],
    ledger: [entry, entry],
  });
  assert.ok(violations.some((v) => v.includes('duplicate')));
});
