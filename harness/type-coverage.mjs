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

// 80 of 148 tracked files are type-checked by tsconfig.json today; the other
// 68 are named below with the tsc error that keeps each one out -- either its
// own, or (for a file with no error of its own) the error of a file it
// imports, transitively, that tsc still pulls into the program regardless of
// this file being left out of tsconfig's "include": TypeScript checks every
// file reachable by import from an included root, so a file can only be
// truly excluded if nothing included ever imports it. Shrink the 68 by fixing
// the named file's shape, not by editing this ledger.
export const TYPE_COVERAGE_LEDGER = Object.freeze([
  Object.freeze({ file: 'harness/gen-width.mjs', reason: 'does not type-check: harness/gen-width.mjs(43,39): error TS2339: Property \'ucdText\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'harness/lint/index.mjs', reason: 'transitively imports harness/lint/source.mjs, which does not type-check: harness/lint/source.mjs(116,21): error TS2739: Type \'{ type: string; }\' is missing the following properties from type \'{ type: string; templateExpression: boolean; braceDepth: number; }\': templateExpression, braceDepth' }),
  Object.freeze({ file: 'harness/lint/rules/cli-subprocess-uses-node.mjs', reason: 'transitively imports harness/lint/source.mjs, which does not type-check: harness/lint/source.mjs(116,21): error TS2739: Type \'{ type: string; }\' is missing the following properties from type \'{ type: string; templateExpression: boolean; braceDepth: number; }\': templateExpression, braceDepth' }),
  Object.freeze({ file: 'harness/lint/rules/no-console.mjs', reason: 'transitively imports harness/lint/source.mjs, which does not type-check: harness/lint/source.mjs(116,21): error TS2739: Type \'{ type: string; }\' is missing the following properties from type \'{ type: string; templateExpression: boolean; braceDepth: number; }\': templateExpression, braceDepth' }),
  Object.freeze({ file: 'harness/lint/rules/no-silent-catch.mjs', reason: 'transitively imports harness/lint/source.mjs, which does not type-check: harness/lint/source.mjs(116,21): error TS2739: Type \'{ type: string; }\' is missing the following properties from type \'{ type: string; templateExpression: boolean; braceDepth: number; }\': templateExpression, braceDepth' }),
  Object.freeze({ file: 'harness/lint/rules/verb-export-contract.mjs', reason: 'transitively imports harness/lint/source.mjs, which does not type-check: harness/lint/source.mjs(116,21): error TS2739: Type \'{ type: string; }\' is missing the following properties from type \'{ type: string; templateExpression: boolean; braceDepth: number; }\': templateExpression, braceDepth' }),
  Object.freeze({ file: 'harness/lint/rules/verb-refusals-are-returned.mjs', reason: 'transitively imports harness/lint/source.mjs, which does not type-check: harness/lint/source.mjs(116,21): error TS2739: Type \'{ type: string; }\' is missing the following properties from type \'{ type: string; templateExpression: boolean; braceDepth: number; }\': templateExpression, braceDepth' }),
  Object.freeze({ file: 'harness/lint/source.mjs', reason: 'does not type-check: harness/lint/source.mjs(116,21): error TS2739: Type \'{ type: string; }\' is missing the following properties from type \'{ type: string; templateExpression: boolean; braceDepth: number; }\': templateExpression, braceDepth' }),
  Object.freeze({ file: 'harness/mutants/run.mjs', reason: 'does not type-check: harness/mutants/run.mjs(73,32): error TS2339: Property \'repoRoot\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'src/adapters/claude/discover.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }), // quarantine-exempt
  Object.freeze({ file: 'src/adapters/claude/index.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }), // quarantine-exempt
  Object.freeze({ file: 'src/adapters/index.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/capture/run.js', reason: 'does not type-check: src/capture/run.js(14,40): error TS2345: Argument of type \'Readonly<{ cell: "claude/help"; provoke: "none"; source: "argv"; argv: readonly string[]; cliVersionArgv: readonly string[]; }> | Readonly<{ cell: "claude/agents-json/idle"; provoke: "at least one session in the idle state"; source: "argv"; argv: readonly string[]; cliVersionArgv: readonly string[]; }> | ... 13 more...\' is not assignable to parameter of type \'Readonly<{ cell: string; provoke: "none"; source: "tmux"; cliVersionArgv: readonly string[]; run: (context: any) => Promise<{ version?: undefined; ok: boolean; message: string; text?: undefined; command?: undefined; } | { ...; }>; }>\'.' }), // quarantine-exempt
  Object.freeze({ file: 'src/cli/pipeline.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/cli/verbs/archive.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/cli/verbs/bind.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/cli/verbs/doctor.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/cli/verbs/fixture.js', reason: 'transitively imports src/capture/run.js, which does not type-check: src/capture/run.js(14,40): error TS2345: Argument of type \'Readonly<{ cell: "claude/help"; provoke: "none"; source: "argv"; argv: readonly string[]; cliVersionArgv: readonly string[]; }> | Readonly<{ cell: "claude/agents-json/idle"; provoke: "at least one session in the idle state"; source: "argv"; argv: readonly string[]; cliVersionArgv: readonly string[]; }> | ... 13 more...\' is not assignable to parameter of type \'Readonly<{ cell: string; provoke: "none"; source: "tmux"; cliVersionArgv: readonly string[]; run: (context: any) => Promise<{ version?: undefined; ok: boolean; message: string; text?: undefined; command?: undefined; } | { ...; }>; }>\'.' }), // quarantine-exempt
  Object.freeze({ file: 'src/cli/verbs/go.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/cli/verbs/ls.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/cli/verbs/name.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/cli/verbs/new.js', reason: 'does not type-check: src/cli/verbs/new.js(104,5): error TS2353: Object literal may only specify known properties, and \'cwd\' does not exist in type \'{ command?: any[]; detached?: boolean; }\'.' }),
  Object.freeze({ file: 'src/cli/verbs/park.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/cli/verbs/probe.js', reason: 'does not type-check: src/cli/verbs/probe.js(63,50): error TS2353: Object literal may only specify known properties, and \'home\' does not exist in type \'{ fs?: typeof import("node:fs/promises"); }\'.' }),
  Object.freeze({ file: 'src/cli/verbs/snapshot.js', reason: 'does not type-check: src/cli/verbs/snapshot.js(70,38): error TS2339: Property \'writeLayout\' does not exist on type \'Readonly<{ stateDir: string; configDir: string; writeSession(ulid: any, record: any): Promise<void>; archiveSession(ulid: string, record: any, { beforeRemove }?: { beforeRemove?: (archivePath: string) => Promise<void>; }): Promise<...>; ... 10 more ...; ensureConfig(): Promise<...>; }> | { ...; }\'.' }),
  Object.freeze({ file: 'src/cli/verbs/unpark.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/core/reconcile.js', reason: 'does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/core/render.js', reason: 'does not type-check: src/core/render.js(20,36): error TS2339: Property \'maxWidth\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'src/doctor/index.js', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'src/hook/events/notification.js', reason: 'transitively imports src/core/render.js, which does not type-check: src/core/render.js(20,36): error TS2339: Property \'maxWidth\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'src/hook/index.js', reason: 'transitively imports src/core/render.js, which does not type-check: src/core/render.js(20,36): error TS2339: Property \'maxWidth\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'src/io/notify.js', reason: 'transitively imports src/core/render.js, which does not type-check: src/core/render.js(20,36): error TS2339: Property \'maxWidth\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'src/probe/static.js', reason: 'does not type-check: src/probe/static.js(53,47): error TS2339: Property \'home\' does not exist on type \'{ fs?: typeof import("node:fs/promises"); }\'.' }),
  Object.freeze({ file: 'test/adapter-conformance.test.mjs', reason: 'does not type-check: test/adapter-conformance.test.mjs(39,29): error TS2345: Argument of type \'"fake"\' is not assignable to parameter of type \'"claude"\'.' }), // quarantine-exempt
  Object.freeze({ file: 'test/adapter-registry.test.mjs', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'test/archive.test.mjs', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'test/ast-hook.test.mjs', reason: 'does not type-check: test/ast-hook.test.mjs(14,52): error TS2367: This comparison appears to be unintentional because the types \'"claude"\' and \'"fake"\' have no overlap.' }), // quarantine-exempt
  Object.freeze({ file: 'test/bind.test.mjs', reason: 'does not type-check: test/bind.test.mjs(3,53): error TS6133: \'readdir\' is declared but its value is never read.' }),
  Object.freeze({ file: 'test/capability-ledger.test.mjs', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'test/cli.test.mjs', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'test/commit-format.test.mjs', reason: 'does not type-check: test/commit-format.test.mjs(2,19): error TS6133: \'readFile\' is declared but its value is never read.' }),
  Object.freeze({ file: 'test/discover-golden.test.mjs', reason: 'does not type-check: test/discover-golden.test.mjs(17,52): error TS2367: This comparison appears to be unintentional because the types \'"claude"\' and \'"fake"\' have no overlap.' }), // quarantine-exempt
  Object.freeze({ file: 'test/discover.test.mjs', reason: 'does not type-check: test/discover.test.mjs(13,52): error TS2367: This comparison appears to be unintentional because the types \'"claude"\' and \'"fake"\' have no overlap.' }), // quarantine-exempt
  Object.freeze({ file: 'test/doctor.test.mjs', reason: 'does not type-check: test/doctor.test.mjs(92,38): error TS2769: No overload matches this call.' }),
  Object.freeze({ file: 'test/enums.test.mjs', reason: 'does not type-check: test/enums.test.mjs(26,34): error TS2345: Argument of type \'"now"\' is not assignable to parameter of type \'"high" | "low" | "normal"\'.' }),
  Object.freeze({ file: 'test/fixture-capture.test.mjs', reason: 'does not type-check: test/fixture-capture.test.mjs(77,40): error TS2345: Argument of type \'Readonly<{ cell: "claude/help"; provoke: "none"; source: "argv"; argv: readonly string[]; cliVersionArgv: readonly string[]; }> | Readonly<{ cell: "claude/agents-json/idle"; provoke: "at least one session in the idle state"; source: "argv"; argv: readonly string[]; cliVersionArgv: readonly string[]; }> | ... 13 more...\' is not assignable to parameter of type \'Readonly<{ cell: string; provoke: "none"; source: "tmux"; cliVersionArgv: readonly string[]; run: (context: any) => Promise<{ version?: undefined; ok: boolean; message: string; text?: undefined; command?: undefined; } | { ...; }>; }>\'.' }), // quarantine-exempt
  Object.freeze({ file: 'test/go.test.mjs', reason: 'does not type-check: test/go.test.mjs(135,47): error TS2339: Property \'join\' does not exist on type \'string | string[]\'.' }),
  Object.freeze({ file: 'test/init-uninstall.test.mjs', reason: 'does not type-check: test/init-uninstall.test.mjs(219,31): error TS2339: Property \'profileFile\' does not exist on type \'Readonly<{ id: "fake"; discover: ({ env }: { env: any; }) => Promise<readonly any[]>; resumeArgv: ({ sessionId }: { sessionId: any; }) => readonly any[]; spawnArgv: ({ sessionId }: { sessionId: any; }) => readonly any[]; captures: readonly any[]; measuredOn: Readonly<{ ...; }>; ... 5 more ...; staticProbe: Readonly<...\'.' }),
  Object.freeze({ file: 'test/lint.test.mjs', reason: 'transitively imports harness/lint/source.mjs, which does not type-check: harness/lint/source.mjs(116,21): error TS2739: Type \'{ type: string; }\' is missing the following properties from type \'{ type: string; templateExpression: boolean; braceDepth: number; }\': templateExpression, braceDepth' }),
  Object.freeze({ file: 'test/ls-golden.test.mjs', reason: 'does not type-check: test/ls-golden.test.mjs(18,88): error TS2367: This comparison appears to be unintentional because the types \'"claude"\' and \'"fake"\' have no overlap.' }), // quarantine-exempt
  Object.freeze({ file: 'test/ls.test.mjs', reason: 'does not type-check: test/ls.test.mjs(89,17): error TS2322: Type \'number\' is not assignable to type \'boolean\'.' }),
  Object.freeze({ file: 'test/manifest-captures.test.mjs', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'test/manifest.test.mjs', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'test/mutants.test.mjs', reason: 'transitively imports harness/mutants/run.mjs, which does not type-check: harness/mutants/run.mjs(73,32): error TS2339: Property \'repoRoot\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'test/name.test.mjs', reason: 'does not type-check: test/name.test.mjs(44,44): error TS2339: Property \'now\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'test/notify.test.mjs', reason: 'does not type-check: test/notify.test.mjs(19,52): error TS2367: This comparison appears to be unintentional because the types \'"claude"\' and \'"fake"\' have no overlap.' }), // quarantine-exempt
  Object.freeze({ file: 'test/park.test.mjs', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'test/pipeline.test.mjs', reason: 'does not type-check: test/pipeline.test.mjs(57,39): error TS2741: Property \'home\' is missing in type \'{ tmp: string; root: string; env: { ASTERISM_FAKE_ROOT: string; HOME: string; XDG_STATE_HOME: string; }; store: Readonly<{ stateDir: string; configDir: string; writeSession(ulid: any, record: any): Promise<...>; ... 11 more ...; ensureConfig(): Promise<...>; }>; adapters: Map<...>; }\' but required in type \'{ env: any; adapters: any; home: any; store: any; now?: number; execute?: (argv: any, options?: {}) => Promise<any>; mint?: () => string; persist?: boolean; }\'.' }),
  Object.freeze({ file: 'test/probe-static.test.mjs', reason: 'does not type-check: test/probe-static.test.mjs(74,50): error TS2353: Object literal may only specify known properties, and \'home\' does not exist in type \'{ fs?: typeof import("node:fs/promises"); }\'.' }),
  Object.freeze({ file: 'test/reconcile.test.mjs', reason: 'does not type-check: test/reconcile.test.mjs(321,40): error TS2739: Type \'{}\' is missing the following properties from type \'{ now: any; random: any; }\': now, random' }),
  Object.freeze({ file: 'test/refuse-rules.test.mjs', reason: 'transitively imports src/core/reconcile.js, which does not type-check: src/core/reconcile.js(301,32): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'"bridgeSessionId" | "cwd" | "entrypoint" | "kind" | "messagingSocketPath" | "name" | "nameSince" | "nameSource" | "peerFeatures" | "peerProtocol" | "pid" | "procStart" | "sessionId" | ... 6 more ... | "waitingFor"\'.' }),
  Object.freeze({ file: 'test/render.test.mjs', reason: 'transitively imports src/core/render.js, which does not type-check: src/core/render.js(20,36): error TS2339: Property \'maxWidth\' does not exist on type \'{}\'.' }),
  Object.freeze({ file: 'test/store.test.mjs', reason: 'does not type-check: test/store.test.mjs(3,10): error TS6133: \'existsSync\' is declared but its value is never read.' }),
  Object.freeze({ file: 'test/tmux-l3.test.mjs', reason: 'does not type-check: test/tmux-l3.test.mjs(479,38): error TS2353: Object literal may only specify known properties, and \'cwd\' does not exist in type \'{ command?: any[]; detached?: boolean; }\'.' }),
  Object.freeze({ file: 'test/tmuxexec.test.mjs', reason: 'does not type-check: test/tmuxexec.test.mjs(245,53): error TS2322: Type \'string | (string | number)[]\' is not assignable to type \'string[]\'.' }),
  Object.freeze({ file: 'test/tmuxsock.test.mjs', reason: 'does not type-check: test/tmuxsock.test.mjs(24,5): error TS2741: Property \'native\' is missing in type \'(candidate: any) => any\' but required in type \'typeof realpathSync\'.' }),
  Object.freeze({ file: 'test/uuid.test.mjs', reason: 'does not type-check: test/uuid.test.mjs(35,40): error TS2741: Property \'random\' is missing in type \'{}\' but required in type \'{ random: any; }\'.' }),
  Object.freeze({ file: 'test/width.test.mjs', reason: 'transitively imports harness/gen-width.mjs, which does not type-check: harness/gen-width.mjs(43,39): error TS2339: Property \'ucdText\' does not exist on type \'{}\'.' }),
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
