import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { RULES } from '../harness/lint/index.mjs';
import { EXEMPT as WRITER_CHOKEPOINT_EXEMPT } from '../harness/lint/rules/writer-chokepoint.mjs';
import { walkFiles } from '../harness/structural.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_RULE_IDS = [
  'no-silent-catch',
  'verb-refusals-are-returned',
  'verb-export-contract',
  'no-console',
  'cli-subprocess-uses-node',
  'writer-chokepoint',
];

function toRepoRelative(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function filesFor(rule) {
  const files = new Set();
  for (const governedPath of rule.paths) {
    const absolute = path.join(ROOT, governedPath);
    assert.ok(existsSync(absolute), `${rule.id} governs missing path ${governedPath}`);
    if (statSync(absolute).isDirectory()) {
      for (const file of walkFiles(absolute)) files.add(file);
    } else {
      files.add(absolute);
    }
  }
  return [...files].map((file) => ({ file: toRepoRelative(file), source: readFileSync(file, 'utf8') }));
}

function ruleById(id) {
  const rule = RULES.find((candidate) => candidate.id === id);
  assert.ok(rule, `missing registered lint rule ${id}`);
  return rule;
}

function assertViolationShape(violation, ruleId) {
  assert.deepEqual(Object.keys(violation).sort(), ['file', 'line', 'message', 'ruleId']);
  assert.equal(violation.ruleId, ruleId);
  assert.equal(typeof violation.file, 'string');
  assert.ok(Number.isInteger(violation.line) && violation.line >= 1);
  assert.equal(typeof violation.message, 'string');
  assert.ok(violation.message.length > 0);
}

test('registry exposes exactly six named rules with unique stable ids', () => {
  assert.deepEqual(
    RULES.map((rule) => rule.id),
    EXPECTED_RULE_IDS,
  );
  assert.equal(new Set(RULES.map((rule) => rule.id)).size, RULES.length);

  for (const rule of RULES) {
    assert.ok(Object.isFrozen(rule), `${rule.id} is not frozen`);
    assert.match(rule.id, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    assert.equal(typeof rule.description, 'string');
    assert.ok(rule.description.length > 0, `${rule.id} has an empty description`);
    assert.ok(Array.isArray(rule.paths) && rule.paths.length > 0, `${rule.id} has no governed paths`);
    assert.ok(Object.isFrozen(rule.paths), `${rule.id} paths are not frozen`);
    assert.equal(typeof rule.check, 'function');
  }
});

test('every registered rule executes against the real tree with zero violations', () => {
  const executed = [];
  for (const rule of RULES) {
    const violations = rule.check(filesFor(rule));
    executed.push(rule.id);
    for (const violation of violations) assertViolationShape(violation, rule.id);
    assert.deepEqual(violations, [], `${rule.id} violations:\n${violations.map((item) => `${item.file}:${item.line}: ${item.message}`).join('\n')}`);
  }
  assert.deepEqual(executed, RULES.map((rule) => rule.id));
  assert.deepEqual(executed, EXPECTED_RULE_IDS);
});

test('control: no-silent-catch flags an empty swallow and passes an accounted fallback', () => {
  const rule = ruleById('no-silent-catch');
  const offender = rule.check([{ file: 'src/synthetic.js', source: 'try { work(); } catch {}\n' }]);
  assert.equal(offender.length, 1);
  assertViolationShape(offender[0], rule.id);

  const extraStatement = rule.check([
    { file: 'src/synthetic.js', source: 'try { work(); } catch { return null; ignored(); }\n' },
  ]);
  assert.equal(extraStatement.length, 1, 'a return plus another statement is not a single control-flow fallback');

  const semicolonlessExtra = rule.check([
    { file: 'src/synthetic.js', source: 'try { work(); } catch { return null\nignored(); }\n' },
  ]);
  assert.equal(semicolonlessExtra.length, 1, 'ASI must not hide a second statement after return');

  const nestedThrow = rule.check([
    { file: 'src/synthetic.js', source: 'try { work(); } catch { if (retry) throw failure; ignored(); }\n' },
  ]);
  assert.equal(nestedThrow.length, 1, 'a conditional nested throw does not account for every swallow path');

  const commentLookalike = rule.check([
    { file: 'src/synthetic.js', source: "try { work(); } catch { ignored('http://example'); }\n" },
  ]);
  assert.equal(commentLookalike.length, 1, 'comment markers inside strings are not explanatory comments');

  const interpolated = rule.check([
    {
      file: 'src/synthetic.js',
      source: "const text = `${(() => { try { work(); } catch {} })()}`;\n",
    },
  ]);
  assert.equal(interpolated.length, 1, 'executable template interpolations remain governed source');

  const regexBrace = rule.check([
    {
      file: 'src/synthetic.js',
      source: 'try { work(); } catch { ignored(/\\{/); }\nfunction later() { /* unrelated */ }\n',
    },
  ]);
  assert.equal(regexBrace.length, 1, 'a regex brace must not extend a catch body into a later comment');

  const postfixDivision = rule.check([
    {
      file: 'src/synthetic.js',
      source: 'try { work(); } catch { return count++ / total; ignored(); }\n',
    },
  ]);
  assert.equal(postfixDivision.length, 1, 'postfix division must not mask a second catch statement');

  const clean = rule.check([
    {
      file: 'src/synthetic.js',
      source: 'try { work(); } catch {\n  // absence is the documented fallback\n  return null;\n}\n',
    },
  ]);
  assert.deepEqual(clean, []);
});

test('control: verb-refusals-are-returned flags throw refusal and passes return refusal', () => {
  const rule = ruleById('verb-refusals-are-returned');
  const offender = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source: "export async function run(argv, ctx) {\n  throw refusal('no');\n}\n",
    },
  ]);
  assert.equal(offender.length, 1);
  assertViolationShape(offender[0], rule.id);

  const parenthesized = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source: "export async function run(argv, ctx) {\n  throw (refusal('no'));\n}\n",
    },
  ]);
  assert.equal(parenthesized.length, 1);

  const aliased = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source: "export async function run(argv, ctx) {\n  const denied = refusal('no');\n  throw denied;\n}\n",
    },
  ]);
  assert.equal(aliased.length, 1);

  const formatted = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source: "export async function run(argv, ctx) {\n  throw (\n    refusal('no')\n  );\n}\n",
    },
  ]);
  assert.equal(formatted.length, 1, 'formatting a direct thrown refusal across lines must not hide it');

  const awaited = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source: "export async function run(argv, ctx) {\n  throw await\n    refusal('no');\n}\n",
    },
  ]);
  assert.equal(awaited.length, 1, 'await formatting must not hide a directly thrown refusal');

  const parenthesizedAlias = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source:
        "export async function run(argv, ctx) {\n  const denied = (refusal('no'));\n  throw denied;\n}\n",
    },
  ]);
  assert.equal(parenthesizedAlias.length, 1, 'parentheses must not hide an aliased thrown refusal');

  const commaExpression = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source: "export async function run(argv, ctx) {\n  throw (0, refusal('no'));\n}\n",
    },
  ]);
  assert.equal(commaExpression.length, 1, 'a comma expression that yields a refusal remains a thrown refusal');

  const awaitedAlias = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source:
        "export async function run(argv, ctx) {\n  const denied = await refusal('no');\n  throw denied;\n}\n",
    },
  ]);
  assert.equal(awaitedAlias.length, 1, 'await must not hide an aliased thrown refusal');

  const unrelatedThrow = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source:
        "export async function run(argv, ctx) {\n  if (broken) throw new Error('broken');\n  return refusal('no');\n}\n",
    },
  ]);
  assert.deepEqual(unrelatedThrow, [], 'an unrelated throw must not taint a returned refusal');

  const clean = rule.check([
    {
      file: 'src/cli/verbs/synthetic.js',
      source:
        "function helper() { throw refusal('internal'); }\n" +
        "export async function run(argv, ctx) {\n  return refusal('no');\n}\n",
    },
  ]);
  assert.deepEqual(clean, []);
});

