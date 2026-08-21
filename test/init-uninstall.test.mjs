import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildRegistry } from '../src/adapters/index.js';
import { run as runInit } from '../src/cli/verbs/init.js';
import { buildIdentityManifest } from '../src/io/identity.js';
import { openStore } from '../src/io/store.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const FAKE_TMUX = path.join(ROOT, 'harness', 'fake-tmux', 'tmux');
const NODE = typeof globalThis.Bun === 'undefined' ? process.execPath : globalThis.Bun.which('node');
assert.ok(NODE, 'the test runner could not locate node for the fake-tmux shebang');
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

async function runInitDirect(args, ctx) {
  let stdout = '';
  let stderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  try {
    const code = await runInit(args, ctx);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
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

async function refreshFixture({ manifest = true } = {}) {
  const box = await sandbox('ast-init-refresh-');
  const root = path.join(box.base, 'root');
  const sourcePath = path.join(root, 'src', 'example.js');
  const identityPath = path.join(box.stateDir, 'identity.json');
  const managedPaths = [
    path.join(box.configDir, 'config.toml'),
    path.join(box.home, 'plugin', 'managed.txt'),
    path.join(box.home, '.tmux.conf'),
    path.join(box.configDir, '_ast'),
  ];
  await Promise.all([
    mkdir(path.join(root, 'bin'), { recursive: true }),
    mkdir(path.join(root, 'src'), { recursive: true }),
    mkdir(path.dirname(managedPaths[1]), { recursive: true }),
  ]);
  await openStore({ env: box.env });
  await writeFile(path.join(root, 'bin', 'ast'), '#!/usr/bin/env node\n');
  await writeFile(sourcePath, 'export const example = 1;\n');
  for (const [index, managedPath] of managedPaths.entries()) {
    await writeFile(managedPath, `managed sentinel ${index}\n`);
  }
  if (manifest) {
    const identity = await buildIdentityManifest({ root, mint: () => 'TESTULID0000000000000000' });
    await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  }
  const refreshAdapter = Object.freeze({
    id: 'refresh-fixture',
    discover: async () => [],
    installPlan: () => [Object.freeze({ targetPath: managedPaths[1], content: 'rewritten plugin\n' })],
  });
  return {
    ...box,
    root,
    sourcePath,
    identityPath,
    managedPaths,
    ctx: { env: box.env, root, adapters: new Map([[refreshAdapter.id, refreshAdapter]]) },
  };
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

test('init rollback advice distinguishes new, replaced, and unchanged config and identity files', async () => {
  const box = await sandbox('ast-init-rollback-');
  const configPath = path.join(box.configDir, 'config.toml');
  const identityPath = path.join(box.stateDir, 'identity.json');

  const freshDry = await runAst(['init', '--dry-run'], box.env);
  assert.equal(freshDry.code, 0, freshDry.stderr);
  assert.ok(
    freshDry.stdout.includes(`init: would install ${configPath} -- rollback: delete the file\n`),
    freshDry.stdout,
  );
  assert.ok(
    freshDry.stdout.includes(`init: would install ${identityPath} -- rollback: delete the file\n`),
    freshDry.stdout,
  );

  const freshReal = await runAst(['init'], box.env);
  assert.equal(freshReal.code, 0, freshReal.stderr);
  assert.ok(freshReal.stdout.includes(`init: installed ${configPath} -- rollback: delete the file\n`), freshReal.stdout);
  assert.ok(freshReal.stdout.includes(`init: installed ${identityPath} -- rollback: delete the file\n`), freshReal.stdout);

  const noopReal = await runAst(['init'], box.env);
  assert.equal(noopReal.code, 0, noopReal.stderr);
  assert.ok(noopReal.stdout.includes(`init: noop ${configPath} -- rollback: nothing changed\n`), noopReal.stdout);
  assert.ok(noopReal.stdout.includes(`init: noop ${identityPath} -- rollback: nothing changed\n`), noopReal.stdout);

  await appendFile(identityPath, '\n');
  const replaceDry = await runAst(['init', '--dry-run'], box.env);
  assert.equal(replaceDry.code, 0, replaceDry.stderr);
  assert.ok(
    replaceDry.stdout.includes(
      `init: would install ${identityPath} -- rollback: restore the previous identity manifest\n`,
    ),
    replaceDry.stdout,
  );

  const replaceReal = await runAst(['init'], box.env);
  assert.equal(replaceReal.code, 0, replaceReal.stderr);
  assert.ok(
    replaceReal.stdout.includes(`init: installed ${identityPath} -- rollback: restore the previous identity manifest\n`),
    replaceReal.stdout,
  );
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

test('init keys a probed server pid by the resolver candidate path', async () => {
  const box = await sandbox('ast-init-restart-probed-alias-');
  const shimDir = path.join(box.base, 'bin');
  const fakeRoot = path.join(box.base, 'fake-root');
  const fixturesDir = path.join(box.base, 'fixtures');
  const logPath = path.join(box.base, 'tmux.log');
  const candidateSocketPath = '/test-owned/asterism-test-candidate';
  const reportedSocketPath = '/test-owned/asterism-test-probed-alias';
  await Promise.all([
    mkdir(shimDir),
    mkdir(path.join(fakeRoot, 'sessions'), { recursive: true }),
    mkdir(fixturesDir),
  ]);
  await copyFile(FAKE_TMUX, path.join(shimDir, 'tmux'));
  await chmod(path.join(shimDir, 'tmux'), 0o755);
  await writeFile(path.join(fakeRoot, 'sessions', 'one.json'), JSON.stringify({ id: 'already-bound', status: 'waiting' }));
  await writeFile(path.join(fixturesDir, 'display-message.out'), `${reportedSocketPath},4242,3.7c\n`);

  const env = {
    ...box.env,
    PATH: `${shimDir}${path.delimiter}${path.dirname(NODE)}`,
    ASTERISM_TEST: '1',
    ASTERISM_FAKE_ROOT: fakeRoot,
    ASTERISM_FAKE_TMUX_LOG: logPath,
    ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir,
  };
  const store = await openStore({ env });
  await store.writeBinding('01ARZ3NDEKTSV4RRFFQ69G5FAZ', {
    adapter: 'fake', sessionId: 'already-bound', by: 'AgentAsserted', target: '%0',
    socketPath: candidateSocketPath, serverPid: 4242, at: '2026-08-20T00:00:00.000Z',
  });
  let resolverCalls = 0;
  const findServers = async ({ env: probeEnv, probe }) => {
    resolverCalls += 1;
    const result = await probe({ socketPath: candidateSocketPath, env: probeEnv });
    assert.equal(result.socketPath, reportedSocketPath);
    return [{ ...result, socketPath: candidateSocketPath }];
  };

  const init = await runInitDirect([], {
    env,
    root: ROOT,
    adapters: buildRegistry(env),
    resolveServers: findServers,
  });

  assert.equal(resolverCalls, 1);
  assert.equal(init.code, 0, init.stderr);
  assert.ok(init.stdout.includes('no running sessions need a restart\n'), init.stdout);
  assert.equal(init.stdout.includes('restart to become bindable: fake already-bound\n'), false, init.stdout);
});

test('init emits a socket resolver note before reporting a restart', async () => {
  const box = await sandbox('ast-init-restart-note-');
  const fakeRoot = path.join(box.base, 'fake-root');
  const socketFile = path.join(box.base, 'plain-socket');
  await mkdir(path.join(fakeRoot, 'sessions'), { recursive: true });
  await writeFile(
    path.join(fakeRoot, 'sessions', 'one.json'),
    JSON.stringify({ id: 'needs-note', status: 'waiting' }),
  );
  await writeFile(socketFile, '');

  const init = await runAst(['init'], {
    ...box.env,
    ASTERISM_FAKE_ROOT: fakeRoot,
    ASTERISM_TEST: '1',
    TMUX: `${socketFile},7777,0`,
  });

  assert.equal(init.code, 0, init.stderr);
  assert.ok(init.stdout.includes('restart to become bindable: fake needs-note\n'), init.stdout);
  assert.ok(
    init.stderr.startsWith(
      `note: tmux: socket-probe-failed: ${socketFile}: ` +
        'ASTERISM_TEST=1 requires a socket basename starting with "asterism-test", got "plain-socket"\n',
    ),
    init.stderr,
  );
});

test('init names only sessions without a strong binding on a live tmux server', async () => {
  const box = await sandbox('ast-init-restart-mixed-');
  const shimDir = path.join(box.base, 'bin');
  const fakeRoot = path.join(box.base, 'fake-root');
  const fixturesDir = path.join(box.base, 'fixtures');
  const socketDir = path.join(box.base, `tmux-${process.getuid()}`);
  const socketFile = path.join(socketDir, 'asterism-test-init');
  const logPath = path.join(box.base, 'tmux.log');
  await Promise.all([
    mkdir(shimDir),
    mkdir(path.join(fakeRoot, 'sessions'), { recursive: true }),
    mkdir(fixturesDir),
    mkdir(socketDir),
  ]);
  await copyFile(FAKE_TMUX, path.join(shimDir, 'tmux'));
  await chmod(path.join(shimDir, 'tmux'), 0o755);
  for (const [index, id] of ['already-bound', 'no-binding', 'dead-server', 'weak-binding'].entries()) {
    await writeFile(path.join(fakeRoot, 'sessions', `${index}.json`), JSON.stringify({ id, status: 'waiting' }));
  }
  await writeFile(socketFile, '');
  const socketPath = await realpath(socketFile);
  await writeFile(path.join(fixturesDir, 'display-message.out'), `${socketFile},4242,3.7c\n`);

  const env = {
    ...box.env,
    PATH: `${shimDir}${path.delimiter}${path.dirname(NODE)}`,
    ASTERISM_TEST: '1',
    ASTERISM_FAKE_ROOT: fakeRoot,
    ASTERISM_FAKE_TMUX_LOG: logPath,
    ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir,
    TMUX_TMPDIR: box.base,
    TMUX: `${socketFile},7777,0`,
  };
  const store = await openStore({ env });
  await store.writeBinding('01ARZ3NDEKTSV4RRFFQ69G5FAV', {
    adapter: 'fake', sessionId: 'already-bound', by: 'AgentAsserted', target: '%0',
    socketPath, serverPid: 4242, at: '2026-08-20T00:00:00.000Z',
  });
  await store.writeBinding('01ARZ3NDEKTSV4RRFFQ69G5FAW', {
    adapter: 'fake', sessionId: 'dead-server', by: 'HumanAsserted', target: '%1',
    socketPath: '/dead/socket', serverPid: 9999, at: '2026-08-20T00:00:00.000Z',
  });
  await store.writeBinding('01ARZ3NDEKTSV4RRFFQ69G5FAX', {
    adapter: 'fake', sessionId: 'weak-binding', by: 'VendorRegistry', target: '%2',
    socketPath, serverPid: 4242, at: '2026-08-20T00:00:00.000Z',
  });
  await store.writeBinding('01ARZ3NDEKTSV4RRFFQ69G5FAY', {
    adapter: 'other', sessionId: 'no-binding', by: 'HumanAsserted', target: '%3',
    socketPath, serverPid: 4242, at: '2026-08-20T00:00:00.000Z',
  });

  const init = await runAst(['init'], env);
  assert.equal(init.code, 0, init.stderr);
  assert.ok(init.stdout.includes('restart to become bindable: fake no-binding\n'), init.stdout);
  assert.ok(init.stdout.includes('restart to become bindable: fake dead-server\n'), init.stdout);
  assert.ok(init.stdout.includes('restart to become bindable: fake weak-binding\n'), init.stdout);
  assert.equal(init.stdout.includes('restart to become bindable: fake already-bound\n'), false, init.stdout);
  assert.equal(init.stdout.includes('no running sessions need a restart\n'), false, init.stdout);
});

test('init --refresh re-attests changed source and leaves every other managed file byte-identical', async () => {
  const box = await refreshFixture();
  const beforeIdentity = await readFile(box.identityPath);
  const beforeManaged = await Promise.all(box.managedPaths.map((filePath) => readFile(filePath)));
  const priorInstallId = JSON.parse(beforeIdentity.toString('utf8')).installId;
  await writeFile(box.sourcePath, 'export const example = 2;\n');

  const refreshed = await runInitDirect(['--refresh'], box.ctx);
  assert.equal(refreshed.code, 0, refreshed.stderr);
  assert.equal(refreshed.stdout, 'init refresh: re-attested src/example.js (sha256 moved)\n');
  const nextIdentity = JSON.parse(await readFile(box.identityPath, 'utf8'));
  assert.equal(nextIdentity.installId, priorInstallId);
  assert.equal(nextIdentity.files['src/example.js'], bytesSha(await readFile(box.sourcePath)));
  assert.notDeepEqual(await readFile(box.identityPath), beforeIdentity);
  for (let index = 0; index < box.managedPaths.length; index += 1) {
    assert.deepEqual(await readFile(box.managedPaths[index]), beforeManaged[index], box.managedPaths[index]);
  }
});

test('init --refresh without a manifest resolves to refusal and writes nothing', async () => {
  const box = await refreshFixture({ manifest: false });
  const before = await treeSha(box.base);
  let refused;
  await assert.doesNotReject(async () => {
    refused = await runInitDirect(['--refresh'], box.ctx);
  });
  assert.equal(refused.code, 1);
  assert.equal(refused.stderr, 'init refresh: identity manifest is absent; run ast init\n');
  assert.equal(await treeSha(box.base), before);
});

test('init --refresh refuses malformed manifests as values and writes nothing', async () => {
  const box = await refreshFixture();
  const malformed = [
    ['unparseable', '{not-json\n'],
    ['invalid shape', `${JSON.stringify({ installId: 'KEEP', installPath: box.root, files: { 'src/example.js': 17 } })}\n`],
  ];
  for (const [label, bytes] of malformed) {
    await writeFile(box.identityPath, bytes);
    const before = await treeSha(box.base);
    let refused;
    await assert.doesNotReject(async () => {
      refused = await runInitDirect(['--refresh'], box.ctx);
    }, label);
    assert.equal(refused.code, 1, label);
    assert.match(refused.stderr, /run ast init/, label);
    assert.equal(await treeSha(box.base), before, label);
  }
});

test('init --refresh resolves store schema and permission guards before writing identity', async () => {
  for (const guard of ['schema', 'permissions']) {
    const box = await refreshFixture();
    await writeFile(box.sourcePath, 'export const example = 4;\n');
    if (guard === 'schema') await writeFile(path.join(box.stateDir, 'schema-version'), '2\n');
    else await chmod(box.stateDir, 0o755);
    const beforeIdentity = await readFile(box.identityPath);
    let refused;
    await assert.doesNotReject(async () => {
      refused = await runInitDirect(['--refresh'], box.ctx);
    }, guard);
    assert.equal(refused.code, 1, guard);
    assert.deepEqual(await readFile(box.identityPath), beforeIdentity, guard);
  }
});

test('init --refresh --dry-run names changed source and writes nothing', async () => {
  const box = await refreshFixture();
  await writeFile(box.sourcePath, 'export const example = 3;\n');
  const before = await treeSha(box.base);
  const dry = await runInitDirect(['--refresh', '--dry-run'], box.ctx);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.stdout, 'init refresh: would re-attest src/example.js (sha256 moved)\n');
  assert.equal(await treeSha(box.base), before);

  const rejected = await runInitDirect(['--refresh', '--dry-run', '--other'], box.ctx);
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr, /^usage: ast init/);
});
