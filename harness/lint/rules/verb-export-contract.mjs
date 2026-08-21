import { codeOnly, lineAt } from '../source.mjs';

const ID = 'verb-export-contract';
const VERB_MODULE = /^src\/cli\/verbs\/([^/]+)\.js$/;
const MUTATING_EXPORT = /^export const mutating = (?:true|false);$/m;
const SUMMARY_PREFIX = /^export const summary = /m;
const SUMMARY_EXPORT = /^export const summary = '(?:\\.|[^'\\\r\n])+';$/;
const RUN_EXPORT = /^export async function run\(\s*[^,()\s]+\s*,\s*[^,()\s]+\s*\)\s*\{/m;
const LITERAL_DISPATCH = /\bloadVerb\(\s*['"]([a-z][a-z0-9-]*)['"]/g;

function violation(file, line, message) {
  return { ruleId: ID, file, line, message };
}

function check(files) {
  const violations = [];
  const moduleNames = new Set();

  for (const file of files) {
    const moduleMatch = file.file.match(VERB_MODULE);
    if (moduleMatch === null) continue;
    moduleNames.add(moduleMatch[1]);
    const masked = codeOnly(file.source);

    if (!MUTATING_EXPORT.test(masked)) {
      violations.push(violation(file.file, 1, 'verb must export mutating as a boolean literal'));
    }
    const summaryMatch = SUMMARY_PREFIX.exec(masked);
    const summaryEnd = summaryMatch === null ? -1 : file.source.indexOf('\n', summaryMatch.index);
    const summaryLine = summaryMatch === null
      ? ''
      : file.source.slice(summaryMatch.index, summaryEnd === -1 ? file.source.length : summaryEnd);
    if (!SUMMARY_EXPORT.test(summaryLine)) {
      violations.push(violation(file.file, 1, 'verb must export summary as a non-empty one-line string'));
    }
    if (!RUN_EXPORT.test(masked)) {
      violations.push(violation(file.file, 1, 'verb must export async function run(argv, ctx) with two parameters'));
    }
  }

  for (const file of files) {
    if (VERB_MODULE.test(file.file)) continue;
    const masked = codeOnly(file.source);
    for (const match of file.source.matchAll(LITERAL_DISPATCH)) {
      if (masked.slice(match.index, match.index + 'loadVerb'.length) !== 'loadVerb') continue;
      if (moduleNames.has(match[1])) continue;
      violations.push(
        violation(file.file, lineAt(file.source, match.index), `router dispatch names missing verb module ${match[1]}.js`),
      );
    }
  }

  return violations;
}

export const verbExportContract = Object.freeze({
  id: ID,
  description: 'Pin every verb export shape and every literal router dispatch target.',
  paths: Object.freeze(['bin/ast', 'src/cli/router.js', 'src/cli/verbs']),
  check,
});
