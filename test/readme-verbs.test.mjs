import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { listVerbs, loadVerb } from '../src/cli/router.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README_PATH = path.join(ROOT, 'README.md');
const VERBS_DIR = path.join(ROOT, 'src', 'cli', 'verbs');
const MINIMUM_VERB_ROWS = 14;

function parseVerbRows(markdown) {
  const section = markdown.match(/^## Verbs\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m)?.[1] ?? '';
  const rows = [];

  for (const line of section.split('\n')) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 3) continue;

    const command = cells[0].match(/^`ast ([a-z][a-z0-9-]*)(?: [^`]*)?`$/);
    if (command === null) continue;

    const mutating = cells[2] === 'yes' ? true : cells[2] === 'no' ? false : null;
    rows.push({ name: command[1], mutating });
  }

  return rows;
}

function verbTableProblems(rows, verbs) {
  const rowsByName = new Map(rows.map((row) => [row.name, row]));
  const verbsByName = new Map(verbs.map((verb) => [verb.name, verb]));

  return [
    ...verbs
      .filter((verb) => !rowsByName.has(verb.name))
      .map((verb) => `README table is missing verb file ${verb.name}.js`),
    ...rows
      .filter((row) => !verbsByName.has(row.name))
      .map((row) => `README table names nonexistent verb file ${row.name}.js`),
    ...rows
      .filter((row) => verbsByName.has(row.name) && row.mutating !== verbsByName.get(row.name).mutating)
      .map(
        (row) =>
          `README table marks ${row.name}.js mutating=${String(row.mutating)}; module exports ${String(verbsByName.get(row.name).mutating)}`,
      ),
  ];
}

test('README verb table matches every verb file and its mutating export', async () => {
  const markdown = await readFile(README_PATH, 'utf8');
  const rows = parseVerbRows(markdown);
  assert.ok(rows.length >= MINIMUM_VERB_ROWS, `expected at least ${MINIMUM_VERB_ROWS} verb rows, found ${rows.length}`);

  const names = await listVerbs(VERBS_DIR);
  const verbs = await Promise.all(
    names.map(async (name) => {
      const module = await loadVerb(name, VERBS_DIR);
      return { name, mutating: module.mutating };
    }),
  );

  assert.deepEqual(verbTableProblems(rows, verbs), []);
});

test('verb-table controls detect missing, nonexistent, and wrong-mutating rows', () => {
  const verbs = [
    { name: 'go', mutating: true },
    { name: 'ls', mutating: false },
  ];

  assert.deepEqual(verbTableProblems([{ name: 'ls', mutating: false }], verbs), [
    'README table is missing verb file go.js',
  ]);
  assert.deepEqual(
    verbTableProblems(
      [
        { name: 'go', mutating: true },
        { name: 'ls', mutating: false },
        { name: 'nope', mutating: false },
      ],
      verbs,
    ),
    ['README table names nonexistent verb file nope.js'],
  );
  assert.deepEqual(
    verbTableProblems(
      [
        { name: 'go', mutating: false },
        { name: 'ls', mutating: false },
      ],
      verbs,
    ),
    ['README table marks go.js mutating=false; module exports true'],
  );
});
