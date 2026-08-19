import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { adapters } from '../src/adapters/index.js';
import { AXES, UNKNOWN } from '../src/core/caps.js';
import { CHECKS, runDoctor, STATUS } from '../src/doctor/index.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const ID_PATTERN = /^[a-z]+(\.[a-z-]+)+$/;

// The checks that have gone live -- excluded from the "still reports todo" sweep below.
const LIVE_CHECK_IDS = ['fixtures.manifest', 'probe.capability-unknowns'];

const EXPECTED_TODO_IDS = [
  'state.permissions',
  'state.targets-are-ids',
  'identity.sha',
  'tmux.version-floor',
  'tmux.managed-block-drift',
  'tmux.pipe-pane-occupied',
  'attention.stuck',
  'retention.counts',
  'canary.unknown-fields',
  'launchd.stale-plists',
].sort();

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
    const { stdout, stderr } = await execFileAsync(AST_BIN, args, { cwd: ROOT, encoding: 'utf8', env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
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

test('STATUS is frozen and exactly pass/warn/fail/todo', () => {
  assert.ok(Object.isFrozen(STATUS));
  assert.deepEqual(STATUS, ['pass', 'warn', 'fail', 'todo']);
});

test('every check except the live ones currently reports todo', async () => {
  const todoIds = CHECKS.filter((check) => !LIVE_CHECK_IDS.includes(check.id))
    .map((check) => check.id)
    .sort();
  assert.deepEqual(todoIds, EXPECTED_TODO_IDS);

  for (const check of CHECKS) {
    if (LIVE_CHECK_IDS.includes(check.id)) continue;
    const result = await check.run({ root: '/unused', home: '/unused', env: {} });
    assert.equal(result.status, 'todo', `${check.id} should still report todo`);
  }
});

// ---- runDoctor exit code ----

test('runDoctor exits 1 today because at least one registered check is todo', async () => {
  const { results, exit } = await runDoctor({ root: ROOT, home: os.homedir(), env: { PATH: process.env.PATH ?? '' } });
  assert.ok(results.some((result) => result.status === 'todo'));
  assert.equal(exit, 1);
});

test('runDoctor exits 0 with an injected all-pass/warn CHECKS array, and 1 the moment one fails', async () => {
  const passWarn = [
    { id: 'x.pass', prevents: 'p', run: async () => ({ status: 'pass', detail: 'ok' }) },
    { id: 'x.warn', prevents: 'p', run: async () => ({ status: 'warn', detail: 'meh' }) },
  ];
  const clean = await runDoctor({ root: '/unused', home: '/unused', env: {}, checks: passWarn });
  assert.equal(clean.exit, 0);

  const withFail = [...passWarn, { id: 'x.fail', prevents: 'p', run: async () => ({ status: 'fail', detail: 'bad' }) }];
  const failing = await runDoctor({ root: '/unused', home: '/unused', env: {}, checks: withFail });
  assert.equal(failing.exit, 1);
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

// ---- CLI wiring ----

test('bin/ast doctor --json prints the results array with a minimal env and exits 1', async () => {
  const env = { PATH: process.env.PATH ?? '', HOME: tmpDir('ast-doctor-cli-home-'), TERM: 'dumb' };
  const { code, stdout, stderr } = await runAst(['doctor', '--json'], env);

  assert.equal(code, 1);
  assert.equal(stderr, '');

  const results = JSON.parse(stdout);
  assert.ok(Array.isArray(results));
  assert.equal(results.length, CHECKS.length);
  for (const result of results) {
    assert.ok(STATUS.includes(result.status));
    assert.equal(typeof result.id, 'string');
    assert.equal(typeof result.detail, 'string');
  }
});
