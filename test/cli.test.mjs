import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { adapters } from '../src/adapters/index.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'ast-cli-test-'));

const VENDOR_LITERAL = /claude|codex|gemini|copilot|opencode|CLAUDE_|dangerously/i; // quarantine-exempt: this is the enforcement regex itself, not a vendor mention.

async function runAst(args, envOverrides = {}) {
  const env = { PATH: process.env.PATH, HOME: TMP_HOME, TERM: 'dumb', ...envOverrides };

  try {
    const { stdout, stderr } = await execFileAsync(AST_BIN, args, { cwd: ROOT, encoding: 'utf8', env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('no verb prints usage on stderr and exits 2', async () => {
  const { code, stdout, stderr } = await runAst([]);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr.toLowerCase(), /usage/);
  assert.match(stderr, /version/);
});

test('ast version prints the package.json version and exits 0', async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const { code, stdout, stderr } = await runAst(['version']);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), packageJson.version);
  assert.equal(stderr, '');
});

test('an unknown verb prints usage on stderr and exits 2', async () => {
  const { code, stderr } = await runAst(['nope']);
  assert.equal(code, 2);
  assert.match(stderr.toLowerCase(), /usage/);
});

test('a name that fails the verb regex exits 2 without loading anything outside src/cli/verbs/', async () => {
  for (const args of [['../version'], ['..']]) {
    const { code, stdout } = await runAst(args);
    assert.equal(code, 2, `${args.join(' ')} should exit 2`);
    assert.equal(stdout, '');
  }
});

test('bin/ast source contains no vendor literal', () => {
  const source = readFileSync(AST_BIN, 'utf8');
  assert.equal(VENDOR_LITERAL.test(source), false, 'bin/ast must stay vendor-neutral; vendor data lives under src/adapters/<id>/');
});

test('a non-mutating verb still exits 0 while every registered agent-session marker is present', async () => {
  for (const adapter of adapters.values()) {
    for (const marker of adapter.agentEnvMarkers) {
      const { code, stdout } = await runAst(['version'], { [marker]: '1' });
      assert.equal(code, 0, `ast version should still run with ${marker} set`);
      assert.ok(stdout.trim().length > 0);
    }
  }

  const allMarkers = Object.fromEntries(
    [...adapters.values()].flatMap((adapter) => adapter.agentEnvMarkers.map((marker) => [marker, '1'])),
  );
  const { code } = await runAst(['version'], allMarkers);
  assert.equal(code, 0, 'ast version should still run with every marker set at once');
});
