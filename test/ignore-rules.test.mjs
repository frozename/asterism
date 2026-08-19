import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_SETTINGS_PATH = '.claude/settings.local.json'; // quarantine-exempt: real path named by this repository's ignore rules; assertion must use the actual path.

const ignoredPaths = [
  ['private/x', 'private/ working paths become committable'],
  ['notes.PRIVATE.md', '*.PRIVATE.md working files become committable'],
  ['docs/PLAN.md', 'docs/ working paths become committable'],
  ['docs/notes/x.md', 'docs/notes/ working paths become committable'],
  ['.env', '.env becomes committable'],
  ['.env.local', '.env.* files become committable'],
  [LOCAL_SETTINGS_PATH, 'coding-agent CLI settings become committable'],
  ['node_modules/x', 'dependency trees become committable'],
];

const trackedControls = [
  ['README.md', 'top-level documentation stops being committable'],
  ['package.json', 'package metadata stops being committable'],
  ['test/example.test.mjs', 'test files stop being committable'],
  ['src/core/reconcile.js', 'source files stop being committable'],
  ['harness/x.mjs', 'harness files stop being committable'],
  ['.env.example', 'example environment files stop being committable'],
];

test('protected working paths are ignored by effect', async () => {
  assert.ok(
    existsSync(path.join(ROOT, '.gitignore')),
    '.gitignore is absent; protected working paths become committable',
  );

  for (const [target, consequence] of ignoredPaths) {
    assert.equal(await checkIgnoreStatus(target), 0, `${target} is not ignored; ${consequence}`);
  }
});

test('committable controls are not ignored', async () => {
  assert.ok(
    existsSync(path.join(ROOT, '.gitignore')),
    '.gitignore is absent; committable controls cannot prove ignore polarity',
  );

  for (const [target, consequence] of trackedControls) {
    assert.equal(await checkIgnoreStatus(target), 1, `${target} is ignored; ${consequence}`);
  }
});

test('bulk staging set excludes protected working paths', async () => {
  assert.ok(
    existsSync(path.join(ROOT, '.gitignore')),
    '.gitignore is absent; bulk staging can include protected working paths',
  );

  const files = await listStageableFiles();

  // Fresh worktrees have no such paths to enumerate, so this guard is paired
  // with direct check-ignore assertions above.
  for (const file of files) {
    assert.ok(!isProtectedStageablePath(file), `${file} is stageable by bulk add; protected paths become committable`);
  }
});

async function checkIgnoreStatus(target) {
  try {
    await execFileAsync('git', ['check-ignore', '--no-index', '-q', target], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return 0;
  } catch (error) {
    if (error?.code === 1) return 1;
    const code = error?.code ?? 'unknown';
    throw new Error(`git check-ignore failed with exit ${code}; protected path rules cannot be proven`);
  }
}

async function listStageableFiles() {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: ROOT, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );

    return stdout
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry.length > 0);
  } catch (error) {
    const code = error?.code ?? 'unknown';
    throw new Error(`git ls-files failed with exit ${code}; bulk staging safety cannot be proven`);
  }
}

function isProtectedStageablePath(file) {
  return file.startsWith('docs/') || file.startsWith('private/') || path.basename(file).endsWith('.PRIVATE.md');
}
