import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { adapters } from '../src/adapters/index.js';
import { buildTmuxPlan, captures as tmuxCaptures, runCell, socketLabel } from '../src/capture/tmux.js';
import { findLeaks } from '../src/core/scrub.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');

const REGISTRY_IDLE_CELL = 'claude/registry/idle'; // quarantine-exempt: real registered cell id this test captures end to end.
const REGISTRY_BUSY_CELL = 'claude/registry/busy'; // quarantine-exempt: real registered cell id this test captures end to end.
const HELP_CELL = 'claude/help'; // quarantine-exempt: real registered cell id asserted in `ast fixture list` output.
const ADAPTER_CONFIG_DIRNAME = '.claude'; // quarantine-exempt: real config dirname the file-source recipe under test reads.
const FAKE_ADAPTER_CLI_VERSION = '0.0.0-fake-fixture-capture';
const ADAPTER_CLI_EXECUTABLE_NAME = 'claude'; // quarantine-exempt: must match CLI_VERSION_ARGV's argv[0] in src/adapters/claude/captures.js.

async function runAst(args, { cwd, env }) {
  try {
    const { stdout, stderr } = await execFileAsync(AST_BIN, args, { cwd, env, encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// A fake adapter-CLI executable on the front of PATH, so any cliVersionArgv
// resolution during a test resolves to this deterministic stand-in instead
// of the real CLI installed on the developer's machine. The rest of the real
// PATH stays behind it so node/bun and everything else still resolves
// normally -- only the shadowed executable name changes.
function makeFakeAdapterCliBin() {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'ast-fake-adapter-cli-bin-'));
  const executablePath = path.join(binDir, ADAPTER_CLI_EXECUTABLE_NAME);
  writeFileSync(executablePath, `#!/bin/sh\necho "${FAKE_ADAPTER_CLI_VERSION}"\n`);
  chmodSync(executablePath, 0o755);
  return binDir;
}

function baseEnv(home) {
  return { PATH: `${makeFakeAdapterCliBin()}:${process.env.PATH ?? ''}`, HOME: home, TERM: 'dumb', LANG: 'C' };
}

function makeTempHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'ast-fixture-home-'));
}

function makeCwdWithFixtures() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'ast-fixture-cwd-'));
  mkdirSync(path.join(cwd, 'fixtures'));
  return cwd;
}

// Discovered from the registry, not spelled out, so this file never has to
// name a vendor to exercise the manual-source capture path.
function findManualRecipe() {
  for (const adapter of adapters.values()) {
    if (!adapter.captures) continue;
    const found = adapter.captures.find((recipe) => recipe.source === 'manual');
    if (found) return found;
  }
  return null;
}

// Derived from the registry + tmux.js rather than a literal list, so this
// stays true if either grows or loses a cell.
function expectedCellSourceLines() {
  const recipes = [...tmuxCaptures];
  for (const adapter of adapters.values()) {
    if (adapter.captures) recipes.push(...adapter.captures);
  }
  return new Set(recipes.map((recipe) => `${recipe.cell}  ${recipe.source}`));
}

