import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createUlidMinter } from '../core/ulid.js';
import { resolveStateDir } from './store.js';

function repoRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

async function listTreeFiles(root) {
  const files = [];

  async function visit(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile()) files.push(filePath);
    }
  }

  await visit(path.join(root, 'bin'));
  await visit(path.join(root, 'src'));
  return files.sort((a, b) => repoRelative(root, a).localeCompare(repoRelative(root, b)));
}

async function hashTree(root) {
  const files = {};
  for (const filePath of await listTreeFiles(root)) {
    files[repoRelative(root, filePath)] = createHash('sha256').update(await readFile(filePath)).digest('hex');
  }
  return files;
}

export async function buildIdentityManifest({
  root,
  mint = createUlidMinter({ now: Date.now, random: randomBytes }),
  previousInstallId = null,
}) {
  const manifest = {
    installId: previousInstallId ?? mint(),
    installPath: await realpath(root),
    files: Object.freeze(await hashTree(root)),
  };
  return Object.freeze(manifest);
}

function fail(identityPath, detail) {
  return { status: 'fail', note: `${identityPath}: ${detail}` };
}

export async function verifyIdentity({ root, stateDir }) {
  const identityPath = path.join(stateDir, 'identity.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(identityPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'unknown', note: `${identityPath}: identity manifest is absent; run ast init` };
    }
    return fail(identityPath, `identity manifest is unparseable: ${error?.message ?? error}`);
  }

  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    typeof manifest.installId !== 'string' ||
    typeof manifest.installPath !== 'string' ||
    manifest.files === null ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  ) {
    return fail(identityPath, 'identity manifest has an invalid shape');
  }

  let current;
  try {
    current = await buildIdentityManifest({ root, previousInstallId: manifest.installId });
  } catch (error) {
    return fail(identityPath, `installed tree could not be checked: ${error?.message ?? error}`);
  }

  if (manifest.installPath !== current.installPath) {
    return fail(identityPath, `installPath does not match ${current.installPath}`);
  }

  const keys = [...new Set([...Object.keys(manifest.files), ...Object.keys(current.files)])].sort();
  for (const key of keys) {
    if (!Object.hasOwn(manifest.files, key)) return fail(identityPath, `${key} is extra in the installed tree`);
    if (!Object.hasOwn(current.files, key)) return fail(identityPath, `${key} is missing from the installed tree`);
    if (manifest.files[key] !== current.files[key]) return fail(identityPath, `${key} sha256 does not match`);
  }

  return { status: 'pass' };
}

export async function guardIdentity({ root, env }) {
  let stateDir;
  try {
    stateDir = resolveStateDir(env);
  } catch {
    return null;
  }

  const identityPath = path.join(stateDir, 'identity.json');
  const result = await verifyIdentity({ root, stateDir });
  if (result.status === 'pass' || result.status === 'unknown') return null;
  return Object.freeze({ path: identityPath, note: result.note });
}

export { verifyIdentity as checkIdentitySha };
