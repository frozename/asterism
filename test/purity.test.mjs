import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { extractImportSpecifiers, filesWithExtensions, resolveRelativeSpecifier } from '../harness/structural.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = path.join(ROOT, 'src', 'core');

const BANNED_BUILTINS = [
  'child_process',
  'fs',
  'fs/promises',
  'net',
  'os',
  'http',
  'https',
  'http2',
  'dgram',
  'dns',
  'tls',
  'cluster',
  'worker_threads',
  'process',
];

function purityViolations(filePath, source, coreDir) {
  const violations = [];

  if (source.includes('process.env')) {
    violations.push(`${filePath}: contains process.env`);
  }

  for (const specifier of extractImportSpecifiers(source)) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const resolved = resolveRelativeSpecifier(filePath, specifier);
      if (!isInside(coreDir, resolved)) {
        violations.push(`${filePath}: relative import "${specifier}" escapes src/core/`);
      }
      continue;
    }

    const bareName = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
    if (BANNED_BUILTINS.includes(bareName)) {
      violations.push(`${filePath}: banned import "${specifier}"`);
    } else if (!specifier.startsWith('node:')) {
      violations.push(`${filePath}: bare package specifier "${specifier}"`);
    }
  }

  return violations;
}

function isInside(dir, candidate) {
  const normalizedDir = dir.split(path.sep).join('/');
  return candidate === normalizedDir || candidate.startsWith(`${normalizedDir}/`);
}

test('src/core/ holds files and every one of them is pure', () => {
  assert.ok(existsSync(CORE_DIR), 'src/core/ is missing; purity cannot be checked');

  const files = filesWithExtensions(CORE_DIR, ['.js']);
  assert.ok(files.length > 0, 'src/core/ holds zero .js files; purity cannot be checked');

  const violations = files.flatMap((file) => purityViolations(file, readFileSync(file, 'utf8'), CORE_DIR));
  assert.deepEqual(violations, [], `src/core/ purity violations:\n${violations.join('\n')}`);
});

test('control: a node:fs import and process.env are caught; a clean in-core import passes', () => {
  const offendingFs = purityViolations(
    path.join(CORE_DIR, 'synthetic-offender.js'),
    "import { readFileSync } from 'node:fs';\n",
    CORE_DIR,
  );
  assert.ok(offendingFs.length > 0, 'checker did not flag a node:fs import');

  const offendingEnv = purityViolations(
    path.join(CORE_DIR, 'synthetic-offender.js'),
    "export function f() { return process.env.HOME; }\n",
    CORE_DIR,
  );
  assert.ok(offendingEnv.length > 0, 'checker did not flag process.env');

  const offendingBare = purityViolations(
    path.join(CORE_DIR, 'synthetic-offender.js'),
    "import leftPad from 'left-pad';\n",
    CORE_DIR,
  );
  assert.ok(offendingBare.length > 0, 'checker did not flag a bare package specifier');

  const offendingEscape = purityViolations(
    path.join(CORE_DIR, 'synthetic-offender.js'),
    "import { helper } from '../io/helper.js';\n",
    CORE_DIR,
  );
  assert.ok(offendingEscape.length > 0, 'checker did not flag a relative import escaping src/core/');

  const clean = purityViolations(
    path.join(CORE_DIR, 'synthetic-clean.js'),
    "import { a } from './b.js';\nimport path from 'node:path';\n",
    CORE_DIR,
  );
  assert.deepEqual(clean, []);
});
