import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { adapters } from '../src/adapters/index.js';
import { AXES, UNKNOWN } from '../src/core/caps.js';
import { checkPipePaneOccupied, checkTmuxVersionFloor } from '../src/core/tmuxver.js';
import {
  CHECKS,
  checkStaleLaunchdPlists,
  runDoctor,
  STATUS,
  tmuxBlockContent,
} from '../src/doctor/index.js';
import * as cfgedit from '../src/io/cfgedit.js';
import { buildIdentityManifest } from '../src/io/identity.js';
import { execTmux } from '../src/io/tmuxexec.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const NODE = typeof globalThis.Bun === 'undefined' ? process.execPath : globalThis.Bun.which('node');
assert.ok(NODE, 'the test runner could not locate node for CLI subprocesses');
const ID_PATTERN = /^[a-z]+(\.[a-z-]+)+$/;
const FAKE_TMUX_DIR = path.join(ROOT, 'harness', 'fake-tmux');
const EXPECTED_CHECK_IDS = [
  'state.permissions',
  'state.targets-are-ids',
  'identity.sha',
  'tmux.version-floor',
  'tmux.managed-block-drift',
  'tmux.pipe-pane-occupied',
  'fixtures.manifest',
  'probe.capability-unknowns',
  'attention.stuck',
  'retention.counts',
  'canary.unknown-fields',
  'launchd.stale-plists',
  'discovery.source-agreement',
];
const EXPECTED_TODO_IDS = [];

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Discovered from the registry, not spelled out, so this file never has to
// name a vendor to exercise the manual-source capture-command suffix.
function findManualRecipe() {
  for (const adapter of adapters.values()) {
    if (!adapter.captures) continue;
    const found = adapter.captures.find((recipe) => recipe.source === 'manual');
    if (found) return found;
  }
  return null;
}

async function runAst(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(NODE, [AST_BIN, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function checkById(id) {
  const check = CHECKS.find((entry) => entry.id === id);
  assert.ok(check, `missing doctor check ${id}`);
  return check;
}

function syntheticRegistry(...extraAdapters) {
  const synth = { id: 'synth', capabilities: fullCapabilityRecord(), discover: async () => [] };
  return new Map([[synth.id, synth], ...extraAdapters.map((adapter) => [adapter.id, adapter])]);
}

function doctorSandbox(prefix) {
  const base = tmpDir(prefix);
  const root = path.join(base, 'root');
  const home = path.join(base, 'home');
  const stateHome = path.join(base, 'state-home');
  const stateDir = path.join(stateHome, 'asterism');
  const configHome = path.join(base, 'config-home');
  const emptyBin = path.join(base, 'empty-bin');
  for (const dir of [root, home, stateHome, configHome, emptyBin]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { base, root, home, stateHome, stateDir, configHome, emptyBin };
}

async function installTmuxBlock(targetPath, root) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const plan = await cfgedit.planManagedBlock({
    targetPath,
    blockId: 'cockpit-keys',
    content: tmuxBlockContent(root),
  });
  await cfgedit.apply(plan, {
    writeBackup: async (slug, bytes) => {
      const backupPath = path.join(path.dirname(targetPath), `${slug}.backup`);
      writeFileSync(backupPath, bytes);
      return backupPath;
    },
  });
}

function writeManifest(root, toml) {
  mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  writeFileSync(path.join(root, 'fixtures', 'MANIFEST.toml'), toml);
}

function writeCell(root, cellId, bytes, metaOverrides = {}) {
  const dir = path.join(root, 'fixtures', ...cellId.split('/'));
  mkdirSync(dir, { recursive: true });
  const rawBytes = Buffer.from(bytes, 'utf8');
  writeFileSync(path.join(dir, 'raw'), rawBytes);
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      cell: cellId,
      sha256: createHash('sha256').update(rawBytes).digest('hex'),
      bytes: rawBytes.length,
      capturedAt: new Date().toISOString(),
      provokedBy: '',
      command: ['synthetic'],
      cliVersion: null,
      tmuxVersion: null,
      profileHash: 'absent',
      redactions: [],
      kills: [],
      ...metaOverrides,
    }),
  );
}

// ---- registry shape ----