test('control: verb-export-contract checks module shape and hard-coded dispatches in both directions', () => {
  const rule = ruleById('verb-export-contract');
  const malformed = rule.check([
    {
      file: 'src/cli/verbs/bad.js',
      source: "export const summary = 'bad';\nexport async function run(argv, ctx) { return 0; }\n",
    },
  ]);
  assert.ok(malformed.some((violation) => violation.message.includes('mutating')));
  for (const violation of malformed) assertViolationShape(violation, rule.id);

  const emptySummary = rule.check([
    {
      file: 'src/cli/verbs/empty.js',
      source: "export const mutating = false;\nexport const summary = '';\nexport async function run(argv, ctx) { return 0; }\n",
    },
  ]);
  assert.ok(emptySummary.some((violation) => violation.message.includes('summary')));
  for (const violation of emptySummary) assertViolationShape(violation, rule.id);

  const commentedExports = rule.check([
    {
      file: 'src/cli/verbs/commented.js',
      source:
        "/*\nexport const mutating = false;\nexport const summary = 'comment only';\n" +
        'export async function run(argv, ctx) { return 0; }\n*/\n',
    },
  ]);
  assert.equal(commentedExports.length, 3, 'commented-out text cannot satisfy the runtime export surface');
  for (const violation of commentedExports) assertViolationShape(violation, rule.id);

  const templatedExports = rule.check([
    {
      file: 'src/cli/verbs/templated.js',
      source:
        "const prose = `\nexport const mutating = false;\nexport const summary = 'template only';\n" +
        'export async function run(argv, ctx) { return 0; }\n`;\n',
    },
  ]);
  assert.equal(templatedExports.length, 3, 'template text cannot satisfy the runtime export surface');
  for (const violation of templatedExports) assertViolationShape(violation, rule.id);

  const missing = rule.check([
    { file: 'bin/ast', source: "await loadVerb('missing', verbsDir);\n" },
    {
      file: 'src/cli/verbs/ok.js',
      source: "export const mutating = false;\nexport const summary = 'ok';\nexport async function run(argv, ctx) { return 0; }\n",
    },
  ]);
  assert.ok(missing.some((violation) => violation.message.includes('missing.js')));
  for (const violation of missing) assertViolationShape(violation, rule.id);

  const clean = rule.check([
    { file: 'bin/ast', source: "await loadVerb('ok', verbsDir);\n" },
    {
      file: 'src/cli/verbs/ok.js',
      source: "export const mutating = false;\nexport const summary = 'ok';\nexport async function run(argv, ctx) { return 0; }\n",
    },
  ]);
  assert.deepEqual(clean, []);
});

