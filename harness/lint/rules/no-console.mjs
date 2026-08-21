import { codeOnly, lineAt } from '../source.mjs';

const ID = 'no-console';
const CONSOLE_METHOD = /\bconsole\s*(?:\)\s*)*(?:\?\.|\.|\[)/g;

function check(files) {
  const violations = [];
  for (const file of files) {
    if (!file.file.startsWith('src/')) continue;

    const masked = codeOnly(file.source);
    for (const match of masked.matchAll(CONSOLE_METHOD)) {
      violations.push({
        ruleId: ID,
        file: file.file,
        line: lineAt(file.source, match.index),
        message: 'write through process streams or an injected sink instead of console.*',
      });
    }
  }
  return violations;
}

export const noConsole = Object.freeze({
  id: ID,
  description: 'Ban console method calls from product source.',
  paths: Object.freeze(['src']),
  check,
});