test('every check has a unique id matching the id grammar, a non-empty prevents, and a run function', () => {
  assert.equal(CHECKS.length, 13);
  assert.deepEqual(CHECKS.map((check) => check.id), EXPECTED_CHECK_IDS);

  const seen = new Set();
  for (const check of CHECKS) {
    assert.match(check.id, ID_PATTERN, `${check.id} does not match ${ID_PATTERN}`);
    assert.ok(!seen.has(check.id), `${check.id} is duplicated`);
    seen.add(check.id);

    assert.equal(typeof check.prevents, 'string');
    assert.ok(check.prevents.length > 0, `${check.id} has an empty prevents`);

    assert.equal(typeof check.run, 'function');
  }
});

test('STATUS is frozen and exactly pass/warn/fail/todo/unknown', () => {
  assert.ok(Object.isFrozen(STATUS));
  assert.deepEqual(STATUS, ['pass', 'warn', 'fail', 'todo', 'unknown']);
});

test('every registered check is live and returns a declared non-todo status in a sandbox', async () => {
  assert.deepEqual(EXPECTED_TODO_IDS, []);
  const box = doctorSandbox('ast-doctor-live-sweep-');
  const env = { PATH: box.emptyBin, HOME: box.home, XDG_STATE_HOME: box.stateHome };
  const registry = syntheticRegistry();

  for (const check of CHECKS) {
    const result = await check.run({ root: box.root, home: box.home, env, registry });
    assert.ok(STATUS.includes(result.status), `${check.id} returned undeclared status ${result.status}`);
    assert.notEqual(result.status, 'todo', `${check.id} still reports todo`);
  }
});

// ---- runDoctor exit code ----

test('runDoctor exits 0 for pass/warn and 1 for fail or unknown', async () => {
  const passWarn = [
    { id: 'x.pass', prevents: 'p', run: async () => ({ status: 'pass', detail: 'ok' }) },
    { id: 'x.warn', prevents: 'p', run: async () => ({ status: 'warn', detail: 'meh' }) },
  ];
  const clean = await runDoctor({ root: '/unused', home: '/unused', env: {}, checks: passWarn });
  assert.equal(clean.exit, 0);

  const withFail = [...passWarn, { id: 'x.fail', prevents: 'p', run: async () => ({ status: 'fail', detail: 'bad' }) }];
  const failing = await runDoctor({ root: '/unused', home: '/unused', env: {}, checks: withFail });
  assert.equal(failing.exit, 1);

  const withUnknown = [
    ...passWarn,
    { id: 'x.unknown', prevents: 'p', run: async () => ({ status: 'unknown', detail: 'not measured' }) },
  ];
  const unknown = await runDoctor({ root: '/unused', home: '/unused', env: {}, checks: withUnknown });
  assert.equal(unknown.exit, 1);
});

// ---- Phase-1 registered checks ----

test('state.permissions: owner-only entries pass while other and group-readable files fail', async () => {
  const box = doctorSandbox('ast-doctor-permissions-');
  mkdirSync(path.join(box.stateDir, 'sessions'), { recursive: true, mode: 0o700 });
  const cleanFile = path.join(box.stateDir, 'sessions', 'clean.json');
  writeFileSync(cleanFile, '{}\n', { mode: 0o600 });
  chmodSync(path.join(box.stateDir, 'sessions'), 0o700);
  chmodSync(cleanFile, 0o600);
  const env = { PATH: box.emptyBin, HOME: box.home, XDG_STATE_HOME: box.stateHome };

  const clean = await checkById('state.permissions').run({ root: box.root, home: box.home, env });
  assert.equal(clean.status, 'pass');

  chmodSync(cleanFile, 0o644);
  const otherReadable = await checkById('state.permissions').run({ root: box.root, home: box.home, env });
  assert.equal(otherReadable.status, 'fail');
  assert.match(otherReadable.detail, /clean\.json 644/);

  chmodSync(cleanFile, 0o640);
  const groupReadable = await checkById('state.permissions').run({ root: box.root, home: box.home, env });
  assert.equal(groupReadable.status, 'fail');
  assert.match(groupReadable.detail, /clean\.json 640/);
});

test('state checks report unknown when the state directory cannot be resolved', async () => {
  const result = await checkById('state.permissions').run({ root: '/unused', home: '/unused', env: { PATH: '/unused' } });
  assert.equal(result.status, 'unknown');
  assert.match(result.detail, /state directory cannot be resolved/);
  assert.match(result.detail, /set HOME or XDG_STATE_HOME/);
});