test('control: no-console flags console methods under src and passes an injected sink', () => {
  const rule = ruleById('no-console');
  const offender = rule.check([{ file: 'src/synthetic.js', source: "console.log('no');\n" }]);
  assert.equal(offender.length, 1);
  assertViolationShape(offender[0], rule.id);

  const multiline = rule.check([{ file: 'src/synthetic.js', source: "console\n  .error('no');\n" }]);
  assert.equal(multiline.length, 1);

  const bracket = rule.check([{ file: 'src/synthetic.js', source: "console['warn']('no');\n" }]);
  assert.equal(bracket.length, 1);

  const parenthesized = rule.check([{ file: 'src/synthetic.js', source: "(console).info('no');\n" }]);
  assert.equal(parenthesized.length, 1);

  const interpolated = rule.check([
    { file: 'src/synthetic.js', source: "const text = `${console.debug('no')}`;\n" },
  ]);
  assert.equal(interpolated.length, 1, 'executable template interpolations remain governed source');

  const postfixDivision = rule.check([
    {
      file: 'src/synthetic.js',
      source: "const ratio = count++ / total;\nconsole.log('no');\n",
    },
  ]);
  assert.equal(postfixDivision.length, 1, 'postfix division must not mask later console access');

  const clean = rule.check([
    { file: 'src/synthetic.js', source: "sink.write('console.log is documentation');\n" },
  ]);
  assert.deepEqual(clean, []);
});

test('control: cli-subprocess-uses-node flags the current runtime and passes resolved node', () => {
  const rule = ruleById('cli-subprocess-uses-node');
  const offender = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: "spawn(process.execPath, [AST_BIN, 'ls']);\n",
    },
  ]);
  assert.equal(offender.length, 1);
  assertViolationShape(offender[0], rule.id);

  const clean = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: "spawn(NODE, [AST_BIN, 'ls']);\n",
    },
  ]);
  assert.deepEqual(clean, []);
});

test('control: cli-subprocess-uses-node flags process argv zero only for a repository executable', () => {
  const rule = ruleById('cli-subprocess-uses-node');
  const offender = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: "execFile(process.argv[0], [HOOK_BIN, 'adapter', 'event']);\n",
    },
  ]);
  assert.equal(offender.length, 1);
  assertViolationShape(offender[0], rule.id);

  const clean = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: 'execFile(process.argv[0], [scriptPath]);\n',
    },
  ]);
  assert.deepEqual(clean, []);
});

