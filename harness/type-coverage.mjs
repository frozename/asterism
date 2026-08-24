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

// 123 of 148 tracked files are type-checked by tsconfig.json today; the other
// 25 are named below. Twenty-four have the current tsc error that keeps each
// one out -- either its own, or (for a file with no error of its own) the error
// of a file it imports transitively. The remaining entry, test/archive.test.mjs,
// type-checks clean but stays excluded in this round because a concurrent task
// owns it and inclusion was expressly prohibited. TypeScript checks every file
// reachable by import from an included root, so shrink the 24 error entries by
// fixing the named file's shape, not by editing its ledger reason.
export const TYPE_COVERAGE_LEDGER = Object.freeze([
  Object.freeze({ file: 'src/cli/verbs/probe.js', reason: 'does not type-check: src/cli/verbs/probe.js(63,50): error TS2353: Object literal may only specify known properties, and \'home\' does not exist in type \'{ fs?: typeof import("node:fs/promises"); }\'.' }),
  Object.freeze({ file: 'src/cli/verbs/snapshot.js', reason: 'does not type-check: src/cli/verbs/snapshot.js(70,38): error TS2339: Property \'writeLayout\' does not exist on type \'Readonly<{ stateDir: string; configDir: string; writeSession(ulid: any, record: any): Promise<void>; archiveSession(ulid: string, record: any, { beforeRemove }?: { beforeRemove?: (archivePath: string) => Promise<void>; }): Promise<...>; ... 10 more ...; ensureConfig(): Promise<...>; }> | { ...; }\'.' }),
  Object.freeze({ file: 'src/probe/static.js', reason: 'does not type-check: src/probe/static.js(53,47): error TS2339: Property \'home\' does not exist on type \'{ fs?: typeof import("node:fs/promises"); }\'.' }),
  Object.freeze({ file: 'test/adapter-conformance.test.mjs', reason: 'does not type-check: test/adapter-conformance.test.mjs(285,61): error TS2339: Property \'installPlan\' does not exist on type \'Readonly<{ discoverArgv: () => readonly string[]; registryDir: (home: any) => string; registryFilePattern: RegExp; ENRICHMENT: Readonly<{ flag: "registryEnrichment"; requiredPeerProtocol: 1; maxFileBytes: 262144; provSource: "registry-file"; }>; ... 16 more ...; staticProbe: Readonly<...>; }> | Readonly<...>\'.' }), // quarantine-exempt
  Object.freeze({ file: 'test/archive.test.mjs', reason: 'type-checks clean, but remains excluded from tsconfig.json in this round by concurrent-task ownership.' }),
  Object.freeze({ file: 'test/ast-hook.test.mjs', reason: 'does not type-check: test/ast-hook.test.mjs(118,15): error TS2339: Property \'hooks\' does not exist on type \'Readonly<{ discoverArgv: () => readonly string[]; registryDir: (home: any) => string; registryFilePattern: RegExp; ENRICHMENT: Readonly<{ flag: "registryEnrichment"; requiredPeerProtocol: 1; maxFileBytes: 262144; provSource: "registry-file"; }>; ... 16 more ...; staticProbe: Readonly<...>; }> | Readonly<...>\'.' }), // quarantine-exempt
  Object.freeze({ file: 'test/bind.test.mjs', reason: 'does not type-check: test/bind.test.mjs(3,53): error TS6133: \'readdir\' is declared but its value is never read.' }),
  Object.freeze({ file: 'test/commit-format.test.mjs', reason: 'does not type-check: test/commit-format.test.mjs(2,19): error TS6133: \'readFile\' is declared but its value is never read.' }),
  Object.freeze({ file: 'test/discover-golden.test.mjs', reason: 'does not type-check: test/discover-golden.test.mjs(78,25): error TS2339: Property \'parseAgentsJson\' does not exist on type \'Readonly<{ discoverArgv: () => readonly string[]; registryDir: (home: any) => string; registryFilePattern: RegExp; ENRICHMENT: Readonly<{ flag: "registryEnrichment"; requiredPeerProtocol: 1; maxFileBytes: 262144; provSource: "registry-file"; }>; ... 16 more ...; staticProbe: Readonly<...>; }> | Readonly<...>\'.' }), // quarantine-exempt
  Object.freeze({ file: 'test/discover.test.mjs', reason: 'does not type-check: test/discover.test.mjs(39,22): error TS2339: Property \'registryDir\' does not exist on type \'Readonly<{ discoverArgv: () => readonly string[]; registryDir: (home: any) => string; registryFilePattern: RegExp; ENRICHMENT: Readonly<{ flag: "registryEnrichment"; requiredPeerProtocol: 1; maxFileBytes: 262144; provSource: "registry-file"; }>; ... 16 more ...; staticProbe: Readonly<...>; }> | Readonly<...>\'.' }), // quarantine-exempt
  Object.freeze({ file: 'test/doctor.test.mjs', reason: 'does not type-check: test/doctor.test.mjs(93,38): error TS2769: No overload matches this call.' }),
  Object.freeze({ file: 'test/enums.test.mjs', reason: 'does not type-check: test/enums.test.mjs(26,34): error TS2345: Argument of type \'"now"\' is not assignable to parameter of type \'"high" | "low" | "normal"\'.' }),
  Object.freeze({ file: 'test/go.test.mjs', reason: 'does not type-check: test/go.test.mjs(135,47): error TS2339: Property \'join\' does not exist on type \'string | string[]\'.' }),
  Object.freeze({ file: 'test/init-uninstall.test.mjs', reason: 'does not type-check: test/init-uninstall.test.mjs(219,31): error TS2339: Property \'profileFile\' does not exist on type \'Readonly<{ discoverArgv: () => readonly string[]; registryDir: (home: any) => string; registryFilePattern: RegExp; ENRICHMENT: Readonly<{ flag: "registryEnrichment"; requiredPeerProtocol: 1; maxFileBytes: 262144; provSource: "registry-file"; }>; ... 16 more ...; staticProbe: Readonly<...>; }> | Readonly<...>\'.' }),
  Object.freeze({ file: 'test/ls-golden.test.mjs', reason: 'does not type-check: test/ls-golden.test.mjs(22,22): error TS2339: Property \'goldenCells\' does not exist on type \'Readonly<{ discoverArgv: () => readonly string[]; registryDir: (home: any) => string; registryFilePattern: RegExp; ENRICHMENT: Readonly<{ flag: "registryEnrichment"; requiredPeerProtocol: 1; maxFileBytes: 262144; provSource: "registry-file"; }>; ... 16 more ...; staticProbe: Readonly<...>; }> | Readonly<...>\'.' }), // quarantine-exempt
  Object.freeze({ file: 'test/ls.test.mjs', reason: 'does not type-check: test/ls.test.mjs(91,17): error TS2322: Type \'number\' is not assignable to type \'boolean\'.' }),
  Object.freeze({ file: 'test/name.test.mjs', reason: 'does not type-check: test/name.test.mjs(44,44): error TS2339: Property \'now\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'test/notify.test.mjs', reason: 'does not type-check: test/notify.test.mjs(190,26): error TS2339: Property \'hooks\' does not exist on type \'Readonly<{ discoverArgv: () => readonly string[]; registryDir: (home: any) => string; registryFilePattern: RegExp; ENRICHMENT: Readonly<{ flag: "registryEnrichment"; requiredPeerProtocol: 1; maxFileBytes: 262144; provSource: "registry-file"; }>; ... 16 more ...; staticProbe: Readonly<...>; }> | Readonly<...>\'.' }), // quarantine-exempt
  Object.freeze({ file: 'test/pipeline.test.mjs', reason: 'does not type-check: test/pipeline.test.mjs(57,39): error TS2741: Property \'home\' is missing in type \'{ tmp: string; root: string; env: { ASTERISM_FAKE_ROOT: string; HOME: string; XDG_STATE_HOME: string; }; store: Readonly<{ stateDir: string; configDir: string; writeSession(ulid: any, record: any): Promise<...>; ... 11 more ...; ensureConfig(): Promise<...>; }>; adapters: Map<...>; }\' but required in type \'{ env: any; adapters: any; home: any; store: any; now?: number; execute?: (argv: any, options?: {}) => Promise<any>; mint?: () => string; persist?: boolean; }\'.' }),
  Object.freeze({ file: 'test/probe-static.test.mjs', reason: 'does not type-check: test/probe-static.test.mjs(74,50): error TS2353: Object literal may only specify known properties, and \'home\' does not exist in type \'{ fs?: typeof import("node:fs/promises"); }\'.' }),
  Object.freeze({ file: 'test/reconcile.test.mjs', reason: 'does not type-check: test/reconcile.test.mjs(332,40): error TS2739: Type \'{}\' is missing the following properties from type \'{ now: any; random: any; }\': now, random' }),
  Object.freeze({ file: 'test/store.test.mjs', reason: 'does not type-check: test/store.test.mjs(7,10): error TS6133: \'fileURLToPath\' is declared but its value is never read.' }),
  Object.freeze({ file: 'test/tmuxexec.test.mjs', reason: 'does not type-check: test/tmuxexec.test.mjs(325,53): error TS2322: Type \'string | (string | number)[]\' is not assignable to type \'string[]\'.' }),
  Object.freeze({ file: 'test/tmuxsock.test.mjs', reason: 'does not type-check: test/tmuxsock.test.mjs(24,5): error TS2741: Property \'native\' is missing in type \'(candidate: any) => any\' but required in type \'typeof realpathSync\'.' }),
  Object.freeze({ file: 'test/uuid.test.mjs', reason: 'does not type-check: test/uuid.test.mjs(35,40): error TS2741: Property \'random\' is missing in type \'{}\' but required in type \'{ random: any; }\'.' }),
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
