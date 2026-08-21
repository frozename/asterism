#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MUTANTS } from './mutants.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUIRED_COPY_ENTRIES = Object.freeze(['bin', 'src', 'harness', 'test', 'package.json']);
const OPTIONAL_COPY_ENTRIES = Object.freeze(['ARCHITECTURE.md', 'fixtures', 'schema', 'vectors']);
const TAIL_LINES = 40;

export async function runMutant(mutant, { repoRoot }) {
  const unclaimedReason = unclaimedDetail(mutant, repoRoot);
  if (unclaimedReason !== null) {
    return { id: mutant.id, outcome: 'unclaimed', detail: unclaimedReason };
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'asterism-mutant-'));

  try {
    await copyTree(repoRoot, tmpDir);

    const targetPath = path.join(tmpDir, mutant.file);
    const original = await readFile(targetPath, 'utf8');
    const occurrences = countOccurrences(original, mutant.find);

    if (occurrences !== 1) {
      return {
        id: mutant.id,
        outcome: 'unapplied',
        detail: `"find" matched ${occurrences} time(s) in ${mutant.file}, expected exactly 1`,
      };
    }

    const mutated = original.replace(mutant.find, () => mutant.replace);
    await writeFile(targetPath, mutated, 'utf8');

    const env = { PATH: process.env.PATH ?? '', HOME: tmpDir, ASTERISM_MUTANT_RUN: '1' };

    try {
      const { stdout, stderr } = await execFileAsync(
        'node',
        ['--test', ...mutant.claimedBy],
        { cwd: tmpDir, env, maxBuffer: 16 * 1024 * 1024 },
      );
      return {
        id: mutant.id,
        outcome: 'survived',
        exitCode: 0,
        tail: tailOf(`${stdout}${stderr}`),
        detail: `claiming test(s) stayed green under the mutation: ${mutant.claimedBy.join(', ')}`,
      };
    } catch (error) {
      const exitCode = typeof error.code === 'number' ? error.code : 1;
      return {
        id: mutant.id,
        outcome: 'killed',
        exitCode,
        tail: tailOf(`${error.stdout ?? ''}${error.stderr ?? ''}`),
        detail: `exit ${exitCode}`,
      };
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function runAll({ repoRoot, only } = {}) {
  const selected = MUTANTS.filter((mutant) => !only || mutant.id === only);
  const results = [];

  for (const mutant of selected) {
    results.push(await runMutant(mutant, { repoRoot }));
  }

  const summary = { killed: 0, survived: 0, unapplied: 0, unclaimed: 0 };
  for (const result of results) summary[result.outcome] += 1;

  return { results, summary };
}

function unclaimedDetail(mutant, repoRoot) {
  if (!Array.isArray(mutant.claimedBy) || mutant.claimedBy.length === 0) {
    return 'claimedBy is empty';
  }

  const missing = mutant.claimedBy.filter((relative) => !existsSync(path.join(repoRoot, relative)));
  if (missing.length > 0) {
    return `missing claimed test file(s): ${missing.join(', ')}`;
  }

  return null;
}

// A required entry missing from repoRoot means the tree the runner is about
// to mutate and test isn't the real repo -- silently skipping it would run
// every mutant's claiming test against a truncated copy and "kill" it for
// the wrong reason. fixtures/ is the one entry allowed to be absent.
export async function copyTree(repoRoot, destRoot) {
  for (const entry of REQUIRED_COPY_ENTRIES) {
    const source = path.join(repoRoot, entry);
    if (!existsSync(source)) {
      throw new Error(`copyTree: required entry "${entry}" is missing under ${repoRoot}`);
    }
    await cp(source, path.join(destRoot, entry), { recursive: true });
  }

  for (const entry of OPTIONAL_COPY_ENTRIES) {
    const source = path.join(repoRoot, entry);
    if (!existsSync(source)) continue;
    await cp(source, path.join(destRoot, entry), { recursive: true });
  }
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

function tailOf(text) {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join('\n');
}

function parseArgs(argv) {
  const options = { only: null, json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--only') {
      options.only = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

async function main(argv) {
  if (Object.hasOwn(process.env, 'ASTERISM_MUTANT_RUN')) {
    process.stderr.write(
      'harness/mutants/run.mjs: refusing to run -- ASTERISM_MUTANT_RUN is already set in this process\'s ' +
        'environment, which would recurse a mutant run inside a mutant run\n',
    );
    return 3;
  }

  const options = parseArgs(argv);
  const { results, summary } = await runAll({ repoRoot: ROOT, only: options.only });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ results, summary }, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`${result.id}  ${result.outcome}  ${result.detail ?? ''}\n`);
    }
    process.stdout.write(
      `killed=${summary.killed} survived=${summary.survived} unapplied=${summary.unapplied} unclaimed=${summary.unclaimed}\n`,
    );
  }

  const allKilled = results.length > 0 && summary.killed === results.length;
  return allKilled ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`harness/mutants/run.mjs: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
