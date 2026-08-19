import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { adapters } from '../src/adapters/index.js';
import { captures as tmuxCaptures } from '../src/capture/tmux.js';
import { parseToml } from '../src/core/toml.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'fixtures', 'MANIFEST.toml');

function loadManifest() {
  return parseToml(readFileSync(MANIFEST_PATH, 'utf8'));
}

function recipeCellSet() {
  const cells = new Set(tmuxCaptures.map((recipe) => recipe.cell));
  for (const adapter of adapters.values()) {
    if (adapter.captures) {
      for (const recipe of adapter.captures) cells.add(recipe.cell);
    }
  }
  return cells;
}

function manifestCapturableCellSet(manifest) {
  const cells = new Set();
  for (const [id, cell] of Object.entries(manifest?.cells ?? {})) {
    if (cell.kind === 'required' || cell.kind === 'manual') cells.add(id);
  }
  return cells;
}

// The one comparison function both the real assertion and its control run
// through, so a passing control is evidence the real assertion below means
// something.
function compareCellSets(manifestCells, recipeCells) {
  const manifestOnly = [...manifestCells].filter((id) => !recipeCells.has(id)).sort();
  const recipeOnly = [...recipeCells].filter((id) => !manifestCells.has(id)).sort();
  return { manifestOnly, recipeOnly };
}

test('every required/manual manifest cell has a matching capture recipe, and every recipe has a manifest cell', () => {
  const manifest = loadManifest();
  const manifestCells = manifestCapturableCellSet(manifest);
  const recipeCells = recipeCellSet();

  const { manifestOnly, recipeOnly } = compareCellSets(manifestCells, recipeCells);

  assert.deepEqual(manifestOnly, [], `manifest cells with no capture recipe: ${manifestOnly.join(', ')}`);
  assert.deepEqual(recipeOnly, [], `capture recipes with no manifest cell: ${recipeOnly.join(', ')}`);
});

test('control: a synthetic manifest cell with no recipe is reported by the same comparison function', () => {
  const { manifestOnly, recipeOnly } = compareCellSets(
    new Set(['tmux/list-panes', 'ghost/no-recipe']),
    new Set(['tmux/list-panes']),
  );
  assert.deepEqual(manifestOnly, ['ghost/no-recipe']);
  assert.deepEqual(recipeOnly, []);

  const reverse = compareCellSets(new Set(['tmux/list-panes']), new Set(['tmux/list-panes', 'tmux/ghost-recipe']));
  assert.deepEqual(reverse.manifestOnly, []);
  assert.deepEqual(reverse.recipeOnly, ['tmux/ghost-recipe']);

  const clean = compareCellSets(new Set(['tmux/list-panes']), new Set(['tmux/list-panes']));
  assert.deepEqual(clean.manifestOnly, []);
  assert.deepEqual(clean.recipeOnly, []);
});
