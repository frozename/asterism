import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { adapters } from '../src/adapters/index.js';
import { countSymbols, locateBinary, makeLedgerEntries } from '../src/probe/static.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');

async function runAst(args, home) {
  const env = { PATH: process.env.PATH, HOME: home, TERM: 'dumb' };

  try {
    const { stdout, stderr } = await execFileAsync(AST_BIN, args, { cwd: ROOT, encoding: 'utf8', env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function referenceCount(content, symbol) {
  const buf = Buffer.from(content, 'utf8');
  const needle = Buffer.from(symbol, 'utf8');
  let count = 0;
  let at = buf.indexOf(needle, 0);
  while (at !== -1) {
    count += 1;
    at = buf.indexOf(needle, at + needle.length);
  }
  return count;
}

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- countSymbols ----

test('countSymbols counts a straddling occurrence once, an absent symbol zero times, and adjacent occurrences twice', async () => {
  await withTempDir('ast-probe-symbols-', async (dir) => {
    const filePath = path.join(dir, 'binary');

    const prefix = '0123456789xxx'; // 13 bytes: indices 0-12
    const straddler = 'MARK123'; // 7 bytes: indices 13-19, crosses the byte-16 chunk boundary
    const suffix = 'ABAByyyyyyyy'; // 12 bytes: indices 20-31, "AB" occurs twice, adjacent
    await writeFile(filePath, prefix + straddler + suffix, 'utf8');

    const counts = await countSymbols(filePath, ['MARK123', 'zzzabsent', 'AB'], { chunkBytes: 16 });

    assert.deepEqual(counts, { MARK123: 1, zzzabsent: 0, AB: 2 });
  });
});

// ---- locateBinary ----

test('locateBinary picks the highest name under a semver-aware comparison', async () => {
  await withTempDir('ast-probe-versions-', async (dir) => {
    for (const name of ['1.0.9', '1.0.10', '0.9.99']) {
      await writeFile(path.join(dir, name), 'x', 'utf8');
    }

    const adapter = { staticProbe: { binaryCandidates: () => [{ dir, pick: 'newest' }] } };
    const result = await locateBinary(adapter, { home: '/unused' });

    assert.equal(result.version, '1.0.10');
    assert.equal(result.path, `${dir}/1.0.10`);
  });
});

test('locateBinary returns null for an empty directory and for a missing directory', async () => {
  await withTempDir('ast-probe-empty-', async (dir) => {
    const emptyAdapter = { staticProbe: { binaryCandidates: () => [{ dir, pick: 'newest' }] } };
    assert.equal(await locateBinary(emptyAdapter, { home: '/unused' }), null);

    const missingAdapter = {
      staticProbe: { binaryCandidates: () => [{ dir: path.join(dir, 'does-not-exist'), pick: 'newest' }] },
    };
    assert.equal(await locateBinary(missingAdapter, { home: '/unused' }), null);
  });
});

test('locateBinary never picks a directory entry, even one that sorts higher than every file', async () => {
  await withTempDir('ast-probe-dirent-', async (dir) => {
    await writeFile(path.join(dir, '1.0.0'), 'x', 'utf8');
    await mkdir(path.join(dir, '9.9.99'));

    const adapter = { staticProbe: { binaryCandidates: () => [{ dir, pick: 'newest' }] } };
    const result = await locateBinary(adapter, { home: '/unused' });

    assert.equal(result.version, '1.0.0');
  });
});

// ---- makeLedgerEntries ----

test('makeLedgerEntries marks every entry non-gating symbol-extraction evidence and never leaks a path', () => {
  const entries = makeLedgerEntries({
    adapter: 'x',
    binary: { version: '1.2.3', bytes: 4096, path: '/should/not/leak' },
    counts: { a: 2, b: 0 },
    at: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.source, 'symbol-extraction');
    assert.equal(entry.gates, false);
    assert.equal(JSON.stringify(entry).includes('/should/not/leak'), false);
  }

  assert.deepEqual(entries[0], {
    adapter: 'x',
    symbol: 'a',
    present: true,
    count: 2,
    source: 'symbol-extraction',
    gates: false,
    binary: { version: '1.2.3', bytes: 4096 },
    at: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(entries[1].present, false);
});

// ---- end to end via bin/ast ----

test('end to end: probe --static --json counts every registry symbol from a fake home', async () => {
  await withTempDir('ast-probe-home-', async (fakeHome) => {
    const expected = [];

    for (const adapter of adapters.values()) {
      for (const candidate of adapter.staticProbe.binaryCandidates(fakeHome)) {
        await mkdir(candidate.dir, { recursive: true });

        const parts = [];
        for (const symbol of adapter.staticProbe.symbols) parts.push(symbol, symbol, symbol);
        parts.push('zzz-noise-zzz-filler-zzz-noise-zzz');
        const content = parts.join('---');

        await writeFile(path.join(candidate.dir, '1.0.0'), content, 'utf8');

        for (const symbol of adapter.staticProbe.symbols) {
          expected.push({ adapter: adapter.id, symbol, count: referenceCount(content, symbol) });
        }
      }
    }

    const { code, stdout, stderr } = await runAst(['probe', '--static', '--json', '--home', fakeHome], fakeHome);

    assert.equal(code, 0);
    assert.equal(stderr, '');

    const entries = JSON.parse(stdout);
    assert.equal(entries.length, expected.length);

    for (const want of expected) {
      const got = entries.find((entry) => entry.adapter === want.adapter && entry.symbol === want.symbol);
      assert.ok(got, `missing entry for ${want.adapter}/${want.symbol}`);
      assert.equal(got.count, want.count);
      assert.equal(got.present, want.count > 0);
      assert.equal(got.source, 'symbol-extraction');
      assert.equal(got.gates, false);
      assert.equal(JSON.stringify(got).includes(fakeHome), false);
    }
  });
});

test('end to end: probe --static exits 1 and reports "no binary found" with ~ instead of the real home when nothing is installed', async () => {
  await withTempDir('ast-probe-nohome-', async (emptyHome) => {
    const { code, stderr } = await runAst(['probe', '--static', '--home', emptyHome], emptyHome);

    assert.equal(code, 1);
    assert.match(stderr, /no binary found under/);
    assert.equal(stderr.includes(emptyHome), false);
    assert.equal(stderr.includes('~'), true);
  });
});

test('probe without --static prints usage and exits 2; probe --static with a located binary exits 0 (control pair)', async () => {
  await withTempDir('ast-probe-noflag-', async (home) => {
    const missing = await runAst(['probe'], home);
    assert.equal(missing.code, 2);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr.toLowerCase(), /usage/);

    for (const adapter of adapters.values()) {
      for (const candidate of adapter.staticProbe.binaryCandidates(home)) {
        await mkdir(candidate.dir, { recursive: true });
        await writeFile(path.join(candidate.dir, '1.0.0'), adapter.staticProbe.symbols[0], 'utf8');
      }
    }

    const present = await runAst(['probe', '--static', '--home', home], home);
    assert.equal(present.code, 0);
  });
});

test('probe --static rejects an unknown flag with exit 2', async () => {
  await withTempDir('ast-probe-badflag-', async (home) => {
    const { code, stderr } = await runAst(['probe', '--static', '--bogus'], home);
    assert.equal(code, 2);
    assert.match(stderr.toLowerCase(), /usage/);
  });
});

test('probe --static --adapter rejects an unknown adapter id, and accepts a registered one (control pair)', async () => {
  await withTempDir('ast-probe-adapterflag-', async (home) => {
    const knownId = [...adapters.keys()][0];

    const bad = await runAst(['probe', '--static', '--adapter', 'not-a-real-adapter', '--home', home], home);
    assert.equal(bad.code, 2);

    const good = await runAst(['probe', '--static', '--adapter', knownId, '--home', home], home);
    assert.equal(good.code, 1);
    assert.match(good.stderr, new RegExp(`^probe: ${knownId}:`));
  });
});