test('state.targets-are-ids: ids pass while a name target and unparseable binding fail', async () => {
  const box = doctorSandbox('ast-doctor-targets-');
  const bindingsDir = path.join(box.stateDir, 'bindings');
  mkdirSync(bindingsDir, { recursive: true, mode: 0o700 });
  const bindingPath = path.join(bindingsDir, 'one.bind');
  writeFileSync(bindingPath, JSON.stringify({ target: '%5' }), { mode: 0o600 });
  const env = { PATH: box.emptyBin, HOME: box.home, XDG_STATE_HOME: box.stateHome };

  const clean = await checkById('state.targets-are-ids').run({ root: box.root, home: box.home, env });
  assert.equal(clean.status, 'pass');
  assert.match(clean.detail, /1 binding\(s\) checked/);

  writeFileSync(bindingPath, JSON.stringify({ target: 'main' }));
  const named = await checkById('state.targets-are-ids').run({ root: box.root, home: box.home, env });
  assert.equal(named.status, 'fail');
  assert.match(named.detail, /target "main"/);

  writeFileSync(bindingPath, '{');
  const malformed = await checkById('state.targets-are-ids').run({ root: box.root, home: box.home, env });
  assert.equal(malformed.status, 'fail');
  assert.match(malformed.detail, /unparseable/);
});

test('identity.sha: matching tree passes, byte drift fails, and an absent manifest is unknown', async () => {
  const box = doctorSandbox('ast-doctor-identity-');
  mkdirSync(path.join(box.root, 'bin'), { recursive: true });
  mkdirSync(path.join(box.root, 'src'), { recursive: true });
  writeFileSync(path.join(box.root, 'bin', 'x'), 'x\n');
  const sourcePath = path.join(box.root, 'src', 'a.js');
  writeFileSync(sourcePath, 'a\n');
  mkdirSync(box.stateDir, { recursive: true, mode: 0o700 });
  const identityPath = path.join(box.stateDir, 'identity.json');
  writeFileSync(identityPath, JSON.stringify(await buildIdentityManifest({ root: box.root })), { mode: 0o600 });
  const env = { PATH: box.emptyBin, HOME: box.home, XDG_STATE_HOME: box.stateHome };

  const clean = await checkById('identity.sha').run({ root: box.root, home: box.home, env });
  assert.equal(clean.status, 'pass');
  assert.equal(clean.detail, 'installed tree matches identity.json');

  writeFileSync(sourcePath, 'b\n');
  const drifted = await checkById('identity.sha').run({ root: box.root, home: box.home, env });
  assert.equal(drifted.status, 'fail');
  assert.match(drifted.detail, /sha256 does not match/);

  unlinkSync(identityPath);
  const absent = await checkById('identity.sha').run({ root: box.root, home: box.home, env });
  assert.equal(absent.status, 'unknown');
  assert.match(absent.detail, /run ast init/);
});

test('tmux.version-floor: injected version outcomes cover pass, fail, and unknown', async () => {
  const outcome = (code, stdout) => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
  const passing = await checkTmuxVersionFloor({ env: {}, execute: async () => outcome(0, 'tmux 3.7c\n') });
  assert.equal(passing.status, 'pass');

  const belowFloor = await checkTmuxVersionFloor({ env: {}, execute: async () => outcome(0, 'tmux 3.4\n') });
  assert.equal(belowFloor.status, 'fail');
  assert.match(belowFloor.detail, /required 3\.7/);

  const rejected = await checkTmuxVersionFloor({
    env: {},
    execute: async () => {
      throw new Error('binary absent');
    },
  });
  assert.equal(rejected.status, 'unknown');

  assert.equal((await checkTmuxVersionFloor({ env: {}, execute: async () => outcome(1, '') })).status, 'unknown');
  assert.equal(
    (await checkTmuxVersionFloor({ env: {}, execute: async () => outcome(0, 'not a version') })).status,
    'unknown',
  );
});

test('tmux.version-floor: registered check reports unknown with tmux absent from an explicitly empty PATH', async () => {
  const box = doctorSandbox('ast-doctor-version-registered-');
  const result = await checkById('tmux.version-floor').run({
    root: box.root,
    home: box.home,
    env: { PATH: box.emptyBin, HOME: box.home },
  });
  assert.equal(result.status, 'unknown');
});

