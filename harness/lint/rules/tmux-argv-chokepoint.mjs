const ID = 'tmux-argv-chokepoint';

// An array literal opening with the tmux binary name may only appear in the
// two declared chokepoint files -- anything else building a tmux argv
// bypasses execTmux's -u-always and target-validation guards.
export const ARGV_TMUX_LITERAL = /\[\s*['"]tmux['"]\s*,/;
export const ALLOWED_ARGV_FILES = Object.freeze(['src/io/tmuxexec.js', 'src/capture/tmux.js']);

function check(files) {
  const violations = [];
  for (const file of files) {
    if (ALLOWED_ARGV_FILES.includes(file.file)) continue;

    file.source.split(/\r?\n/).forEach((line, index) => {
      if (!ARGV_TMUX_LITERAL.test(line)) return;
      violations.push({
        ruleId: ID,
        file: file.file,
        line: index + 1,
        message: `builds a ['tmux', ...] argv literal outside the declared chokepoints: ${line.trim()}`,
      });
    });
  }
  return violations;
}

export const tmuxArgvChokepoint = Object.freeze({
  id: ID,
  description: "Ban ['tmux', ...] argv literals under bin/ and src/ outside the two declared chokepoint files.",
  paths: Object.freeze(['bin', 'src']),
  check,
});
