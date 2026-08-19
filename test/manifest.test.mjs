import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { adapters } from '../src/adapters/index.js';
import { parseToml } from '../src/core/toml.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'fixtures', 'MANIFEST.toml');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');

const CELL_ID = /^[a-z][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const VALID_KINDS = new Set(['required', 'manual', 'n/a']);
const IS_BUN = typeof globalThis.Bun !== 'undefined';
const STRICT = process.env.ASTERISM_MANIFEST_STRICT === '1';

let manifest = null;
let loadError = null;
try {
  manifest = parseToml(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (error) {
  loadError = error;
}

test('fixtures/MANIFEST.toml exists and parses', () => {
  assert.equal(existsSync(MANIFEST_PATH), true, 'fixtures/MANIFEST.toml is missing');
  assert.equal(loadError, null, `fixtures/MANIFEST.toml failed to parse: ${loadError?.message}`);
  assert.ok(manifest !== null, 'fixtures/MANIFEST.toml did not produce an object');
});

test('manifest schema is 1', () => {
  assert.ok(manifest, 'manifest failed to load; see the prior test');
  assert.equal(manifest.manifest?.schema, 1);
});

test('every cell id matches the cell-id grammar', () => {
  assert.ok(manifest?.cells, 'manifest.cells is missing');
  for (const id of Object.keys(manifest.cells)) {
    assert.ok(validateCellId(id), `${id} does not match the cell-id grammar`);
  }

  assert.equal(validateCellId('Bad/Id'), false, 'control: an uppercase segment must be rejected');
  assert.equal(validateCellId('/leading-slash'), false, 'control: a leading slash must be rejected');
});

test('required/manual cells are rooted at a registered adapter or tmux', () => {
  assert.ok(manifest?.cells, 'manifest.cells is missing');
  const validRoots = new Set([...adapters.keys(), 'tmux']);

  for (const [id, cell] of Object.entries(manifest.cells)) {
    const result = validateCellRoot(id, cell, validRoots);
    assert.ok(result.ok, result.reason);
  }

  const control = validateCellRoot('zzz/list-panes', { kind: 'required' }, validRoots);
  assert.equal(control.ok, false, 'control: an unregistered root must be rejected by the same check');
});

test('every cell has a valid kind, a non-empty why, and kind-appropriate fields', () => {
  assert.ok(manifest?.cells, 'manifest.cells is missing');

  for (const [id, cell] of Object.entries(manifest.cells)) {
    const result = validateCellShape(id, cell);
    assert.ok(result.ok, result.reason);
  }

  const bogusKind = validateCellShape('control/bogus-kind', { kind: 'bogus', why: 'x' });
  assert.equal(bogusKind.ok, false, 'control: kind "bogus" must be rejected by the same check');

  const naWithCapture = validateCellShape('control/na-with-capture', {
    kind: 'n/a',
    why: 'x',
    reason: 'x',
    capture: 'ast fixture capture control/na-with-capture',
  });
  assert.equal(naWithCapture.ok, false, 'control: an n/a cell carrying a capture command must be rejected');
});

if (manifest?.cells) {
  for (const [id, cell] of Object.entries(manifest.cells)) {
    registerCellTest(id, cell);
  }
}

test('manifest progress is consistent with the file', (t) => {
  assert.ok(manifest?.cells, 'manifest.cells is missing');

  const cells = Object.values(manifest.cells);
  const capturable = cells.filter((cell) => cell.kind === 'required' || cell.kind === 'manual');
  const naCells = cells.filter((cell) => cell.kind === 'n/a');

  let captured = 0;
  for (const [id, cell] of Object.entries(manifest.cells)) {
    if (cell.kind === 'n/a') continue;
    if (existsSync(cellDir(id))) captured += 1;
  }

  const message = `manifest: ${captured}/${capturable.length} cells captured, ${naCells.length} n/a`;
  diagnostic(t, message);

  assert.equal(capturable.length + naCells.length, cells.length);
  assert.ok(captured >= 0 && captured <= capturable.length);
});

test('verifyCapturedCell control: sha mismatch is reported, a matching capture passes', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'asterism-manifest-control-'));
  const cellId = 'tmux/synthetic-control';
  const dir = path.join(tmp, ...cellId.split('/'));
  mkdirSync(dir, { recursive: true });

  const rawBytes = Buffer.from('synthetic control raw bytes\n', 'utf8');
  writeFileSync(path.join(dir, 'raw'), rawBytes);
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      cell: cellId,
      sha256: 'a'.repeat(64),
      bytes: rawBytes.length,
      capturedAt: '2026-01-01T00:00:00Z',
      provokedBy: 'synthetic',
      command: ['synthetic'],
      cliVersion: null,
      tmuxVersion: null,
      profileHash: 'absent',
      redactions: [],
      kills: [],
    }),
  );

  const mismatch = verifyCapturedCell(dir, cellId);
  assert.equal(mismatch.ok, false, 'a wrong sha256 in meta.json should be reported as a mismatch');
  assert.match(mismatch.reason, /sha256/);

  const actualSha = createHash('sha256').update(rawBytes).digest('hex');
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      cell: cellId,
      sha256: actualSha,
      bytes: rawBytes.length,
      capturedAt: '2026-01-01T00:00:00Z',
      provokedBy: 'synthetic',
      command: ['synthetic'],
      cliVersion: null,
      tmuxVersion: null,
      profileHash: 'absent',
      redactions: [],
      kills: [],
    }),
  );

  const match = verifyCapturedCell(dir, cellId);
  assert.equal(match.ok, true, match.ok ? undefined : match.reason);
});

