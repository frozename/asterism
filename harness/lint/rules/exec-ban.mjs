const ID = 'exec-ban';

export const WHOLE_WORD_BANNED = /\b(execSync|execFileSync|spawnSync)\b/; // exec-ban-exempt: pattern definition, not a call site
export const EXEC_IMPORT_PATTERNS = [
  /\{\s*exec\s*\}/, // exec-ban-exempt: bare { exec } destructure or named import
  /\{\s*exec\s*,/, // exec-ban-exempt: { exec, ...
  /,\s*exec\s*\}/, // exec-ban-exempt: ..., exec }
  /\bexec\s*:/, // exec-ban-exempt: exec: renamed
  /promisify\(\s*exec\s*\)/,
  /child_process\.exec\(/,
  /\bcp\.exec\(/,
];
export const SHELL_TRUE = /\bshell\s*:\s*true\b/;
export const IN_SCOPE_EXTENSIONS = Object.freeze(['.js', '.mjs']);
export const EXTENSIONLESS_INCLUDES = Object.freeze(['bin/ast', 'bin/ast-hook']);

function inScope(file) {
  if (EXTENSIONLESS_INCLUDES.includes(file)) return true;
  return IN_SCOPE_EXTENSIONS.some((extension) => file.endsWith(extension));
}

function execBanOffense(line) {
  if (WHOLE_WORD_BANNED.test(line)) return true;
  if (EXEC_IMPORT_PATTERNS.some((pattern) => pattern.test(line))) return true;
  if (SHELL_TRUE.test(line)) return true;
  return false;
}

function check(files) {
  const violations = [];
  for (const file of files) {
    if (!inScope(file.file)) continue;

    const lines = file.source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes('exec-ban-exempt')) return;
      if (!execBanOffense(line)) return;
      violations.push({
        ruleId: ID,
        file: file.file,
        line: index + 1,
        message: `banned exec/shell-true pattern outside the declared exemptions: ${line.trim()}`,
      });
    });
  }
  return violations;
}

export const execBan = Object.freeze({
  id: ID,
  description:
    'Ban synchronous exec-family subprocess calls, aliased/destructured exec imports, and shell-interpreted subprocess launches under bin/, src/, harness/, and test/.',
  paths: Object.freeze(['bin', 'src', 'harness', 'test']),
  check,
});
