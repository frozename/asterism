import { closingBrace, codeOnly, lineAt } from '../source.mjs';

const ID = 'verb-refusals-are-returned';
const RUN_START = /\bexport\s+async\s+function\s+run\s*\([^)]*\)\s*\{/;
const THROW_REFUSAL = /\bthrow[ \t]+[^;]*?\brefusal\s*\(/g;
const REFUSAL_ALIAS = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*?\brefusal\s*\(/g;

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function refusalViolation(file, index) {
  return {
    ruleId: ID,
    file: file.file,
    line: lineAt(file.source, index),
    message: 'run() must return refusal(...) instead of throwing it',
  };
}

function check(files) {
  const violations = [];
  for (const file of files) {
    if (!/^src\/cli\/verbs\/[^/]+\.js$/.test(file.file)) continue;

    const masked = codeOnly(file.source);
    const runMatch = RUN_START.exec(masked);
    if (runMatch === null) continue;

    const openIndex = runMatch.index + runMatch[0].lastIndexOf('{');
    const closeIndex = closingBrace(masked, openIndex);
    const runBody = masked.slice(openIndex + 1, closeIndex);
    for (const match of runBody.matchAll(THROW_REFUSAL)) {
      violations.push(refusalViolation(file, openIndex + 1 + match.index));
    }

    for (const alias of runBody.matchAll(REFUSAL_ALIAS)) {
      const thrownAlias = new RegExp(
        `\\bthrow[ \\t]+(?:(?:\\(\\s*)|(?:await\\s+))*${escapedPattern(alias[1])}(?:\\s*\\))*\\s*;?`,
        'g',
      );
      for (const match of runBody.matchAll(thrownAlias)) {
        violations.push(refusalViolation(file, openIndex + 1 + match.index));
      }
    }
  }
  return violations;
}

export const verbRefusalsAreReturned = Object.freeze({
  id: ID,
  description: 'Require CLI verbs to return shaped refusals rather than throw them.',
  paths: Object.freeze(['src/cli/verbs']),
  check,
});
