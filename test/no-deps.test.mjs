import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { createTempPrefix, parsePinnedVersions } from '../harness/typecheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package.json has no dependencies and no root node_modules', async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(Object.hasOwn(packageJson, 'dependencies'), false);
  assert.equal(Object.hasOwn(packageJson, 'devDependencies'), false);
  assert.equal(existsSync(path.join(ROOT, 'node_modules')), false);
});

// harness/typecheck.mjs installs typescript + @types/node so it can run tsc
// without the repo ever growing a node_modules; the property that matters is
// that its install prefix -- the one path both `npm install --prefix` and
// `tsc --typeRoots` are built from -- never resolves under ROOT. A real
// `npm install` isn't exercised here: it needs the network and would make
// this suite non-hermetic on every run, so this pins the structural
// guarantee (prefix is outside the repo) rather than the full script.
test('harness/typecheck.mjs installs into a prefix outside the repository tree', async () => {
  const prefix = await createTempPrefix();
  try {
    const relative = path.relative(ROOT, prefix);
    assert.ok(
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
      `typecheck install prefix ${prefix} resolves inside the repository`,
    );
    assert.equal(existsSync(path.join(ROOT, 'node_modules')), false);
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
});

// harness/typecheck.mjs reads the pinned versions out of the CI workflow so it
// cannot install something CI has moved past, and falls back to hardcoded
// versions with only a stderr warning when the pattern stops matching. That
// warning is easy to miss, which would leave AGENTS.md claiming the script
// tracks CI while it silently used a stale pin. Fail loudly here instead.
test('the typecheck script still parses the versions the CI workflow pins', async () => {
  const workflow = await readFile(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const parsed = parsePinnedVersions(workflow);

  assert.notEqual(
    parsed,
    null,
    'ci.yml no longer matches the pinned-version pattern; harness/typecheck.mjs would fall back to a hardcoded version instead of tracking CI',
  );
  assert.match(parsed.typescript, /^\d+\.\d+\.\d+$/);
  assert.match(parsed.typesNode, /^\d+\.\d+\.\d+$/);
});

test('control: the pinned-version parser returns null when the pattern is absent', () => {
  assert.equal(parsePinnedVersions('jobs:\n  types:\n    steps:\n      - run: echo nothing here\n'), null);
});
