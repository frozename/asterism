import { extractImportSpecifiers } from '../../structural.mjs';

const ID = 'paneio-containment';

function lineOfSpecifier(source, specifier) {
  const index = source.indexOf(`'${specifier}'`);
  if (index !== -1) return source.slice(0, index).split('\n').length;
  const doubleQuoted = source.indexOf(`"${specifier}"`);
  if (doubleQuoted !== -1) return source.slice(0, doubleQuoted).split('\n').length;
  return 1;
}

// (1) containment: paneio.js is scoped to src/io/ and src/cli/verbs/.
// (2) forward tripwire: a seam/penumbra path may never import paneio.js or
// tmuxexec.js, regardless of directory. This guards a structure that does
// not fully exist yet -- it is deliberately forward-looking, not dead code.
function check(files) {
  const violations = [];
  for (const file of files) {
    const allowedDir = file.file.startsWith('src/io/') || file.file.startsWith('src/cli/verbs/');
    const seamOrPenumbra = file.file.includes('seam') || file.file.includes('penumbra');

    for (const specifier of extractImportSpecifiers(file.source)) {
      const line = lineOfSpecifier(file.source, specifier);

      if (!allowedDir && specifier.endsWith('paneio.js')) {
        violations.push({
          ruleId: ID,
          file: file.file,
          line,
          message: `imports paneio.js from outside src/io/ or src/cli/verbs/ (via "${specifier}")`,
        });
      }

      if (seamOrPenumbra && (specifier.endsWith('paneio.js') || specifier.endsWith('tmuxexec.js'))) {
        violations.push({
          ruleId: ID,
          file: file.file,
          line,
          message: `a seam/penumbra path imports "${specifier}"`,
        });
      }
    }
  }
  return violations;
}

export const paneioContainment = Object.freeze({
  id: ID,
  description:
    'Ban importing paneio.js under src/ outside src/io/ or src/cli/verbs/. Forward tripwire: ban a seam/penumbra path from ever importing paneio.js or tmuxexec.js, regardless of directory.',
  paths: Object.freeze(['src']),
  check,
});