test('control: cli-subprocess-uses-node follows immutable runtime aliases only to repository executables', () => {
  const rule = ruleById('cli-subprocess-uses-node');
  const offender = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: "const runtime = process.execPath;\nspawn(runtime, [AST_BIN, 'ls']);\n",
    },
  ]);
  assert.equal(offender.length, 1);
  assertViolationShape(offender[0], rule.id);

  const clean = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: 'const runtime = process.execPath;\nspawn(runtime, [scriptPath]);\n',
    },
  ]);
  assert.deepEqual(clean, []);
});

test('control: cli-subprocess-uses-node recognizes immutable aliases of rooted repository paths', () => {
  const rule = ruleById('cli-subprocess-uses-node');
  const offender = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: "const CLI = path.join(ROOT, 'bin', 'ast');\nexecFile(process.execPath, [CLI, 'ls']);\n",
    },
  ]);
  assert.equal(offender.length, 1);
  assertViolationShape(offender[0], rule.id);

  const clean = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: "const SCRIPT = path.join(ROOT, 'scripts', 'helper.mjs');\nexecFile(process.execPath, [SCRIPT]);\n",
    },
  ]);
  assert.deepEqual(clean, []);
});

test('control: cli-subprocess-uses-node recognizes rooted repository executable templates', () => {
  const rule = ruleById('cli-subprocess-uses-node');
  const offender = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: 'spawn(process.execPath, [`${ROOT}/bin/ast-hook`, adapter, event]);\n',
    },
  ]);
  assert.equal(offender.length, 1);
  assertViolationShape(offender[0], rule.id);

  const clean = rule.check([
    {
      file: 'test/synthetic.test.mjs',
      source: 'spawn(process.execPath, [`${ROOT}/scripts/helper.mjs`]);\n',
    },
  ]);
  assert.deepEqual(clean, []);
});

test('writer-chokepoint EXEMPT is pinned to exactly the three allowed writer files', () => {
  assert.deepEqual(WRITER_CHOKEPOINT_EXEMPT, ['src/capture/run.js', 'src/io/cfgedit.js', 'src/io/store.js']);
});

test('writer-chokepoint keeps src/io/cfgedit.js exempt regardless of whether it exists today', () => {
  assert.ok(
    WRITER_CHOKEPOINT_EXEMPT.includes('src/io/cfgedit.js'),
    'src/io/cfgedit.js must remain in EXEMPT even if absent',
  );
});

test('writer-chokepoint sweep visits bin/ast and src/io/procexec.js', () => {
  const rule = ruleById('writer-chokepoint');
  const scannedRel = filesFor(rule).map((file) => file.file);
  assert.ok(scannedRel.includes('bin/ast'), 'sweep did not visit bin/ast');
  assert.ok(scannedRel.includes('src/io/procexec.js'), 'sweep did not visit src/io/procexec.js');
});

test('control: writer-chokepoint flags a synthetic offender; the same source under src/io/store.js is exempt', () => {
  const rule = ruleById('writer-chokepoint');
  const offenderSource = "import { writeFile } from 'node:fs/promises';\n";

  const offense = rule.check([{ file: 'src/cli/verbs/evil.js', source: offenderSource }]);
  assert.equal(offense.length, 1, 'a writeFile import outside the exemption was not flagged');
  assertViolationShape(offense[0], rule.id);

  const exempted = rule.check([{ file: 'src/io/store.js', source: offenderSource }]);
  assert.deepEqual(exempted, [], 'src/io/store.js must be exempt regardless of its own content');
});

test('control: writer-chokepoint passes a read-only line and a read-mode open; flags a write flag open and a sync writer', () => {
  const rule = ruleById('writer-chokepoint');

  assert.deepEqual(
    rule.check([{ file: 'src/core/thing.js', source: 'const data = await readFile(p);\n' }]),
    [],
  );
  assert.deepEqual(
    rule.check([{ file: 'src/core/thing.js', source: "await open(p, 'r')\n" }]),
    [],
  );

  const writeFlagOpen = rule.check([{ file: 'src/core/thing.js', source: "openSync(p, 'wx')\n" }]);
  assert.equal(writeFlagOpen.length, 1);
  assertViolationShape(writeFlagOpen[0], rule.id);

  const syncWriter = rule.check([{ file: 'src/core/thing.js', source: 'fs.writeFileSync(p, s)\n' }]);
  assert.equal(syncWriter.length, 1);
  assertViolationShape(syncWriter[0], rule.id);
});
