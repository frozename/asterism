import { extractImportSpecifiers, resolveRelativeSpecifier } from '../../structural.mjs';

const ID = 'purity';
const CORE_DIR = 'src/core';

export const BANNED_BUILTINS = Object.freeze([
  'child_process',
  'fs',
  'fs/promises',
  'net',
  'os',
  'http',
  'https',
  'http2',
  'dgram',
  'dns',
  'tls',
  'cluster',
  'worker_threads',
  'process',
]);

function isInsideCore(relPath) {
  return relPath === CORE_DIR || relPath.startsWith(`${CORE_DIR}/`);
}

// A specifier can span lines (`import { x }\n  from\n    'y';`), so the
// specifier's own text -- not the source line it starts on -- is what
// reliably locates it for the reported line number.
function lineOfSpecifier(source, specifier) {
  const index = source.indexOf(`'${specifier}'`);
  if (index !== -1) return source.slice(0, index).split('\n').length;
  const doubleQuoted = source.indexOf(`"${specifier}"`);
  if (doubleQuoted !== -1) return source.slice(0, doubleQuoted).split('\n').length;
  return 1;
}

function firstLineContaining(source, needle) {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  return index === -1 ? 1 : index + 1;
}

function check(files) {
  const violations = [];
  for (const file of files) {
    if (file.source.includes('process.env')) {
      violations.push({
        ruleId: ID,
        file: file.file,
        line: firstLineContaining(file.source, 'process.env'),
        message: 'contains process.env',
      });
    }

    for (const specifier of extractImportSpecifiers(file.source)) {
      const line = lineOfSpecifier(file.source, specifier);

      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const resolved = resolveRelativeSpecifier(file.file, specifier);
        if (!isInsideCore(resolved)) {
          violations.push({
            ruleId: ID,
            file: file.file,
            line,
            message: `relative import "${specifier}" escapes src/core/`,
          });
        }
        continue;
      }

      const bareName = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
      if (BANNED_BUILTINS.includes(bareName)) {
        violations.push({
          ruleId: ID,
          file: file.file,
          line,
          message: `banned import "${specifier}"`,
        });
      } else if (!specifier.startsWith('node:')) {
        violations.push({
          ruleId: ID,
          file: file.file,
          line,
          message: `bare package specifier "${specifier}"`,
        });
      }
    }
  }
  return violations;
}

export const purity = Object.freeze({
  id: ID,
  description:
    'Ban process.env, banned Node builtins (with or without the node: prefix), bare package imports, and relative imports that escape src/core/, across every file under src/core/.',
  paths: Object.freeze(['src/core']),
  check,
});
