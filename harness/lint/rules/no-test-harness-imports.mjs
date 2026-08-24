import { extractImportSpecifiers, resolveRelativeSpecifier } from '../../structural.mjs';

const ID = 'no-test-harness-imports';

function lineOfSpecifier(source, specifier) {
  const index = source.indexOf(`'${specifier}'`);
  if (index !== -1) return source.slice(0, index).split('\n').length;
  const doubleQuoted = source.indexOf(`"${specifier}"`);
  if (doubleQuoted !== -1) return source.slice(0, doubleQuoted).split('\n').length;
  return 1;
}

function check(files) {
  const violations = [];
  for (const file of files) {
    for (const specifier of extractImportSpecifiers(file.source)) {
      if (!(specifier.startsWith('.') || specifier.startsWith('/'))) continue;
      const resolved = resolveRelativeSpecifier(file.file, specifier);
      if (resolved.startsWith('test/') || resolved.startsWith('harness/')) {
        violations.push({
          ruleId: ID,
          file: file.file,
          line: lineOfSpecifier(file.source, specifier),
          message: `imports "${specifier}" from test/ or harness/`,
        });
      }
    }
  }
  return violations;
}

export const noTestHarnessImports = Object.freeze({
  id: ID,
  description: 'Ban product code under src/, or bin/ast, from importing test/ or harness/.',
  paths: Object.freeze(['src', 'bin/ast']),
  check,
});
