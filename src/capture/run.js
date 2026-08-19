import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adapters } from '../adapters/index.js';
import { scrub } from '../core/scrub.js';
import { procexec } from '../io/procexec.js';
import { captures as tmuxCaptures } from './tmux.js';

export const CELL_ID_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

export function listKnownCells() {
  const recipes = [...tmuxCaptures];
  for (const adapter of adapters.values()) {
    if (adapter.captures) recipes.push(...adapter.captures);
  }
  return recipes
    .map((recipe) => ({ cell: recipe.cell, source: recipe.source }))
    .sort((a, b) => (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0));
}

export function resolveRecipe(cellId) {
  const segment = cellId.split('/')[0];

  if (segment === 'tmux') {
    const recipe = tmuxCaptures.find((entry) => entry.cell === cellId);
    return recipe ? { recipe, kind: 'tmux', adapter: null } : null;
  }

  const adapter = adapters.get(segment);
  if (!adapter || !adapter.captures) return null;

  const recipe = adapter.captures.find((entry) => entry.cell === cellId);
  return recipe ? { recipe, kind: 'adapter', adapter } : null;
}

export async function captureCell(cellId, { home, env, cwd, repoRoot, provokedBy = '', fromPath }) {
  if (!CELL_ID_PATTERN.test(cellId)) {
    return { ok: false, exitCode: 2, message: `invalid cell id "${cellId}"` };
  }

  const resolved = resolveRecipe(cellId);
  if (!resolved) {
    return {
      ok: false,
      exitCode: 2,
      message: `unknown cell "${cellId}". known cells:\n${listKnownCells()
        .map((entry) => entry.cell)
        .join('\n')}`,
    };
  }

  const { recipe, kind, adapter } = resolved;
  const isManual = recipe.source === 'manual';

  if (fromPath !== undefined && !isManual) {
    return { ok: false, exitCode: 2, message: 'only manual cells take --from' };
  }
  if (isManual && fromPath === undefined) {
    return {
      ok: false,
      exitCode: 2,
      message: `manual cell "${cellId}" requires --from <path>: ${recipe.provoke}`,
    };
  }

  let text;
  let command;
  let cliVersion = null;
  let tmuxVersion = null;
  let profileHash = 'absent';

  if (kind === 'tmux') {
    const outcome = await recipe.run({ env });
    if (!outcome.ok) {
      return { ok: false, exitCode: 1, message: outcome.message };
    }
    text = outcome.text;
    command = outcome.command;
    tmuxVersion = outcome.version;
  } else {
    const recipeEnv = recipe.env ? recipe.env(home) : {};
    const mergedEnv = { ...env, ...recipeEnv };

    if (recipe.source === 'argv') {
      const result = await procexec(recipe.argv, { env: mergedEnv, cwd });
      text = result.stdout.toString('utf8');
      command = recipe.argv;
    } else if (recipe.source === 'file') {
      const result = await readFileSource(recipe, home);
      text = result.text;
      command = result.command;
    } else if (recipe.source === 'manual') {
      let result;
      try {
        result = await readManualSource(fromPath);
      } catch (error) {
        return {
          ok: false,
          exitCode: 2,
          message: `--from: cannot read ${fromPath}: ${error.code ?? error.message}`,
        };
      }
      text = result.text;
      command = result.command;
    } else {
      return { ok: false, exitCode: 1, message: `recipe "${cellId}" has unknown source "${recipe.source}"` };
    }

    cliVersion = await resolveCliVersion(recipe, mergedEnv);
    profileHash = await resolveProfileHash(adapter, home);
  }

  if (Buffer.byteLength(text, 'utf8') === 0) {
    return { ok: false, exitCode: 1, message: `capture of "${cellId}" produced 0 bytes -- state was not provoked` };
  }

  const scrubOpts = { home, extraRoots: [repoRoot] };
  const { text: scrubbedText, redactions } = scrub(text, scrubOpts);
  const raw = Buffer.from(scrubbedText, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');

  const meta = scrubMetaStrings(
    {
      cell: cellId,
      sha256,
      bytes: raw.length,
      capturedAt: new Date().toISOString(),
      provokedBy,
      command,
      cliVersion,
      tmuxVersion,
      profileHash,
      redactions,
      kills: [],
    },
    scrubOpts,
  );

  const cellDir = path.join(cwd, 'fixtures', ...cellId.split('/'));
  await writeCellAtomic(cellDir, raw, meta);

  return { ok: true, exitCode: 0, cellId, bytes: raw.length, redactionCount: redactions.length, cellDir };
}

async function readFileSource(recipe, home) {
  const pattern = recipe.file(home);
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const matcher = globToRegExp(base);

  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { text: '', command: `read ${pattern}` };
  }

  const names = entries.filter((entry) => matcher.test(entry)).sort();
  const parts = [];
  for (const name of names) {
    const content = await readFile(path.join(dir, name), 'utf8');
    parts.push(`### ${name}\n${content}`);
  }

  return { text: parts.join(''), command: `read ${pattern}` };
}

async function readManualSource(fromPath) {
  const text = await readFile(fromPath, 'utf8');
  return { text, command: ['read', fromPath] };
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

async function resolveCliVersion(recipe, env) {
  if (!recipe.cliVersionArgv) return null;
  try {
    const result = await procexec(recipe.cliVersionArgv, { env, timeoutMs: 10000 });
    const text = result.stdout.toString('utf8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function resolveProfileHash(adapter, home) {
  if (!adapter || typeof adapter.profileFile !== 'function') return 'absent';

  try {
    const content = await readFile(adapter.profileFile(home));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return 'absent';
  }
}

// sha256 and profileHash are hex digests, not free text -- scrubbing them
// would flag their own hex-ness as a leak and corrupt the identity value a
// caller verifies byte-exact, so they're the one thing this walk skips.
const UNSCRUBBED_META_FIELDS = new Set(['sha256', 'profileHash']);

function scrubMetaStrings(meta, opts) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(meta)) {
    scrubbed[key] = UNSCRUBBED_META_FIELDS.has(key) ? value : scrubValue(value, opts);
  }
  return scrubbed;
}

function scrubValue(value, opts) {
  if (typeof value === 'string') return scrub(value, opts).text;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, opts));
  return value;
}

async function writeCellAtomic(cellDir, raw, meta) {
  await mkdir(cellDir, { recursive: true });
  const metaJson = `${JSON.stringify(meta, null, 2)}\n`;

  await atomicWrite(path.join(cellDir, 'raw'), raw);
  await atomicWrite(path.join(cellDir, 'meta.json'), metaJson);
}

async function atomicWrite(targetPath, data) {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, targetPath);
}
