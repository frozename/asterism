import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildIdentityManifest, verifyIdentity } from '../src/io/identity.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const TEST_INSTALL_ID = 'TESTULID0000000000000000';

async function makeEnv(prefix) {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(base, 'home');
  const stateHome = path.join(base, 'state');
  const configHome = path.join(base, 'config');
  const emptyPath = path.join(base, 'empty-path');
  await Promise.all([home, stateHome, configHome, emptyPath].map((dir) => mkdir(dir, { recursive: true })));
  return {
    base,
    home,
    stateDir: path.join(stateHome, 'asterism'),
    env: {
      PATH: `${emptyPath}${path.delimiter}${path.dirname(process.execPath)}`,
      HOME: home,
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: configHome,
      TERM: 'dumb',
    },
  };
}

async function runAst(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [AST_BIN, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('identity manifest hashes every bin/src file and verification fails closed', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ast-identity-unit-'));
  const root = path.join(base, 'root');
  const stateDir = path.join(base, 'state');
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(root, 'bin', 'x'), 'x\n');
  await writeFile(path.join(root, 'src', 'y.js'), 'export const y = 1;\n');

  const manifest = await buildIdentityManifest({ root, mint: () => TEST_INSTALL_ID });
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(manifest.installId, TEST_INSTALL_ID);
  assert.deepEqual(Object.keys(manifest.files), ['bin/x', 'src/y.js']);
  for (const sha of Object.values(manifest.files)) assert.match(sha, /^[0-9a-f]{64}$/);

  const identityPath = path.join(stateDir, 'identity.json');
  await writeFile(identityPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.deepEqual(await verifyIdentity({ root, stateDir }), { status: 'pass' });

  await writeFile(path.join(root, 'src', 'y.js'), 'export const y = 2;\n');
  const mismatch = await verifyIdentity({ root, stateDir });
  assert.equal(mismatch.status, 'fail');
  assert.match(mismatch.note, new RegExp(identityPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(mismatch.note, /src\/y\.js/);

  await writeFile(identityPath, '{not-json\n');
  const corrupt = await verifyIdentity({ root, stateDir });
  assert.equal(corrupt.status, 'fail');
  assert.match(corrupt.note, /identity\.json/);

  await rm(identityPath);
  const unknown = await verifyIdentity({ root, stateDir });
  assert.equal(unknown.status, 'unknown');
  assert.match(unknown.note, /run ast init/);

  const preserved = await buildIdentityManifest({ root, mint: () => 'NEW', previousInstallId: 'KEEP' });
  assert.equal(preserved.installId, 'KEEP');
});

test('R9 refuses only mismatched mutating runs and init repairs the manifest', async () => {
  const sandbox = await makeEnv('ast-identity-r9-');
  assert.equal((await runAst(['init'], sandbox.env)).code, 0);
  assert.equal((await runAst(['fixture', 'list'], sandbox.env)).code, 0);

  const identityPath = path.join(sandbox.stateDir, 'identity.json');
  const manifest = JSON.parse(await readFile(identityPath, 'utf8'));
  const firstPath = Object.keys(manifest.files)[0];
  manifest.files[firstPath] = '0'.repeat(64);
  await writeFile(identityPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const refused = await runAst(['fixture', 'list'], sandbox.env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /R9/);
  assert.ok(refused.stderr.includes(identityPath));
  assert.equal((await runAst(['ls'], sandbox.env)).code, 0);

  assert.equal((await runAst(['init'], sandbox.env)).code, 0);
  assert.equal((await runAst(['fixture', 'list'], sandbox.env)).code, 0);

  const fresh = await makeEnv('ast-identity-absent-');
  assert.equal((await runAst(['fixture', 'list'], fresh.env)).code, 0);

  const repaired = JSON.parse(await readFile(identityPath, 'utf8'));
  assert.notEqual(repaired.files[firstPath], '0'.repeat(64));
});
