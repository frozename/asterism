import { extractImportSpecifiers } from '../../structural.mjs';

const ID = 'hook-keypress-ban';

function lineOfSpecifier(source, specifier) {
  const index = source.indexOf(`'${specifier}'`);
  if (index !== -1) return source.slice(0, index).split('\n').length;
  const doubleQuoted = source.indexOf(`"${specifier}"`);
  if (doubleQuoted !== -1) return source.slice(0, doubleQuoted).split('\n').length;
  return 1;
}

// The guest hook binary and src/hook/** import neither tmuxexec.js nor
// paneio.js -- ast-hook is structurally incapable of pressing a key.
// Scope is asserted here as well as declared in `paths`, so the rule stays
// correct if the governed paths are ever widened -- bin/ast is deliberately
// allowed to reach a keypress path and must never be flagged by this rule.
function isHookPath(relPath) {
  return relPath === 'bin/ast-hook' || relPath.startsWith('src/hook/');
}

function check(files) {
  const violations = [];
  for (const file of files) {
    if (!isHookPath(file.file)) continue;

    for (const specifier of extractImportSpecifiers(file.source)) {
      if (!(specifier.endsWith('tmuxexec.js') || specifier.endsWith('paneio.js'))) continue;
      violations.push({
        ruleId: ID,
        file: file.file,
        line: lineOfSpecifier(file.source, specifier),
        message: `the hook path imports "${specifier}"`,
      });
    }
  }
  return violations;
}

export const hookKeypressBan = Object.freeze({
  id: ID,
  description: 'Ban bin/ast-hook and src/hook/** from importing a keypress path (tmuxexec.js or paneio.js).',
  paths: Object.freeze(['bin/ast-hook', 'src/hook']),
  check,
});
