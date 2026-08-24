import { extractImportSpecifiers, resolveRelativeSpecifier } from '../../structural.mjs';

const ID = 'adapter-boundary';

// An adapter directory never reaches into a sibling adapter, or into the
// registry that is supposed to be the only thing importing adapters.
const ADAPTER_DIR_PATTERN = /^src\/adapters\/([^/]+)\//;
const ADAPTER_INDEX_FILE = 'src/adapters/index.js';

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
    const ownMatch = file.file.match(ADAPTER_DIR_PATTERN);
    if (!ownMatch) continue;
    const ownAdapter = ownMatch[1];

    for (const specifier of extractImportSpecifiers(file.source)) {
      if (!(specifier.startsWith('.') || specifier.startsWith('/'))) continue;
      const resolved = resolveRelativeSpecifier(file.file, specifier);
      const line = lineOfSpecifier(file.source, specifier);

      if (resolved === ADAPTER_INDEX_FILE) {
        violations.push({
          ruleId: ID,
          file: file.file,
          line,
          message: `adapter "${ownAdapter}" imports the registry via "${specifier}"`,
        });
        continue;
      }

      const otherMatch = resolved.match(ADAPTER_DIR_PATTERN);
      if (otherMatch && otherMatch[1] !== ownAdapter) {
        violations.push({
          ruleId: ID,
          file: file.file,
          line,
          message: `adapter "${ownAdapter}" imports adapter "${otherMatch[1]}" via "${specifier}"`,
        });
      }
    }
  }
  return violations;
}

export const adapterBoundary = Object.freeze({
  id: ID,
  description:
    'Ban a file under src/adapters/<id>/ from importing a sibling adapter directory or the adapter registry (src/adapters/index.js).',
  paths: Object.freeze(['src/adapters']),
  check,
});