test('tmux.pipe-pane-occupied: real chokepoint fails only marked occupied panes and reports unreachable', async () => {
  const box = doctorSandbox('ast-doctor-pipe-');
  const fixturesDir = path.join(box.base, 'fixtures');
  const logPath = path.join(box.base, 'tmux.log');
  mkdirSync(fixturesDir, { recursive: true });
  const fakeEnv = {
    PATH: `${FAKE_TMUX_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    ASTERISM_FAKE_TMUX_LOG: logPath,
    ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir,
  };
  const execute = (args) =>
    execTmux(args, { socketPath: path.join(box.base, 'asterism-test-sock'), env: fakeEnv });

  writeFileSync(path.join(fixturesDir, 'list-panes.out'), '%1|01AB|1\n');
  const occupied = await checkPipePaneOccupied({ env: fakeEnv, execute });
  assert.equal(occupied.status, 'fail');
  assert.match(occupied.detail, /%1/);

  writeFileSync(path.join(fixturesDir, 'list-panes.out'), '%1|01AB|0\n%2||1\n');
  const scoped = await checkPipePaneOccupied({ env: fakeEnv, execute });
  assert.equal(scoped.status, 'pass');

  writeFileSync(path.join(fixturesDir, 'list-panes.rc'), '1\n');
  const unreachable = await checkPipePaneOccupied({ env: fakeEnv, execute });
  assert.equal(unreachable.status, 'unknown');
  assert.equal(unreachable.detail, 'no tmux server reachable');
});

test('tmux.managed-block-drift: matching passes, drift warns without writes, and absence names init', async () => {
  const box = doctorSandbox('ast-doctor-block-');
  const targetPath = path.join(box.home, '.tmux.conf');
  await installTmuxBlock(targetPath, box.root);
  const env = { PATH: box.emptyBin, HOME: box.home };

  const matching = await checkById('tmux.managed-block-drift').run({ root: box.root, home: box.home, env });
  assert.equal(matching.status, 'pass');

  writeFileSync(targetPath, readFileSync(targetPath, 'utf8').replace('/bin/ast ls', '/bin/ast xx'));
  const beforeSha = createHash('sha256').update(readFileSync(targetPath)).digest('hex');
  const beforeMtime = statSync(targetPath).mtimeMs;
  const drifted = await checkById('tmux.managed-block-drift').run({ root: box.root, home: box.home, env });
  assert.equal(drifted.status, 'warn');
  assert.match(drifted.detail, /drifted/);
  assert.equal(createHash('sha256').update(readFileSync(targetPath)).digest('hex'), beforeSha);
  assert.equal(statSync(targetPath).mtimeMs, beforeMtime);

  const absentBox = doctorSandbox('ast-doctor-block-absent-');
  const absent = await checkById('tmux.managed-block-drift').run({
    root: absentBox.root,
    home: absentBox.home,
    env: { PATH: absentBox.emptyBin, HOME: absentBox.home },
  });
  assert.equal(absent.status, 'warn');
  assert.match(absent.detail, /run ast init/);
});

test('tmux.managed-block-drift: reconstructed content matches a real init install', async () => {
  const box = doctorSandbox('ast-doctor-init-parity-');
  const env = {
    PATH: `${box.emptyBin}${path.delimiter}${path.dirname(process.execPath)}`,
    HOME: box.home,
    XDG_STATE_HOME: box.stateHome,
    XDG_CONFIG_HOME: box.configHome,
    TERM: 'dumb',
  };
  const initialized = await runAst(['init'], env);
  assert.equal(initialized.code, 0, initialized.stderr);

  const result = await checkById('tmux.managed-block-drift').run({ root: ROOT, home: box.home, env });
  assert.equal(result.status, 'pass');
});

test('retention.counts: a fresh state tree reports zero and seeded sessions are counted', async () => {
  const box = doctorSandbox('ast-doctor-retention-');
  const env = { PATH: box.emptyBin, HOME: box.home, XDG_STATE_HOME: box.stateHome };
  const fresh = await checkById('retention.counts').run({ root: box.root, home: box.home, env });
  assert.equal(fresh.status, 'pass');
  assert.match(fresh.detail, /^sessions: 0 files, 0 bytes/);

  mkdirSync(path.join(box.stateDir, 'sessions'), { recursive: true });
  writeFileSync(path.join(box.stateDir, 'sessions', 'one.json'), '{}');
  writeFileSync(path.join(box.stateDir, 'sessions', 'two.json'), '{}');
  const seeded = await checkById('retention.counts').run({ root: box.root, home: box.home, env });
  assert.equal(seeded.status, 'pass');
  assert.match(seeded.detail, /sessions: 2 files/);
});

test('canary.unknown-fields: recent warns, old passes, and malformed fails', async () => {
  const box = doctorSandbox('ast-doctor-canary-');
  const unknownDir = path.join(box.stateDir, 'unknown');
  mkdirSync(unknownDir, { recursive: true });
  const env = { PATH: box.emptyBin, HOME: box.home, XDG_STATE_HOME: box.stateHome };
  const now = Date.now();
  const canaryPath = path.join(unknownDir, 'one.json');

  writeFileSync(canaryPath, JSON.stringify({ adapter: 'synth', key: 'new-field', at: now }));
  const recent = await checkById('canary.unknown-fields').run({ root: box.root, home: box.home, env });
  assert.equal(recent.status, 'warn');
  assert.match(recent.detail, /synth\/new-field/);

  writeFileSync(canaryPath, JSON.stringify({ adapter: 'synth', key: 'old-field', at: now - 25 * 60 * 60 * 1000 }));
  const old = await checkById('canary.unknown-fields').run({ root: box.root, home: box.home, env });
  assert.equal(old.status, 'pass');

  writeFileSync(canaryPath, '{');
  const malformed = await checkById('canary.unknown-fields').run({ root: box.root, home: box.home, env });
  assert.equal(malformed.status, 'fail');
});

test('attention.stuck: a stuck flag and malformed session fail while clean sessions pass', async () => {
  const box = doctorSandbox('ast-doctor-attention-');
  const sessionsDir = path.join(box.stateDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const env = { PATH: box.emptyBin, HOME: box.home, XDG_STATE_HOME: box.stateHome };
  const sessionPath = path.join(sessionsDir, 'one.json');

  writeFileSync(sessionPath, JSON.stringify({ flags: { attentionStuck: true } }));
  const stuck = await checkById('attention.stuck').run({ root: box.root, home: box.home, env });
  assert.equal(stuck.status, 'fail');
  assert.match(stuck.detail, /one\.json/);

  writeFileSync(sessionPath, JSON.stringify({ flags: { attentionStuck: false } }));
  const clean = await checkById('attention.stuck').run({ root: box.root, home: box.home, env });
  assert.equal(clean.status, 'pass');

  writeFileSync(sessionPath, '{');
  const malformed = await checkById('attention.stuck').run({ root: box.root, home: box.home, env });
  assert.equal(malformed.status, 'fail');
});

test('launchd.stale-plists: platform, absence, stale match, and scope control are distinct', async () => {
  const box = doctorSandbox('ast-doctor-launchd-');
  const nonDarwin = await checkStaleLaunchdPlists({ home: box.home, platform: 'linux' });
  assert.equal(nonDarwin.status, 'pass');
  assert.match(nonDarwin.detail, /does not apply/);

  const absent = await checkStaleLaunchdPlists({ home: box.home, platform: 'darwin' });
  assert.equal(absent.status, 'pass');
  assert.match(absent.detail, /no LaunchAgents directory/);

  const launchAgents = path.join(box.home, 'Library', 'LaunchAgents');
  mkdirSync(launchAgents, { recursive: true });
  const staleName = 'com.asterism.doctor.plist.bak-20260101';
  writeFileSync(path.join(launchAgents, staleName), 'stale\n');
  const stale = await checkStaleLaunchdPlists({ home: box.home, platform: 'darwin' });
  assert.equal(stale.status, 'warn');
  assert.match(stale.detail, new RegExp(staleName.replaceAll('.', '\\.')));

  unlinkSync(path.join(launchAgents, staleName));
  writeFileSync(path.join(launchAgents, 'com.other.plist.bak-1'), 'other\n');
  const scoped = await checkStaleLaunchdPlists({ home: box.home, platform: 'darwin' });
  assert.equal(scoped.status, 'pass');
});

test('discovery.source-agreement: all sources pass and unavailable adapters aggregate as unknown', async () => {
  const check = checkById('discovery.source-agreement');
  const clean = await check.run({ env: {}, home: '/unused', registry: syntheticRegistry() });
  assert.equal(clean.status, 'pass');

  // Per-field disagreement is pinned by the dedicated discovery-source test.
  const broken = {
    id: 'broken',
    capabilities: fullCapabilityRecord(),
    discover: async () => {
      throw new Error('binary absent');
    },
  };
  const unavailable = await check.run({ env: {}, home: '/unused', registry: syntheticRegistry(broken) });
  assert.equal(unavailable.status, 'unknown');
  assert.match(unavailable.detail, /broken:/);
  assert.match(unavailable.detail, /binary absent/);
});

// ---- fixtures.manifest ----

const manifestCheck = CHECKS.find((check) => check.id === 'fixtures.manifest');

test('fixtures.manifest: one required present+valid, one required missing, one manual missing, one n/a', async () => {
  const root = tmpDir('ast-doctor-manifest-');
  writeManifest(
    root,
    `
[manifest]
schema = 1

[cells."tmux/present"]
kind = "required"
capture = "ast fixture capture tmux/present"
why = "present"

[cells."tmux/missing"]
kind = "required"
capture = "ast fixture capture tmux/missing"
why = "missing"

[cells."tmux/manual-missing"]
kind = "manual"
capture = "ast fixture capture tmux/manual-missing"
maxAgeDays = 90
why = "manual missing"

[cells."tmux/skip"]
kind = "n/a"
reason = "not yet"
why = "skip"
`,
  );
  writeCell(root, 'tmux/present', 'hello world\n');

  const result = await manifestCheck.run({ root, home: root, env: {} });
  assert.equal(result.status, 'fail');
  assert.equal(
    result.detail,
    '1/3 captured, 1 manual pending, 0 stale' +
      '; missing required: tmux/missing (ast fixture capture tmux/missing)' +
      '; missing manual: tmux/manual-missing (ast fixture capture tmux/manual-missing)',
  );
});

test('fixtures.manifest: a missing manual cell whose recipe is a manual-source recipe gets --from <file> appended to the capture command', async () => {
  const recipe = findManualRecipe();
  assert.ok(recipe, 'expected at least one manual-source capture recipe registered');

  const root = tmpDir('ast-doctor-manifest-manual-recipe-');
  writeManifest(
    root,
    `
[manifest]
schema = 1

[cells."${recipe.cell}"]
kind = "manual"
capture = "ast fixture capture ${recipe.cell}"
maxAgeDays = 90
why = "manual recipe capture-command test"
`,
  );

  const result = await manifestCheck.run({ root, home: root, env: {} });
  assert.equal(result.status, 'warn');
  assert.ok(
    result.detail.includes(`missing manual: ${recipe.cell} (ast fixture capture ${recipe.cell} --from <file>)`),
    result.detail,
  );
});

test('fixtures.manifest: a missing manifest file fails', async () => {
  const root = tmpDir('ast-doctor-manifest-missing-');
  const result = await manifestCheck.run({ root, home: root, env: {} });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /missing or unparseable/);
});

test('fixtures.manifest: a fully-captured, fresh manifest passes with zero pending/stale', async () => {
  const root = tmpDir('ast-doctor-manifest-clean-');
  writeManifest(
    root,
    `
[manifest]
schema = 1

[cells."tmux/present"]
kind = "required"
capture = "ast fixture capture tmux/present"
why = "present"
`,
  );
  writeCell(root, 'tmux/present', 'hello world\n');

  const result = await manifestCheck.run({ root, home: root, env: {} });
  assert.equal(result.status, 'pass');
  assert.equal(result.detail, '1/1 captured, 0 manual pending, 0 stale');
});

test('fixtures.manifest: a manual cell older than maxAgeDays is stale and fails', async () => {
  const root = tmpDir('ast-doctor-manifest-stale-age-');
  // An explicitly empty PATH, not an absent one: with PATH unset the spawn falls back to the
  // platform default search path, which finds a real tmux on a Linux runner and turns this
  // into a version-drift case instead of the unverifiable one the assertion below pins.
  const emptyBin = tmpDir('ast-doctor-stale-age-empty-bin-');
  writeManifest(
    root,
    `
[manifest]
schema = 1

[cells."tmux/list-panes"]
kind = "manual"
capture = "ast fixture capture tmux/list-panes"
maxAgeDays = 1
why = "ancient"
`,
  );
  writeCell(root, 'tmux/list-panes', 'stale content\n', { capturedAt: new Date(0).toISOString() });

  const result = await manifestCheck.run({ root, home: root, env: { PATH: emptyBin } });
  assert.equal(result.status, 'fail');
  assert.equal(
    result.detail,
    '1/1 captured, 0 manual pending, 1 stale' +
      '; stale: tmux/list-panes [older than 1d] (ast fixture capture tmux/list-panes)' +
      '; cannot verify version: tmux/list-panes',
  );
});

test('fixtures.manifest: a manual cell whose installed CLI version differs from meta.cliVersion is stale and fails', async () => {
  const root = tmpDir('ast-doctor-manifest-stale-version-');
  const binDir = tmpDir('ast-doctor-fake-tmux-bin-');
  writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\necho "tmux 9.9"\n');
  chmodSync(path.join(binDir, 'tmux'), 0o755);

  writeManifest(
    root,
    `
[manifest]
schema = 1

[cells."tmux/list-panes"]
kind = "manual"
capture = "ast fixture capture tmux/list-panes"
maxAgeDays = 9999
why = "version drifted"
`,
  );
  writeCell(root, 'tmux/list-panes', 'fresh content\n', { cliVersion: 'tmux 3.7' });

  const result = await manifestCheck.run({ root, home: root, env: { PATH: binDir } });
  assert.equal(result.status, 'fail');
  assert.equal(
    result.detail,
    '1/1 captured, 0 manual pending, 1 stale' +
      '; stale: tmux/list-panes [cliVersion drift] (ast fixture capture tmux/list-panes)',
  );
});

test('fixtures.manifest: an unresolvable CLI (absent from PATH) warns "cannot verify version" instead of failing', async () => {
  const root = tmpDir('ast-doctor-manifest-noverify-');
  const emptyBin = tmpDir('ast-doctor-empty-bin-');

  writeManifest(
    root,
    `
[manifest]
schema = 1

[cells."tmux/list-panes"]
kind = "manual"
capture = "ast fixture capture tmux/list-panes"
maxAgeDays = 9999
why = "cannot verify"
`,
  );
  writeCell(root, 'tmux/list-panes', 'fresh content\n', { cliVersion: 'tmux 3.7' });

  const result = await manifestCheck.run({ root, home: root, env: { PATH: emptyBin } });
  assert.equal(result.status, 'warn');
  assert.equal(
    result.detail,
    '1/1 captured, 0 manual pending, 0 stale; cannot verify version: tmux/list-panes',
  );
});

// ---- probe.capability-unknowns ----

const capabilityCheck = CHECKS.find((check) => check.id === 'probe.capability-unknowns');

function fullCapabilityRecord() {
  const record = {};
  for (const axis of Object.keys(AXES)) {
    record[axis] = {
      value: AXES[axis][0],
      evidence: { grade: 'C', probe: `synthetic probe for ${axis}`, observedOn: '2026-01-01' },
    };
  }
  return record;
}

test('probe.capability-unknowns: no unknowns across a synthetic registry passes', async () => {
  const registry = new Map([['synth', { id: 'synth', capabilities: fullCapabilityRecord() }]]);
  const result = await capabilityCheck.run({ registry, env: {} });
  assert.equal(result.status, 'pass');
  assert.equal(result.detail, 'no unknown axes across 1 adapters');
});

test('probe.capability-unknowns: a non-gated unknown warns, naming the adapter, axis, deferral, and probe', async () => {
  const record = fullCapabilityRecord();
  record.transcript = { value: UNKNOWN, evidence: { probe: 'a probe for transcript', deferredTo: 'Phase 3' } };
  const registry = new Map([['synth', { id: 'synth', capabilities: record }]]);

  const result = await capabilityCheck.run({ registry, env: {} });
  assert.equal(result.status, 'warn');
  assert.ok(result.detail.includes('synth.transcript'), result.detail);
  assert.ok(result.detail.includes('Phase 3'), result.detail);
  assert.ok(result.detail.includes('a probe for transcript'), result.detail);
});

test('probe.capability-unknowns: a gated unknown fails', async () => {
  const record = fullCapabilityRecord();
  record.identity = { value: UNKNOWN, evidence: { probe: 'a probe for identity', deferredTo: 'Phase 1' } };
  const registry = new Map([['synth', { id: 'synth', capabilities: record }]]);

  const result = await capabilityCheck.run({ registry, env: {} });
  assert.equal(result.status, 'fail');
  assert.ok(result.detail.includes('synth.identity'), result.detail);
});

test('probe.capability-unknowns: an invalid record fails', async () => {
  const record = fullCapabilityRecord();
  delete record.identity;
  const registry = new Map([['synth', { id: 'synth', capabilities: record }]]);

  const result = await capabilityCheck.run({ registry, env: {} });
  assert.equal(result.status, 'fail');
});

test('probe.capability-unknowns: with ctx.registry absent and env {} it does not throw and returns a known status', async () => {
  const result = await capabilityCheck.run({ env: {} });
  assert.ok(STATUS.includes(result.status));
});

// ---- prepared sandbox aggregate ----

test('runDoctor is green in a prepared sandbox, then an absent identity alone makes it unknown and exits 1', async () => {
  const box = doctorSandbox('ast-doctor-prepared-');
  mkdirSync(path.join(box.root, 'bin'), { recursive: true });
  mkdirSync(path.join(box.root, 'src'), { recursive: true });
  writeFileSync(path.join(box.root, 'bin', 'x'), 'x\n');
  writeFileSync(path.join(box.root, 'src', 'a.js'), 'a\n');
  writeManifest(
    box.root,
    `
[manifest]
schema = 1

[cells."tmux/present"]
kind = "required"
capture = "ast fixture capture tmux/present"
why = "present"
`,
  );
  writeCell(box.root, 'tmux/present', 'captured\n');

  mkdirSync(box.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(box.stateDir, 0o700);
  const identityPath = path.join(box.stateDir, 'identity.json');
  writeFileSync(identityPath, JSON.stringify(await buildIdentityManifest({ root: box.root })), { mode: 0o600 });
  chmodSync(identityPath, 0o600);
  await installTmuxBlock(path.join(box.home, '.tmux.conf'), box.root);

  const fixturesDir = path.join(box.base, 'tmux-fixtures');
  const logPath = path.join(box.base, 'tmux.log');
  const socketPath = path.join(box.base, 'asterism-test-doctor-sock');
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(socketPath, 'synthetic socket witness\n');
  writeFileSync(path.join(fixturesDir, 'display-message.out'), `${socketPath},123,3.7c\n`);
  writeFileSync(path.join(fixturesDir, 'list-panes.out'), '%2||1\n');
  const env = {
    PATH: `${FAKE_TMUX_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: box.home,
    XDG_STATE_HOME: box.stateHome,
    ASTERISM_FAKE_TMUX_LOG: logPath,
    ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir,
    TMUX: `${socketPath},123,0`,
  };
  const registry = syntheticRegistry();

  const clean = await runDoctor({ root: box.root, home: box.home, env, registry });
  assert.equal(clean.exit, 0);
  assert.ok(clean.results.every((result) => result.status === 'pass' || result.status === 'warn'));

  unlinkSync(identityPath);
  const missingIdentity = await runDoctor({ root: box.root, home: box.home, env, registry });
  assert.equal(missingIdentity.exit, 1);
  assert.equal(missingIdentity.results.find((result) => result.id === 'identity.sha')?.status, 'unknown');
});

// ---- CLI wiring ----

test('bin/ast doctor renders JSON and aligned text with declared statuses and numeric counts', async () => {
  const box = doctorSandbox('ast-doctor-cli-');
  const env = {
    PATH: box.emptyBin,
    HOME: box.home,
    XDG_STATE_HOME: box.stateHome,
    TERM: 'dumb',
  };
  const { code, stdout, stderr } = await runAst(['doctor', '--json'], env);

  assert.equal(code, 1);
  assert.equal(stderr, '');

  const results = JSON.parse(stdout);
  assert.ok(Array.isArray(results));
  assert.equal(results.length, CHECKS.length);
  for (const result of results) {
    assert.ok(STATUS.includes(result.status));
    assert.notEqual(result.status, 'todo');
    assert.equal(typeof result.id, 'string');
    assert.equal(typeof result.detail, 'string');
  }

  const textRun = await runAst(['doctor'], env);
  assert.equal(textRun.code, 1);
  assert.equal(textRun.stderr, '');
  assert.match(textRun.stdout, /^unknown {2}/m);
  assert.match(
    textRun.stdout,
    /^doctor: \d+ pass, \d+ warn, \d+ fail, \d+ todo, \d+ unknown$/m,
  );
});

test('bin/ast doctor emits a non-ENOENT socket resolver note', async () => {
  const box = doctorSandbox('ast-doctor-socket-note-');
  const socketDir = path.join('/tmp', `tmux-${process.getuid()}`);
  const socketPath = path.join(socketDir, `asterism-test-doctor-note-${path.basename(box.base)}`);
  mkdirSync(socketDir, { recursive: true });
  writeFileSync(socketPath, '');
  writeFileSync(path.join(box.emptyBin, 'tmux'), 'not executable\n');
  const env = {
    PATH: box.emptyBin,
    HOME: box.home,
    XDG_STATE_HOME: box.stateHome,
    TERM: 'dumb',
  };

  try {
    const { code, stdout, stderr } = await runAst(['doctor', '--json'], env);
    assert.equal(code, 1);
    assert.ok(Array.isArray(JSON.parse(stdout)));
    const note = `note: tmux: socket-probe-failed: ${socketPath}: spawn tmux EACCES\n`;
    assert.equal(stderr.split(note).length - 1, 1, stderr);
  } finally {
    unlinkSync(socketPath);
  }
});