test('captures a file-source cell, scrubs it, and writes raw + meta.json relative to cwd', async () => {
  const home = makeTempHome();
  const sessionsDir = path.join(home, ADAPTER_CONFIG_DIRNAME, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const fakeUserPath = '/Users/fixture-fake-user/project/thing.js';
  const fakeUuid = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
  writeFileSync(path.join(sessionsDir, '111.json'), JSON.stringify({ cwd: fakeUserPath, id: '111' }));
  writeFileSync(path.join(sessionsDir, '222.json'), JSON.stringify({ session: fakeUuid, id: '222' }));

  const cwd = makeCwdWithFixtures();
  const { code, stdout, stderr } = await runAst(
    ['fixture', 'capture', REGISTRY_IDLE_CELL, '--home', home, '--provoked-by', 'test fixture'],
    { cwd, env: baseEnv(home) },
  );

  assert.equal(code, 0, `expected exit 0, got ${code}; stderr: ${stderr}`);
  assert.match(
    stdout,
    new RegExp(`^captured ${REGISTRY_IDLE_CELL.replace(/\//g, '\\/')} \\(\\d+ bytes, \\d+ redactions\\) -> fixtures/${REGISTRY_IDLE_CELL.replace(/\//g, '\\/')}/\\n$`),
  );

  const cellDir = path.join(cwd, 'fixtures', ...REGISTRY_IDLE_CELL.split('/'));
  const raw = readFileSync(path.join(cellDir, 'raw'));
  const meta = JSON.parse(readFileSync(path.join(cellDir, 'meta.json'), 'utf8'));

  assert.equal(meta.cell, REGISTRY_IDLE_CELL);
  assert.equal(meta.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(meta.bytes, raw.length);
  assert.equal(meta.provokedBy, 'test fixture');
  assert.equal(meta.cliVersion, FAKE_ADAPTER_CLI_VERSION, 'cliVersion should come from the fake PATH executable, never the installed one');
  assert.ok(Array.isArray(meta.redactions));
  assert.ok(meta.redactions.length > 0, 'expected the fake user path and uuid to be redacted');
  assert.deepEqual(meta.kills, []);

  for (const redaction of meta.redactions) {
    const span = raw.slice(redaction.offset, redaction.offset + redaction.length).toString('utf8');
    assert.equal(span.length, redaction.length, 'placeholder must preserve the original span length');
    assert.ok(span.startsWith(`<${redaction.kind}`), `placeholder should start with <${redaction.kind}: ${span}`);
  }

  assert.equal(raw.includes(fakeUserPath), false);
  assert.equal(raw.includes(fakeUuid), false);
});

test('a file-source capture scrubs meta.json string fields so the raw home path never survives', async () => {
  const home = makeTempHome();
  const sessionsDir = path.join(home, ADAPTER_CONFIG_DIRNAME, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(path.join(sessionsDir, '111.json'), JSON.stringify({ id: '111' }));

  const cwd = makeCwdWithFixtures();
  const { code } = await runAst(['fixture', 'capture', REGISTRY_IDLE_CELL, '--home', home], {
    cwd,
    env: baseEnv(home),
  });
  assert.equal(code, 0);

  const cellDir = path.join(cwd, 'fixtures', ...REGISTRY_IDLE_CELL.split('/'));
  const metaText = readFileSync(path.join(cellDir, 'meta.json'), 'utf8');
  const meta = JSON.parse(metaText);

  assert.equal(metaText.includes(home), false, 'meta.json must not contain the raw home path');
  // The temp home itself may live under a tmp-shaped path (e.g. macOS
  // /var/folders/...), so the placeholder kind can be <home> or <tmppath>
  // depending on which pattern wins the longest-match overlap in scrub.js;
  // either way the point is that it's a placeholder, not the raw path.
  assert.match(meta.command, /^read </, 'the command field should carry a scrubbed placeholder, not the real home');

  // sha256 and profileHash are legitimate hex digests, not leaks, so this
  // only checks the path-shaped kinds a home-directory leak would produce.
  const pathLeaks = findLeaks(metaText, { home, extraRoots: [] }).filter((leak) =>
    ['home', 'userpath', 'tmppath'].includes(leak.kind),
  );
  assert.deepEqual(pathLeaks, [], `meta.json leaks the home path: ${JSON.stringify(pathLeaks)}`);
});

test('an unknown cell exits 2', async () => {
  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();

  const { code, stderr } = await runAst(['fixture', 'capture', 'nope/not-a-cell', '--home', home], {
    cwd,
    env: baseEnv(home),
  });

  assert.equal(code, 2);
  assert.match(stderr, /unknown cell/);
});

test('a grammar-invalid cell id exits 2', async () => {
  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();

  const { code, stderr } = await runAst(['fixture', 'capture', 'Not_Valid', '--home', home], {
    cwd,
    env: baseEnv(home),
  });

  assert.equal(code, 2);
  assert.match(stderr, /invalid cell id/);
});

test('an empty capture exits 1', async () => {
  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();

  const { code, stderr } = await runAst(['fixture', 'capture', REGISTRY_BUSY_CELL, '--home', home], {
    cwd,
    env: baseEnv(home),
  });

  assert.equal(code, 1);
  assert.match(stderr, /0 bytes/);
});

test('a manual cell captured with --from reads the given file, scrubs it, and records an array read command', async () => {
  const recipe = findManualRecipe();
  assert.ok(recipe, 'expected at least one manual-source capture recipe registered');

  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();
  const fromDir = mkdtempSync(path.join(os.tmpdir(), 'ast-manual-from-'));
  const fromFile = path.join(fromDir, 'manual-capture-input.txt');

  const fakeUserPath = '/Users/fixture-fake-user/project/thing.js';
  const fakeUuid = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
  writeFileSync(fromFile, `provoked artefact mentioning ${fakeUserPath} and ${fakeUuid}\n`);

  const { code, stderr } = await runAst(['fixture', 'capture', recipe.cell, '--home', home, '--from', fromFile], {
    cwd,
    env: baseEnv(home),
  });

  assert.equal(code, 0, `expected exit 0, got ${code}; stderr: ${stderr}`);

  const cellDir = path.join(cwd, 'fixtures', ...recipe.cell.split('/'));
  const raw = readFileSync(path.join(cellDir, 'raw'));
  const metaText = readFileSync(path.join(cellDir, 'meta.json'), 'utf8');
  const meta = JSON.parse(metaText);

  assert.ok(Array.isArray(meta.redactions));
  assert.ok(meta.redactions.length > 0, 'expected the fake user path and uuid to be redacted');
  assert.ok(Array.isArray(meta.command), 'manual capture command should be recorded as an array');
  assert.equal(meta.command[0], 'read');
  assert.equal(metaText.includes(home), false, 'meta.json must not contain the raw home path');
  assert.equal(raw.includes(fakeUserPath), false);
  assert.equal(raw.includes(fakeUuid), false);
});

test('a manual cell captured with --from pointing at a nonexistent path exits 2, names --from and the path, and writes nothing (control: readable --from above still exits 0)', async () => {
  const recipe = findManualRecipe();
  assert.ok(recipe, 'expected at least one manual-source capture recipe registered');

  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();
  const fromDir = mkdtempSync(path.join(os.tmpdir(), 'ast-manual-from-'));
  const missingFromFile = path.join(fromDir, 'does-not-exist.txt');

  const { code, stderr } = await runAst(
    ['fixture', 'capture', recipe.cell, '--home', home, '--from', missingFromFile],
    { cwd, env: baseEnv(home) },
  );

  assert.equal(code, 2);
  assert.match(stderr, /--from/);
  assert.ok(stderr.includes(missingFromFile), 'stderr should name the unreadable --from path');

  const cellDir = path.join(cwd, 'fixtures', ...recipe.cell.split('/'));
  assert.equal(existsSync(cellDir), false, 'nothing should be written under fixtures/ for an unreadable --from path');
});

test('a manual cell captured without --from exits 2 and names the flag and the recipe provoke text', async () => {
  const recipe = findManualRecipe();
  assert.ok(recipe, 'expected at least one manual-source capture recipe registered');

  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();

  const { code, stderr } = await runAst(['fixture', 'capture', recipe.cell, '--home', home], {
    cwd,
    env: baseEnv(home),
  });

  assert.equal(code, 2);
  assert.match(stderr, /--from/);
  assert.ok(stderr.includes(recipe.provoke), 'stderr should quote the recipe\'s provoke text');
});

test('--from given for a non-manual cell exits 2', async () => {
  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();
  const fromDir = mkdtempSync(path.join(os.tmpdir(), 'ast-manual-from-'));
  const fromFile = path.join(fromDir, 'unused-input.txt');
  writeFileSync(fromFile, 'unused\n');

  const { code, stderr } = await runAst(['fixture', 'capture', HELP_CELL, '--home', home, '--from', fromFile], {
    cwd,
    env: baseEnv(home),
  });

  assert.equal(code, 2);
  assert.match(stderr, /--from/);
});

test('ast fixture list exits 0 and prints "<cell>  <source>" for every known cell, sorted by cell', async () => {
  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();

  const { code, stdout } = await runAst(['fixture', 'list'], { cwd, env: baseEnv(home) });

  assert.equal(code, 0);
  assert.ok(stdout.includes(HELP_CELL));
  assert.ok(stdout.includes('tmux/list-panes'));

  const lines = stdout.trimEnd().split('\n');
  // tmux.js registers its own cells with source 'tmux', a fourth kind
  // alongside the adapter-recipe sources 'argv' | 'file' | 'manual'.
  const lineWithSourcePattern = /^[a-z0-9/_.-]+ {2}(argv|file|manual|tmux)$/;
  for (const line of lines) {
    assert.match(line, lineWithSourcePattern, `line "${line}" should be "<cell>  <source>"`);
  }

  assert.deepEqual(new Set(lines), expectedCellSourceLines());
  assert.ok(lines.some((line) => line.endsWith('  manual')), 'expected at least one manual-source cell listed');

  const sortedCells = lines.map((line) => line.split('  ')[0]);
  assert.deepEqual(sortedCells, [...sortedCells].sort());

  // control: the pattern must reject a cell id printed without its source.
  assert.equal(lineWithSourcePattern.test(HELP_CELL), false, 'the pattern should reject a line without a source');
});

test('tmux argv plans use a hermetic asterism- socket, -u, -f /dev/null, ending in kill-server', () => {
  for (const cell of ['tmux/list-panes', 'tmux/list-clients', 'tmux/capture-pane/plain', 'tmux/capture-pane/escapes']) {
    const plan = buildTmuxPlan(cell, 999);
    const label = socketLabel(999);

    assert.ok(label.startsWith('asterism-'), 'socket label must start with asterism-');
    assert.ok(plan[0].includes('-u'), 'new-session invocation should include -u');
    const dashFIndex = plan[0].indexOf('-f');
    assert.ok(dashFIndex !== -1 && plan[0][dashFIndex + 1] === '/dev/null', 'new-session should use -f /dev/null');
    assert.ok(plan[0].includes(label), 'every invocation should target the hermetic socket label');

    const last = plan[plan.length - 1];
    assert.equal(last[last.length - 1], 'kill-server', 'the plan must end with kill-server');
  }
});

function fakeTmuxExec({ socketPath = '/tmp/fake-asterism-socket', paneOutput = 'pane-output\n' } = {}) {
  return async (argv) => {
    if (argv.includes('-V')) return { stdout: Buffer.from('tmux 3.7\n') };
    if (argv.includes('display-message')) return { stdout: Buffer.from(`${socketPath}\n`) };
    if (argv.includes('list-panes')) return { stdout: Buffer.from(paneOutput) };
    return { stdout: Buffer.from('') };
  };
}

test('runCell refuses to record the capture when the socket file survives kill-server', async () => {
  const exec = fakeTmuxExec();
  const result = await runCell('tmux/list-panes', { env: {} }, exec, () => true);

  assert.equal(result.ok, false);
  assert.match(result.message, /socket/);
});

test('runCell succeeds and records command as an argv array once the socket is gone (control pair)', async () => {
  const exec = fakeTmuxExec();
  const result = await runCell('tmux/list-panes', { env: {} }, exec, () => false);

  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.command), 'command should be recorded as an argv array, not a joined string');
  assert.equal(result.text, 'pane-output\n');
});
