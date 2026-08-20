import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildRegistry } from '../src/adapters/index.js';
import { parseCtime } from '../src/core/liveness.js';
import { reconcile } from '../src/core/reconcile.js';
import { parsePsPidLstart } from '../src/io/procs.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = buildRegistry({ ASTERISM_FAKE_ROOT: path.join(ROOT, 'vectors', 'fake') });
const vendorId = [...registry.keys()].find((id) => id !== 'fake');
const vendor = registry.get(vendorId);
const FIXTURES_ROOT = path.join(ROOT, 'fixtures');
const IS_BUN = typeof globalThis.Bun !== 'undefined';

export function resolveCell(fixturesRoot, cell) {
  const rawPath = path.join(fixturesRoot, ...cell.split('/'), 'raw');
  if (existsSync(rawPath)) return Object.freeze({ mode: 'real', message: null, rawPath });
  return Object.freeze({
    mode: 'todo',
    message: `missing: run \`ast fixture capture ${cell}\``,
    rawPath,
  });
}

export function splitFileSections(text) {
  const headers = [...text.matchAll(/^### ([^\r\n]+)\r?\n/gm)];
  if (headers.length === 0) throw new RangeError('file-source capture has no sections');
  if (text.slice(0, headers[0].index).trim().length > 0) {
    throw new RangeError('file-source capture has bytes before its first section');
  }

  const sections = headers.map((header, index) => {
    const start = header.index + header[0].length;
    const end = index + 1 < headers.length ? headers[index + 1].index : text.length;
    return Object.freeze({ name: header[1], text: text.slice(start, end) });
  });
  return Object.freeze(sections);
}

function registerTodo(name, message) {
  if (IS_BUN) {
    test.todo(name, () => {
      throw new Error(message);
    });
  } else {
    test(name, { todo: message }, () => {});
  }
}

function registerResolved(name, resolution, callback) {
  if (resolution.mode === 'todo') {
    registerTodo(name, resolution.message);
    return;
  }
  test(name, callback);
}

function cellKind(cell) {
  if (cell.includes('/agents-json/')) return 'agents';
  if (cell.includes('/registry/')) return 'registry';
  return 'process-table';
}

function mintCounter() {
  let counter = 0;
  return () => `golden-${++counter}`;
}

function contractEnvelopes(cell, at = 1) {
  const raw = readFileSync(resolveCell(FIXTURES_ROOT, cell).rawPath, 'utf8');
  const parsed = vendor.parseAgentsJson(raw);
  assert.equal(parsed.error, null);
  return parsed.rows.map((fields) => Object.freeze({ source: 'contract', adapter: vendorId, at, fields }));
}

function registryEnvelopes(cell, at = 1) {
  const raw = readFileSync(resolveCell(FIXTURES_ROOT, cell).rawPath, 'utf8');
  return splitFileSections(raw).map((section) => {
    const parsed = vendor.parseRegistryRecord(section.text);
    assert.equal(parsed.error, null, `${section.name}: ${parsed.error}`);
    return Object.freeze({ source: 'registry-file', adapter: vendorId, at, fields: parsed.record });
  });
}

test('resolveCell moves from the exact todo message to real when raw exists', () => {
  const fixturesRoot = mkdtempSync(path.join(os.tmpdir(), 'asterism-golden-resolve-'));
  try {
    const cell = 'adapter/example';
    const missing = resolveCell(fixturesRoot, cell);
    assert.equal(missing.mode, 'todo');
    assert.equal(missing.message, 'missing: run `ast fixture capture adapter/example`');

    mkdirSync(path.dirname(missing.rawPath), { recursive: true });
    writeFileSync(missing.rawPath, 'raw\n');
    const present = resolveCell(fixturesRoot, cell);
    assert.equal(present.mode, 'real');
    assert.equal(present.rawPath, missing.rawPath);
  } finally {
    rmSync(fixturesRoot, { recursive: true, force: true });
  }
});

test('splitFileSections recovers every named section and rejects headerless bytes', () => {
  const sections = splitFileSections('### 111.json\n{"one":1}\n### 222.json\n{"two":2}\n');
  assert.deepEqual(
    sections.map((entry) => entry.name),
    ['111.json', '222.json'],
  );
  assert.equal(sections[0].text, '{"one":1}\n');
  assert.equal(sections[1].text, '{"two":2}\n');
  assert.throws(() => splitFileSections('{"headerless":true}\n'), RangeError);
});

for (const cell of vendor.goldenCells) {
  const resolution = resolveCell(FIXTURES_ROOT, cell);
  registerResolved(`discovery golden ${cell}`, resolution, async () => {
    const raw = readFileSync(resolution.rawPath, 'utf8');
    const kind = cellKind(cell);
    if (kind === 'agents') {
      const parsed = vendor.parseAgentsJson(raw);
      assert.equal(parsed.error, null);
      assert.ok(parsed.rows.length >= 1);
      assert.ok(parsed.rows.every((row) => typeof row.sessionId === 'string'));
      if (cell.endsWith('/waiting')) {
        assert.ok(parsed.rows.some((row) => row.status === 'waiting' && Object.hasOwn(row, 'waitingFor')));
      }
      return;
    }

    if (kind === 'registry') {
      const sections = splitFileSections(raw);
      assert.ok(sections.length >= 1);
      const records = sections.map((section) => {
        const parsed = vendor.parseRegistryRecord(section.text);
        assert.equal(parsed.error, null, `${section.name}: ${parsed.error}`);
        return parsed.record;
      });
      if (cell.endsWith('/null-status')) {
        const nullRecord = records.find((record) => record.status === null);
        assert.ok(nullRecord, 'the null-status cell must contain a null status');
        const folded = await reconcile(
          [{ source: 'registry-file', adapter: vendorId, at: 1, fields: nullRecord }],
          { now: 1, mint: mintCounter() },
        );
        assert.equal(folded.canaries.filter((entry) => entry.key === 'status').length, 1);
      }
      return;
    }

    assert.ok(parsePsPidLstart(raw).size >= 1);
  });
}

const agentsCells = vendor.goldenCells.filter((cell) => cellKind(cell) === 'agents');
const registryCells = vendor.goldenCells.filter((cell) => cellKind(cell) === 'registry');
const allReplayCells = [...agentsCells, ...registryCells];
const firstMissingReplay = allReplayCells.map((cell) => [cell, resolveCell(FIXTURES_ROOT, cell)]).find(([, value]) => value.mode === 'todo');

if (firstMissingReplay) {
  registerTodo('discovery golden enrichment-absent replay', firstMissingReplay[1].message);
} else {
  test('discovery golden enrichment-absent replay', async () => {
    const contract = agentsCells.flatMap((cell) => contractEnvelopes(cell));
    const enrichment = registryCells.flatMap((cell) => registryEnvelopes(cell));
    const contractOnly = await reconcile(contract, { now: 1, mint: mintCounter() });
    const enriched = await reconcile([...contract, ...enrichment], { now: 1, mint: mintCounter() });

    assert.deepEqual(
      contractOnly.records.map((entry) => entry.agent.sessionId).sort(),
      enriched.records.map((entry) => entry.agent.sessionId).sort(),
    );
    for (const record of contractOnly.records) {
      assert.equal(Object.hasOwn(record.prov, 'procStart'), false);
      assert.equal(record.flags.writeDisabled, true);
    }
  });
}

const probeSource = agentsCells.map((cell) => [cell, resolveCell(FIXTURES_ROOT, cell)]).find(([, value]) => value.mode === 'real');
if (!probeSource) {
  registerTodo('discovery golden unknown-key replay', resolveCell(FIXTURES_ROOT, agentsCells[0]).message);
} else {
  test('discovery golden unknown-key replay', async () => {
    const raw = readFileSync(probeSource[1].rawPath, 'utf8');
    const clean = vendor.parseAgentsJson(raw);
    assert.equal(clean.error, null);
    const cleanFold = await reconcile(
      clean.rows.map((fields) => ({ source: 'contract', adapter: vendorId, at: 1, fields })),
      { now: 1, mint: mintCounter() },
    );
    assert.equal(cleanFold.canaries.filter((entry) => entry.key === 'asterismProbeUnknownKey').length, 0);

    const injectedRows = JSON.parse(raw);
    injectedRows[0].asterismProbeUnknownKey = 'probe';
    const injected = vendor.parseAgentsJson(JSON.stringify(injectedRows));
    const injectedFold = await reconcile(
      injected.rows.map((fields) => ({ source: 'contract', adapter: vendorId, at: 1, fields })),
      { now: 1, mint: mintCounter() },
    );
    assert.equal(injectedFold.canaries.filter((entry) => entry.key === 'asterismProbeUnknownKey').length, 1);
  });
}

const processCell = vendor.goldenCells.find((cell) => cellKind(cell) === 'process-table');
const processResolution = resolveCell(FIXTURES_ROOT, processCell);
const presentRegistryCells = registryCells.filter((cell) => resolveCell(FIXTURES_ROOT, cell).mode === 'real');
if (processResolution.mode === 'todo') {
  registerTodo('discovery golden numeric liveness pairing', processResolution.message);
} else if (presentRegistryCells.length === 0) {
  registerTodo('discovery golden numeric liveness pairing', resolveCell(FIXTURES_ROOT, registryCells[0]).message);
} else {
  test('discovery golden numeric liveness pairing', async () => {
    const metaPath = path.join(path.dirname(processResolution.rawPath), 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const tzMatch = /TZ=([A-Za-z][A-Za-z0-9_+/-]*)/.exec(meta.provokedBy ?? '');
    assert.ok(tzMatch, 'ps-lstart meta.provokedBy must include TZ=<Area/City>');

    const procsUrl = pathToFileURL(path.join(ROOT, 'src', 'io', 'procs.js')).href;
    const encoded = readFileSync(processResolution.rawPath).toString('base64');
    const script = `
      import { parsePsPidLstart } from ${JSON.stringify(procsUrl)};
      const raw = Buffer.from(${JSON.stringify(encoded)}, 'base64').toString('utf8');
      process.stdout.write(JSON.stringify([...parsePsPidLstart(raw)]));
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      env: { TZ: tzMatch[1], PATH: process.env.PATH ?? '' },
    });
    const observed = new Map(JSON.parse(stdout));

    const registryStarts = new Map();
    for (const cell of presentRegistryCells) {
      for (const envelope of registryEnvelopes(cell)) {
        registryStarts.set(envelope.fields.pid, parseCtime(envelope.fields.procStart, { utc: true }));
      }
    }
    const shared = [...registryStarts.keys()].filter((pid) => observed.has(pid));
    assert.ok(
      shared.length > 0,
      `no shared pid between registry [${[...registryStarts.keys()].join(', ')}] and ps [${[...observed.keys()].join(', ')}]`,
    );
    for (const pid of shared) assert.ok(Math.abs(registryStarts.get(pid) - observed.get(pid)) <= 1);
  });
}
