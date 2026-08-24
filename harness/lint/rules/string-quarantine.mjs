const ID = 'string-quarantine';

// This repository is public and deliberately vendor-neutral. The regex below
// must spell out the literals it bans, so defining it here is itself a hit;
// that line carries its own marker, mirroring exec-ban's self-reference
// handling. Every other hit outside the adapter/fixtures/vectors quarantine
// needs its own `quarantine-exempt` marker.
export const VENDOR_LITERAL = /claude|codex|gemini|copilot|opencode|CLAUDE_|dangerously/i; // quarantine-exempt: pattern definition, not a real vendor literal
export const ADAPTER_DIR_PATTERN = /^src\/adapters\/[^/]+\//;
export const ADAPTER_INDEX_FILE = 'src/adapters/index.js';
export const FIXTURES_DIR_PATTERN = /(^|\/)fixtures\//;
export const VECTORS_DIR_PATTERN = /(^|\/)vectors\//;

export function isOutOfScope(relPath) {
  if (ADAPTER_DIR_PATTERN.test(relPath)) return true;
  if (relPath === ADAPTER_INDEX_FILE) return true;
  if (FIXTURES_DIR_PATTERN.test(relPath)) return true;
  if (VECTORS_DIR_PATTERN.test(relPath)) return true;
  return false;
}

function check(files) {
  const violations = [];
  for (const file of files) {
    if (isOutOfScope(file.file)) continue;

    const lines = file.source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes('quarantine-exempt')) return;
      if (!VENDOR_LITERAL.test(line)) return;
      violations.push({
        ruleId: ID,
        file: file.file,
        line: index + 1,
        message: `vendor literal outside the adapter/fixture/vector quarantine or a marked line: ${line.trim()}`,
      });
    });
  }
  return violations;
}

export const stringQuarantine = Object.freeze({
  id: ID,
  description:
    'Ban vendor-identifying string literals under bin/, src/, harness/, test/, and .github/workflows outside adapter directories, fixtures/vectors dirs, or a line marked quarantine-exempt.',
  paths: Object.freeze(['bin', 'src', 'harness', 'test', '.github/workflows']),
  check,
});
