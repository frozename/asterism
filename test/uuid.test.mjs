import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createUuidMinter, UUID_PATTERN } from '../src/core/uuid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bytes() {
  return Uint8Array.from([0, 1, 2, 3, 4, 5, 70, 135, 136, 9, 10, 11, 12, 13, 14, 15]);
}

test('createUuidMinter emits a canonical lowercase version-4 UUID', () => {
  const mint = createUuidMinter({ random: bytes });
  assert.equal(mint(), '00010203-0405-4687-8809-0a0b0c0d0e0f');
  assert.match(mint(), UUID_PATTERN);
});

test('UUID_PATTERN requires a canonical lowercase version-4 UUID', () => {
  assert.equal(UUID_PATTERN.test('00010203-0405-4687-8809-0a0b0c0d0e0f'), true);
  assert.equal(UUID_PATTERN.test('00010203-0405-1687-8809-0a0b0c0d0e0f'), false);
  assert.equal(UUID_PATTERN.test('00010203-0405-4687-c809-0a0b0c0d0e0f'), false);
  assert.equal(UUID_PATTERN.test('00010203-0405-4687-8809-0A0B0C0D0E0F'), false);
  assert.equal(UUID_PATTERN.test('01ARYZ6S410000000000000000'), false);
});

test('two fresh UUID minters with identical injected random bytes mint identical first ids', () => {
  const first = createUuidMinter({ random: bytes });
  const second = createUuidMinter({ random: bytes });
  assert.equal(first(), second());
});

test('createUuidMinter rejects a missing or malformed random source', () => {
  assert.throws(
    () => createUuidMinter(/** @type {{ random: (count: number) => Uint8Array }} */ ({})),
    TypeError,
  );
  assert.throws(() => createUuidMinter({ random: null }), TypeError);
  const mint = createUuidMinter({ random: () => Uint8Array.from([1, 2, 3]) });
  assert.throws(() => mint(), /16 byte/);
});

test('uuid core source uses injected entropy only', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'core', 'uuid.js'), 'utf8');
  assert.equal(source.includes('node:crypto'), false);
  assert.equal(source.includes('Math.random'), false);
  assert.equal(source.includes('Date.now'), false);
});
