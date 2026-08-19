import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { MUTANTS } from '../harness/mutants/mutants.mjs';
import { copyTree, runAll, runMutant } from '../harness/mutants/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUTANT_ID = /^MUT-[A-Z0-9-]+$/;

if (Object.hasOwn(process.env, 'ASTERISM_MUTANT_RUN')) {
  test('skipped inside a mutant run', { skip: 'inside a mutant run' }, () => {});
} else {
  test('every mutant id is valid and unique', () => {
    assert.ok(MUTANTS.length > 0);

    const seen = new Set();
    for (const mutant of MUTANTS) {
      assert.match(mutant.id, MUTANT_ID, `${mutant.id} should match ${MUTANT_ID}`);
      assert.ok(!seen.has(mutant.id), `${mutant.id} is duplicated`);
      seen.add(mutant.id);
    }
  });

  test('every mutant claims at least one existing test file', () => {
    for (const mutant of MUTANTS) {
      assert.ok(
        Array.isArray(mutant.claimedBy) && mutant.claimedBy.length > 0,
        `${mutant.id} has an empty claimedBy`,
      );

      for (const relative of mutant.claimedBy) {
        const absolute = path.join(ROOT, relative);
        assert.ok(existsSync(absolute), `${mutant.id} claims ${relative}, which does not exist`);
      }
    }
  });

  test('every mutant\'s "find" occurs exactly once in its file on the real tree', async () => {
    for (const mutant of MUTANTS) {
      const source = await readFile(path.join(ROOT, mutant.file), 'utf8');
      const occurrences = source.split(mutant.find).length - 1;
      assert.equal(
        occurrences,
        1,
        `${mutant.id}: "find" occurs ${occurrences} time(s) in ${mutant.file}, expected exactly 1 -- ` +
          'it may have gone stale when the source was edited',
      );
    }
  });

  test('runAll kills every curated mutant', async (t) => {
    const { results, summary } = await runAll({ repoRoot: ROOT });

    for (const result of results) {
      t.diagnostic(`${result.id}  ${result.outcome}  ${result.detail ?? ''}`);
    }

    for (const result of results) {
      assert.equal(result.outcome, 'killed', `${result.id} should be killed, was ${result.outcome}: ${result.detail ?? ''}`);
    }

    assert.deepEqual(summary, { killed: MUTANTS.length, survived: 0, unapplied: 0, unclaimed: 0 });
  });

  test('control: a mutant whose "find" does not exist is reported unapplied', async () => {
    const synthetic = {
      id: 'MUT-CONTROL-UNAPPLIED',
      file: 'src/core/enums.js',
      find: 'this string does not appear anywhere in enums.js',
      replace: 'irrelevant',
      claimedBy: ['test/enums.test.mjs'],
    };

    const result = await runMutant(synthetic, { repoRoot: ROOT });
    assert.equal(result.outcome, 'unapplied');
  });

  test('control: a mutant with an empty claimedBy is reported unclaimed without running', async () => {
    const synthetic = {
      id: 'MUT-CONTROL-UNCLAIMED',
      file: 'src/core/enums.js',
      find: `  High: 'high',\n});`,
      replace: `  High: 'high',\n  Now: 'now',\n});`,
      claimedBy: [],
    };

    const result = await runMutant(synthetic, { repoRoot: ROOT });
    assert.equal(result.outcome, 'unclaimed');
  });

  test('control: a mutation the claiming test cannot see is reported survived', async () => {
    const synthetic = {
      id: 'MUT-CONTROL-SURVIVED',
      file: 'src/core/enums.js',
      find: '// Deliberately no `now`/`urgent` value',
      replace: '// deliberately no now/urgent value (comment reworded, no behavior change)',
      claimedBy: ['test/enums.test.mjs'],
    };

    const result = await runMutant(synthetic, { repoRoot: ROOT });
    assert.equal(result.outcome, 'survived', `expected survived, got ${result.outcome}: ${result.detail ?? ''}`);
  });

  test('copyTree throws when a required entry is missing, instead of silently running a truncated copy', async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), 'asterism-copytree-src-'));
    const dest = await mkdtemp(path.join(os.tmpdir(), 'asterism-copytree-dest-'));

    try {
      await mkdir(path.join(src, 'bin'));
      await mkdir(path.join(src, 'src'));
      await mkdir(path.join(src, 'harness'));
      // 'test' is deliberately missing
      await writeFile(path.join(src, 'package.json'), '{}');

      await assert.rejects(() => copyTree(src, dest), /required entry "test" is missing/);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  test('copyTree control: every required entry present, fixtures/ absent, copy succeeds without it', async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), 'asterism-copytree-src-'));
    const dest = await mkdtemp(path.join(os.tmpdir(), 'asterism-copytree-dest-'));

    try {
      for (const entry of ['bin', 'src', 'harness', 'test']) {
        await mkdir(path.join(src, entry));
      }
      await writeFile(path.join(src, 'package.json'), '{}');

      await copyTree(src, dest);

      for (const entry of ['bin', 'src', 'harness', 'test', 'package.json']) {
        assert.ok(existsSync(path.join(dest, entry)), `${entry} should have been copied`);
      }
      assert.equal(existsSync(path.join(dest, 'fixtures')), false, 'fixtures/ was never present, so it must stay absent');
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });
}
