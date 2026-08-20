import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildRegistry } from '../src/adapters/index.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const adapter = [...buildRegistry({}).values()][0];

async function sandbox(prefix) {
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
    configDir: path.join(configHome, 'asterism'),
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

function bytesSha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function treeSha(root) {
  const hash = createHash('sha256');
  async function walk(current, relative) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        hash.update(`A ${relative}\n`);
        return;
      }
      throw error;
    }
    hash.update(`D ${relative}\n`);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) hash.update(`F ${childRelative}\0`).update(await readFile(child));
    }
  }
  await walk(root, '');
  return hash.digest('hex');
}

async function assertAbsent(filePath) {
  await assert.rejects(() => readFile(filePath), { code: 'ENOENT' });
}

test('init and uninstall leave the profile byte-identical, with a live comparator control', async () => {
  const box = await sandbox('ast-zero-profile-');
  const profilePath = adapter.profileFile(box.home);
  await mkdir(path.dirname(profilePath), { recursive: true });
  await writeFile(profilePath, '{"seed":true}\n');
  const before = bytesSha(await readFile(profilePath));

  const init = await runAst(['init'], box.env);
  assert.equal(init.code, 0, init.stderr);
  for (const entry of adapter.installPlan(ROOT, box.home)) assert.ok((await readFile(entry.targetPath)).length > 0);
  assert.equal(bytesSha(await readFile(profilePath)), before);

  const uninstall = await runAst(['uninstall'], box.env);
  assert.equal(uninstall.code, 0, uninstall.stderr);
  for (const entry of adapter.installPlan(ROOT, box.home)) await assertAbsent(entry.targetPath);
  assert.equal(bytesSha(await readFile(profilePath)), before);

  await appendFile(profilePath, 'seeded comparator control\n');
  assert.notEqual(bytesSha(await readFile(profilePath)), before);
});

test('init dry-run prints rollback-bearing changes and changes no tree', async () => {
  const box = await sandbox('ast-init-dry-');
  const before = await treeSha(box.base);
  const dry = await runAst(['init', '--dry-run'], box.env);
  assert.equal(dry.code, 0, dry.stderr);
  const changes = dry.stdout.split('\n').filter((line) => line.startsWith('init: would '));
  assert.ok(changes.length >= 1, 'dry-run printed no pending change');
  assert.ok(changes.every((line) => line.includes('rollback:')), 'a dry-run change omitted its rollback');
  assert.equal(await treeSha(box.base), before);

  assert.equal((await runAst(['init'], box.env)).code, 0);
  assert.notEqual(await treeSha(box.base), before);

  const installed = await treeSha(box.base);
  const uninstallDry = await runAst(['uninstall', '--dry-run'], box.env);
  assert.equal(uninstallDry.code, 0, uninstallDry.stderr);
  assert.match(uninstallDry.stdout, /would-remove/);
  assert.equal(await treeSha(box.base), installed);
});

test('init is byte-idempotent and preserves identity bytes', async () => {
  const box = await sandbox('ast-init-idempotent-');
  assert.equal((await runAst(['init'], box.env)).code, 0);
  const firstTree = await treeSha(box.base);
  const identityPath = path.join(box.stateDir, 'identity.json');
  const firstIdentity = await readFile(identityPath);

  assert.equal((await runAst(['init'], box.env)).code, 0);
  assert.equal(await treeSha(box.base), firstTree);
  assert.deepEqual(await readFile(identityPath), firstIdentity);
});

test('uninstall removes only the cockpit key block and succeeds byte-idempotently twice', async () => {
  const box = await sandbox('ast-tmux-block-');
  const tmuxPath = path.join(box.home, '.tmux.conf');
  await writeFile(tmuxPath, 'set -g status on\n');
  const pristine = bytesSha(await readFile(tmuxPath));

  assert.equal((await runAst(['init'], box.env)).code, 0);
  const installed = await readFile(tmuxPath, 'utf8');
  assert.match(installed, /# >>> asterism managed block cockpit-keys >>>/);
  assert.ok(installed.includes(`bind-key g display-popup -E -w 80% -h 60% '${ROOT}/bin/ast ls'`));
  assert.ok(installed.includes(`bind-key G display-popup -E -w 80% -h 60% '${ROOT}/bin/ast go'`));

  assert.equal((await runAst(['uninstall'], box.env)).code, 0);
  assert.equal(bytesSha(await readFile(tmuxPath)), pristine);
  const afterFirst = await treeSha(box.base);
  assert.equal((await runAst(['uninstall'], box.env)).code, 0);
  assert.equal(await treeSha(box.base), afterFirst);
});

test('completion is owned, fpath is printed, and shell startup bytes are untouched', async () => {
  const box = await sandbox('ast-completion-');
  const zshrcPath = path.join(box.home, '.zshrc');
  await writeFile(zshrcPath, 'export KEEP_ME=1\n');
  const before = bytesSha(await readFile(zshrcPath));

  const init = await runAst(['init'], box.env);
  assert.equal(init.code, 0, init.stderr);
  const completion = await readFile(path.join(box.configDir, '_ast'), 'utf8');
  assert.ok(completion.startsWith('#compdef ast\n'));
  assert.ok(completion.includes('asterism managed file'));
  assert.match(init.stdout, /fpath=\(/);
  assert.equal(bytesSha(await readFile(zshrcPath)), before);

  assert.equal((await runAst(['uninstall'], box.env)).code, 0);
  assert.equal(bytesSha(await readFile(zshrcPath)), before);

  const clean = await sandbox('ast-completion-clean-');
  assert.equal((await runAst(['init'], clean.env)).code, 0);
  await assertAbsent(path.join(clean.home, '.zshrc'));
});

test('R5 refuses init and uninstall but not a non-mutating verb', async () => {
  const box = await sandbox('ast-init-r5-');
  const markedEnv = { ...box.env, [adapter.agentEnvMarkers[0]]: '1' };
  assert.equal((await runAst(['init'], markedEnv)).code, 1);
  assert.equal((await runAst(['uninstall'], markedEnv)).code, 1);
  assert.equal((await runAst(['version'], markedEnv)).code, 0);
});

test('init reports the running-session restart outcome and unknown flags fail usage', async () => {
  const box = await sandbox('ast-init-restart-');
  const init = await runAst(['init'], box.env);
  assert.equal(init.code, 0, init.stderr);
  assert.ok(init.stdout.includes('no running sessions need a restart\n'));
  assert.equal(init.stdout.includes('restart to become bindable:'), false);
  assert.equal((await runAst(['init', '--other'], box.env)).code, 2);
  assert.equal((await runAst(['uninstall', '--purge'], box.env)).code, 2);
});
