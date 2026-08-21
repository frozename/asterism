import { codeOnly, lineAt } from '../source.mjs';

const ID = 'cli-subprocess-uses-node';
const CURRENT_RUNTIME_LAUNCH =
  /\b(?:execFile(?:Async|Sync)?|spawn(?:Sync)?)\s*\(\s*process\s*\.\s*execPath\s*,\s*\[\s*(?:AST_BIN|HOOK_BIN)\b/g;

function check(files) {
  const violations = [];
  for (const file of files) {
    if (!file.file.startsWith('test/')) continue;

    const masked = codeOnly(file.source);
    for (const match of masked.matchAll(CURRENT_RUNTIME_LAUNCH)) {
      violations.push({
        ruleId: ID,
        file: file.file,
        line: lineAt(file.source, match.index),
        message: 'launch repository executables with the node-resolving NODE constant',
      });
    }
  }
  return violations;
}

export const cliSubprocessUsesNode = Object.freeze({
  id: ID,
  description: 'Require repository executable subprocesses in tests to use resolved Node.',
  paths: Object.freeze(['test']),
  check,
});
