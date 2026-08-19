import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'package.json',
);

export const mutating = false;
export const summary = 'print the installed asterism version';

export async function run(_argv, _ctx) {
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'));
  process.stdout.write(`${packageJson.version}\n`);
  return 0;
}
