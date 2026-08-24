import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './structural.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TYPE_COVERAGE_DIRS = Object.freeze(['bin', 'src', 'harness', 'test']);

const CHECKED_EXTENSIONS = Object.freeze(['.js', '.mjs']);

export function listTrackedTypeCheckableFiles(root = ROOT, dirs = TYPE_COVERAGE_DIRS) {
  const files = [];
  for (const dir of dirs) {
    for (const abs of walkFiles(path.join(root, dir))) {
      if (CHECKED_EXTENSIONS.includes(path.extname(abs))) {
        files.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  }
  return files.sort();
}

export function readTsconfigInclude(root = ROOT) {
  const tsconfig = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  if (!Array.isArray(tsconfig.include)) {
    throw new TypeError('type-coverage: tsconfig.json "include" must be an array');
  }
  return tsconfig.include;
}

// 141 of 150 tracked files are type-checked by tsconfig.json today; the other
// 9 are named below. Twenty-four have the current tsc error that keeps each
// one out -- either its own, or (for a file with no error of its own) the error
// of a file it imports transitively. The remaining entry, test/archive.test.mjs,
// type-checks clean but stays excluded in this round because a concurrent task
// owns it and inclusion was expressly prohibited. TypeScript checks every file
// reachable by import from an included root, so shrink the 24 error entries by
// fixing the named file's shape, not by editing its ledger reason.
export const TYPE_COVERAGE_LEDGER = Object.freeze([
  Object.freeze({ file: 'src/cli/verbs/probe.js', reason: 'does not type-check: src/cli/verbs/probe.js(63,50): error TS2353: Object literal may only specify known properties, and \'home\' does not exist in type \'{ fs?: typeof import("node:fs/promises"); }\'.' }),
  Object.freeze({ file: 'test/archive.test.mjs', reason: 'type-checks clean, but remains excluded from tsconfig.json in this round by concurrent-task ownership.' }),
  Object.freeze({ file: 'test/enums.test.mjs', reason: 'does not type-check: test/enums.test.mjs(26,34): error TS2345: Argument of type \'"now"\' is not assignable to parameter of type \'"high" | "low" | "normal"\'.' }),
  Object.freeze({ file: 'test/go.test.mjs', reason: 'does not type-check: test/go.test.mjs(135,47): error TS2339: Property \'join\' does not exist on type \'string | string[]\'.' }),
  Object.freeze({ file: 'test/ls.test.mjs', reason: 'does not type-check: test/ls.test.mjs(91,17): error TS2322: Type \'number\' is not assignable to type \'boolean\'.' }),
  Object.freeze({ file: 'test/notify.test.mjs', reason: 'does not type-check: test/notify.test.mjs(287,13): error TS2740: the runNotification request literal is missing exec, but declaring exec inside the literal is what the exec-ban lint rule forbids -- resolving this needs a decision about which guard yields, not an annotation' }),
  Object.freeze({ file: 'test/probe-static.test.mjs', reason: 'does not type-check: test/probe-static.test.mjs(74,50): error TS2353: Object literal may only specify known properties, and \'home\' does not exist in type \'{ fs?: typeof import("node:fs/promises"); }\'.' }),
  Object.freeze({ file: 'test/tmuxexec.test.mjs', reason: 'does not type-check: test/tmuxexec.test.mjs(325,53): error TS2322: Type \'string | (string | number)[]\' is not assignable to type \'string[]\'.' }),
  Object.freeze({ file: 'test/tmuxsock.test.mjs', reason: 'does not type-check: test/tmuxsock.test.mjs(44,25): error TS2352: Conversion of type \'() => string[]\' to type \'typeof readdirSync\' may be a mistake because neither type sufficiently overlaps with the other. Type \'string\' is not comparable to type \'NonSharedBuffer\'.' }),
]);

export function typeCoverageViolations({ trackedFiles, includeList, ledger }) {
  const violations = [];
  const includeSet = new Set(includeList);
  const trackedSet = new Set(trackedFiles);
  const ledgerByFile = new Map();

  for (const entry of ledger) {
    if (typeof entry.file !== 'string' || entry.file.length === 0) {
      violations.push('type coverage ledger entry has an empty file');
      continue;
    }
    if (ledgerByFile.has(entry.file)) {
      violations.push(`type coverage ledger has duplicate entry "${entry.file}"`);
    } else {
      ledgerByFile.set(entry.file, entry);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      violations.push(`type coverage ledger entry "${entry.file}" is missing a non-empty reason`);
    }
  }

  for (const file of includeList) {
    if (!trackedSet.has(file)) {
      violations.push(`tsconfig "include" lists "${file}" but it does not exist on disk`);
    }
  }
  for (const file of ledgerByFile.keys()) {
    if (!trackedSet.has(file)) {
      violations.push(`type coverage ledger lists "${file}" but it does not exist on disk`);
    }
  }

  for (const file of trackedFiles) {
    const inInclude = includeSet.has(file);
    const inLedger = ledgerByFile.has(file);
    if (inInclude && inLedger) {
      violations.push(`"${file}" is both tsconfig-included and ledger-excluded`);
    } else if (!inInclude && !inLedger) {
      violations.push(`"${file}" is neither tsconfig-included nor ledger-excluded`);
    }
  }

  return Object.freeze(violations);
}
