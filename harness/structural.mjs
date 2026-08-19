import { readdirSync } from 'node:fs';
import path from 'node:path';

const FROM_SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_SPECIFIER = /\bimport\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_SPECIFIER = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;
const REQUIRE_SPECIFIER = /\brequire\s*\(\s*['"]([^'"]+)['"]/g;
const SPECIFIER_PATTERNS = [FROM_SPECIFIER, BARE_IMPORT_SPECIFIER, DYNAMIC_IMPORT_SPECIFIER, REQUIRE_SPECIFIER];

export function walkFiles(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export function filesWithExtensions(root, extensions) {
  return walkFiles(root).filter((file) => extensions.includes(path.extname(file)));
}

// Comments are not stripped before matching: a naive strip risks eating a real
// specifier (a false negative), which is unacceptable, whereas matching a
// specifier written inside a comment (a false positive) is an accepted cost.
export function extractImportSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

export function resolveRelativeSpecifier(fromPath, specifier) {
  const posixFrom = fromPath.split(path.sep).join('/');
  const dir = path.posix.dirname(posixFrom);
  return path.posix.normalize(path.posix.join(dir, specifier));
}
