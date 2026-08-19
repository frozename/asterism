import assert from 'node:assert/strict';
import test from 'node:test';
import { digestOf, scanText } from '../harness/secret-scan.mjs';

test('digestOf is case-insensitive', () => {
  assert.equal(digestOf('Secret Value'), digestOf('secret value'));
  assert.equal(digestOf('SECRET VALUE'), digestOf('secret value'));
});

test('a mixed-case value is still found by the scanner in lowercase text', () => {
  const syntheticValue = 'Synthetic Mixed-Case Token';
  const digest = digestOf(syntheticValue);

  const findings = scanText('prefix synthetic mixed-case token suffix\n', new Set([digest]));

  assert.deepEqual(findings, [{ line: 1, digest }]);
});

test('a clean, unrelated digest does not match', () => {
  const digest = digestOf('Synthetic Mixed-Case Token');
  assert.deepEqual(scanText('nothing to see here\n', new Set([digest])), []);
});
