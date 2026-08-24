import { extractImportSpecifiers } from '../../structural.mjs';

const ID = 'child-process-chokepoint';

export const CHILD_PROCESS_SPECIFIERS = Object.freeze(['child_process', 'node:child_process']);
export const ALLOWED_CHILD_PROCESS_IMPORTERS = Object.freeze(['src/io/procexec.js', 'src/io/tmuxexec.js']);

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
    if (ALLOWED_CHILD_PROCESS_IMPORTERS.includes(file.file)) continue;

    for (const specifier of extractImportSpecifiers(file.source)) {
      if (!CHILD_PROCESS_SPECIFIERS.includes(specifier)) continue;
      violations.push({
        ruleId: ID,
        file: file.file,
        line: lineOfSpecifier(file.source, specifier),
        message: `imports child_process outside the exec chokepoints (via "${specifier}")`,
      });
    }
  }
  return violations;
}

export const childProcessChokepoint = Object.freeze({
  id: ID,
  description:
    'Ban importing child_process (or node:child_process) under bin/ or src/ outside the two declared exec chokepoints.',
  paths: Object.freeze(['bin', 'src']),
  check,
});
