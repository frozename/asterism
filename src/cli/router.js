import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERB_NAME = /^[a-z][a-z0-9-]*$/;

export async function listVerbs(verbsDir) {
  let entries;
  try {
    entries = await readdir(verbsDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => entry.slice(0, -3))
    .sort();
}

// Existence is checked with `stat` so a name that fails the guard, or names
// no file, resolves to null; a real verb's import is never wrapped in a
// catch here, so a syntax error in its module propagates to the caller
// instead of being swallowed as "unknown verb".
export async function loadVerb(verbName, verbsDir) {
  if (!VERB_NAME.test(verbName)) return null;

  const verbPath = path.join(verbsDir, `${verbName}.js`);
  try {
    await stat(verbPath);
  } catch {
    return null;
  }

  return import(pathToFileURL(verbPath).href);
}
