import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { extractImportSpecifiers, resolveRelativeSpecifier, walkFiles } from '../harness/structural.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const BIN_DIR = path.join(ROOT, 'bin');

const CHILD_PROCESS_SPECIFIERS = new Set(['child_process', 'node:child_process']);
const ALLOWED_CHILD_PROCESS_IMPORTERS = new Set(['src/io/procexec.js', 'src/io/tmuxexec.js']);

function toRepoRelative(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function readFilesAsRepoRelative(root) {
  return walkFiles(root).map((absPath) => ({
    path: toRepoRelative(absPath),
    source: readFileSync(absPath, 'utf8'),
  }));
}

// (a) an adapter directory never reaches into a sibling adapter, or into the
// registry that is supposed to be the only thing importing adapters.
function adapterBoundaryViolation(file) {
  const ownMatch = file.path.match(/^src\/adapters\/([^/]+)\//);
  if (!ownMatch) return null;
  const ownAdapter = ownMatch[1];

  for (const specifier of extractImportSpecifiers(file.source)) {
    if (!(specifier.startsWith('.') || specifier.startsWith('/'))) continue;
    const resolved = resolveRelativeSpecifier(file.path, specifier);

    if (resolved === 'src/adapters/index.js') {
      return `${file.path}: adapter "${ownAdapter}" imports the registry via "${specifier}"`;
    }

    const otherMatch = resolved.match(/^src\/adapters\/([^/]+)\//);
    if (otherMatch && otherMatch[1] !== ownAdapter) {
      return `${file.path}: adapter "${ownAdapter}" imports adapter "${otherMatch[1]}" via "${specifier}"`;
    }
  }
  return null;
}

// (b) node:child_process (and its bare form) may only be reached through the
// two declared exec chokepoints; every other file under bin/ or src/ is banned.
function childProcessChokepointViolation(file) {
  if (!(file.path.startsWith('bin/') || file.path.startsWith('src/'))) return null;
  if (ALLOWED_CHILD_PROCESS_IMPORTERS.has(file.path)) return null;

  for (const specifier of extractImportSpecifiers(file.source)) {
    if (CHILD_PROCESS_SPECIFIERS.has(specifier)) {
      return `${file.path}: imports child_process outside the exec chokepoints (via "${specifier}")`;
    }
  }
  return null;
}

// (c) forward tripwire: paneio.js is scoped to src/io/ and src/cli/verbs/, and
// a seam/penumbra path may never import paneio.js or tmuxexec.js, regardless
// of directory.
function paneioImportViolation(file) {
  const allowedDir = file.path.startsWith('src/io/') || file.path.startsWith('src/cli/verbs/');
  if (allowedDir) return null;

  for (const specifier of extractImportSpecifiers(file.source)) {
    if (specifier.endsWith('paneio.js')) {
      return `${file.path}: imports paneio.js from outside src/io/ or src/cli/verbs/ (via "${specifier}")`;
    }
  }
  return null;
}

function seamPenumbraTripwireViolation(file) {
  if (!(file.path.includes('seam') || file.path.includes('penumbra'))) return null;

  for (const specifier of extractImportSpecifiers(file.source)) {
    if (specifier.endsWith('paneio.js') || specifier.endsWith('tmuxexec.js')) {
      return `${file.path}: a seam/penumbra path imports "${specifier}"`;
    }
  }
  return null;
}

// (d) product code under src/ (and bin/ast) never depends on test/ or harness/.
function testOrHarnessImportViolation(file) {
  for (const specifier of extractImportSpecifiers(file.source)) {
    if (!(specifier.startsWith('.') || specifier.startsWith('/'))) continue;
    const resolved = resolveRelativeSpecifier(file.path, specifier);
    if (resolved.startsWith('test/') || resolved.startsWith('harness/')) {
      return `${file.path}: imports "${specifier}" from test/ or harness/`;
    }
  }
  return null;
}

// (e) the guest hook binary and src/hook/** import neither tmuxexec.js nor
// paneio.js -- ast-hook is structurally incapable of pressing a key.
function hookKeypressViolation(file) {
  const inScope = file.path === 'bin/ast-hook' || file.path.startsWith('src/hook/');
  if (!inScope) return null;
  for (const specifier of extractImportSpecifiers(file.source)) {
    if (specifier.endsWith('tmuxexec.js') || specifier.endsWith('paneio.js')) {
      return `${file.path}: the hook path imports "${specifier}"`;
    }
  }
  return null;
}

test('(a) no file under src/adapters/<id>/ imports a sibling adapter or the registry', () => {
  assert.ok(existsSync(path.join(SRC_DIR, 'adapters')), 'src/adapters/ is missing');

  const violations = readFilesAsRepoRelative(path.join(SRC_DIR, 'adapters')).map(adapterBoundaryViolation).filter(Boolean);
  assert.deepEqual(violations, []);
});

test('(a) control: a cross-adapter import and a registry import are caught; a same-adapter import passes', () => {
  const crossAdapter = adapterBoundaryViolation({
    path: 'src/adapters/alpha/index.js',
    source: "import other from '../beta/index.js';\n",
  });
  assert.ok(crossAdapter, 'cross-adapter import was not flagged');

  const registryImport = adapterBoundaryViolation({
    path: 'src/adapters/alpha/index.js',
    source: "import { adapters } from '../index.js';\n",
  });
  assert.ok(registryImport, 'adapter importing the registry was not flagged');

  const sameAdapter = adapterBoundaryViolation({
    path: 'src/adapters/alpha/index.js',
    source: "import { helper } from './helper.js';\n",
  });
  assert.equal(sameAdapter, null);
});

test('(b) only the declared exec chokepoints import child_process', () => {
  assert.ok(existsSync(BIN_DIR), 'bin/ is missing');
  assert.ok(existsSync(SRC_DIR), 'src/ is missing');

  const files = [...readFilesAsRepoRelative(BIN_DIR), ...readFilesAsRepoRelative(SRC_DIR)];
  const violations = files.map(childProcessChokepointViolation).filter(Boolean);
  assert.deepEqual(violations, []);
});

test('(b) control: an outside importer is caught; a chokepoint and a non-cp import pass', () => {
  const outsideImporter = childProcessChokepointViolation({
    path: 'src/cli/verbs/version.js',
    source: "import { execFile } from 'node:child_process';\n",
  });
  assert.ok(outsideImporter, 'outside importer of child_process was not flagged');

  const chokepoint = childProcessChokepointViolation({
    path: 'src/io/procexec.js',
    source: "import { execFile } from 'node:child_process';\n",
  });
  assert.equal(chokepoint, null);

  const clean = childProcessChokepointViolation({
    path: 'src/core/enums.js',
    source: "import path from 'node:path';\n",
  });
  assert.equal(clean, null);
});

test('(c) paneio.js is only imported from src/io/ or src/cli/verbs/', () => {
  assert.ok(existsSync(SRC_DIR), 'src/ is missing');

  const violations = readFilesAsRepoRelative(SRC_DIR).map(paneioImportViolation).filter(Boolean);
  assert.deepEqual(violations, []);
});

test('(c) control: an outside importer of paneio.js is caught; io/ and cli/verbs/ importers pass', () => {
  const outsideImporter = paneioImportViolation({
    path: 'src/core/thing.js',
    source: "import { write } from '../io/paneio.js';\n",
  });
  assert.ok(outsideImporter, 'outside importer of paneio.js was not flagged');

  const ioImporter = paneioImportViolation({
    path: 'src/io/paneio.js',
    source: "import { helper } from './helper.js';\n",
  });
  assert.equal(ioImporter, null);

  const verbImporter = paneioImportViolation({
    path: 'src/cli/verbs/paint.js',
    source: "import { write } from '../../io/paneio.js';\n",
  });
  assert.equal(verbImporter, null);
});

test('(c) forward tripwire: no seam/penumbra path ever imports paneio.js or tmuxexec.js', () => {
  assert.ok(existsSync(SRC_DIR), 'src/ is missing');

  const violations = readFilesAsRepoRelative(SRC_DIR).map(seamPenumbraTripwireViolation).filter(Boolean);
  assert.deepEqual(violations, []);
});

test('(c) control: a seam/penumbra path importing paneio.js or tmuxexec.js is caught; a clean import passes', () => {
  const seamOffender = seamPenumbraTripwireViolation({
    path: 'src/io/seam-writer.js',
    source: "import { write } from './paneio.js';\n",
  });
  assert.ok(seamOffender, 'a seam path importing paneio.js was not flagged');

  const penumbraOffender = seamPenumbraTripwireViolation({
    path: 'src/penumbra/bridge.js',
    source: "import { spawn } from './tmuxexec.js';\n",
  });
  assert.ok(penumbraOffender, 'a penumbra path importing tmuxexec.js was not flagged');

  const clean = seamPenumbraTripwireViolation({
    path: 'src/io/seam-writer.js',
    source: "import path from 'node:path';\n",
  });
  assert.equal(clean, null);
});

test('(d) no file under src/, or bin/ast, imports from test/ or harness/', () => {
  assert.ok(existsSync(SRC_DIR), 'src/ is missing');

  const files = readFilesAsRepoRelative(SRC_DIR);
  const astPath = path.join(BIN_DIR, 'ast');
  if (existsSync(astPath)) {
    files.push({ path: toRepoRelative(astPath), source: readFileSync(astPath, 'utf8') });
  }

  const violations = files.map(testOrHarnessImportViolation).filter(Boolean);
  assert.deepEqual(violations, []);
});

test('(d) control: an import from test/ or harness/ is caught; a clean import passes', () => {
  const testImporter = testOrHarnessImportViolation({
    path: 'src/core/thing.js',
    source: "import { helper } from '../../test/helper.js';\n",
  });
  assert.ok(testImporter, 'import from test/ was not flagged');

  const harnessImporter = testOrHarnessImportViolation({
    path: 'bin/ast',
    source: "import { walk } from '../harness/structural.mjs';\n",
  });
  assert.ok(harnessImporter, 'import from harness/ was not flagged');

  const clean = testOrHarnessImportViolation({
    path: 'src/core/thing.js',
    source: "import path from 'node:path';\n",
  });
  assert.equal(clean, null);
});

test('(e) ast-hook and src/hook/ cannot import a keypress path', () => {
  const astHookPath = path.join(BIN_DIR, 'ast-hook');
  const hookDir = path.join(SRC_DIR, 'hook');
  assert.ok(existsSync(astHookPath), 'bin/ast-hook is missing');
  assert.ok(existsSync(hookDir), 'src/hook/ is missing');

  const files = readFilesAsRepoRelative(hookDir);
  files.push({ path: toRepoRelative(astHookPath), source: readFileSync(astHookPath, 'utf8') });
  const violations = files.map(hookKeypressViolation).filter(Boolean);
  assert.deepEqual(violations, []);
});

test('(e) control: hook imports of tmuxexec and paneio are caught; clean and out-of-scope imports pass', () => {
  const tmuxexecOffender = hookKeypressViolation({
    path: 'src/hook/events/evil.js',
    source: "import { listPanes } from '../../io/tmuxexec.js';\n",
  });
  assert.ok(tmuxexecOffender, 'a hook path importing tmuxexec.js was not flagged');

  const paneioOffender = hookKeypressViolation({
    path: 'bin/ast-hook',
    source: "import { write } from '../src/io/paneio.js';\n",
  });
  assert.ok(paneioOffender, 'the hook binary importing paneio.js was not flagged');

  const clean = hookKeypressViolation({
    path: 'src/hook/index.js',
    source: "import path from 'node:path';\n",
  });
  assert.equal(clean, null);

  const outOfScope = hookKeypressViolation({
    path: 'src/io/allowed.js',
    source: "import { listPanes } from './tmuxexec.js';\n",
  });
  assert.equal(outOfScope, null);
});