function registerCellTest(id, cell) {
  const name = `fixture ${id}`;

  if (cell.kind === 'n/a') {
    test(name, () => {
      assert.equal(typeof cell.reason, 'string');
      assert.ok(cell.reason.length > 0);
    });
    return;
  }

  const dir = cellDir(id);
  const present = existsSync(dir);

  if (!present) {
    const message = `missing: run \`${cell.capture}\``;

    if (STRICT && cell.kind === 'required') {
      test(name, () => {
        assert.fail(message);
      });
      return;
    }

    if (IS_BUN) {
      test.todo(name, () => {
        throw new Error(message);
      });
    } else {
      test(name, { todo: message }, () => {});
    }
    return;
  }

  test(name, () => {
    const result = verifyCapturedCell(dir, id);
    assert.ok(result.ok, result.ok ? undefined : `${result.reason}; hand-edited or corrupted; re-capture with \`${cell.capture}\``);
  });
}

function verifyCapturedCell(dir, id) {
  const rawPath = path.join(dir, 'raw');
  const metaPath = path.join(dir, 'meta.json');

  if (!existsSync(rawPath) || !existsSync(metaPath)) {
    return { ok: false, reason: 'missing raw or meta.json' };
  }

  const rawBytes = readFileSync(rawPath);

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `meta.json is not valid JSON: ${error.message}` };
  }

  if (meta.cell !== id) {
    return { ok: false, reason: `meta.cell "${meta.cell}" does not match "${id}"` };
  }

  const actualSha = createHash('sha256').update(rawBytes).digest('hex');
  if (meta.sha256 !== actualSha) {
    return { ok: false, reason: `sha256 mismatch: meta.json says ${meta.sha256}, raw hashes to ${actualSha}` };
  }

  if (meta.bytes !== rawBytes.length) {
    return { ok: false, reason: `bytes mismatch: meta.json says ${meta.bytes}, raw is ${rawBytes.length} bytes` };
  }

  if (!Array.isArray(meta.redactions)) {
    return { ok: false, reason: 'meta.redactions is not an array' };
  }

  if (!Array.isArray(meta.kills)) {
    return { ok: false, reason: 'meta.kills is not an array' };
  }

  return { ok: true };
}

function cellDir(id) {
  return path.join(FIXTURES_DIR, ...id.split('/'));
}

function validateCellId(id) {
  return CELL_ID.test(id);
}

function validateCellRoot(id, cell, validRoots) {
  if (cell.kind === 'n/a') return { ok: true };
  const root = id.split('/')[0];
  if (!validRoots.has(root)) {
    return { ok: false, reason: `${id}: first segment "${root}" is not tmux or a registered adapter` };
  }
  return { ok: true };
}

function validateCellShape(id, cell) {
  if (!VALID_KINDS.has(cell.kind)) {
    return { ok: false, reason: `${id}: kind "${cell.kind}" is not required|manual|n/a` };
  }
  if (typeof cell.why !== 'string' || cell.why.length === 0) {
    return { ok: false, reason: `${id}: why must be a non-empty string` };
  }

  if (cell.kind === 'required' || cell.kind === 'manual') {
    if (cell.capture !== `ast fixture capture ${id}`) {
      return { ok: false, reason: `${id}: capture must equal "ast fixture capture ${id}"` };
    }
  }

  if (cell.kind === 'manual') {
    if (!Number.isInteger(cell.maxAgeDays)) {
      return { ok: false, reason: `${id}: manual cell must have an integer maxAgeDays` };
    }
  }

  if (cell.kind === 'n/a') {
    if (typeof cell.reason !== 'string' || cell.reason.length === 0) {
      return { ok: false, reason: `${id}: n/a cell must have a non-empty reason` };
    }
    if (Object.hasOwn(cell, 'capture')) {
      return { ok: false, reason: `${id}: n/a cell must not have a capture command` };
    }
  }

  return { ok: true };
}

function diagnostic(t, message) {
  if (typeof t.diagnostic === 'function') {
    t.diagnostic(message);
  } else {
    console.log(`# ${message}`);
  }
}
