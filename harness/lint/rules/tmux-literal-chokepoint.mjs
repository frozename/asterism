const ID = 'tmux-literal-chokepoint';

// send-keys/respawn-pane/capture-pane are Phase 1 non-goals everywhere except
// adapter provoke/evidence prose (caller data, not a tmux call site) and the
// one counted, pre-existing exemption in src/capture/tmux.js.
export const LITERAL_PATTERN = /send-keys|respawn-pane|capture-pane/;
export const LITERAL_EXEMPT_DIR = /^src\/adapters\/[^/]+\//;
export const LITERAL_EXEMPT_FILE = 'src/capture/tmux.js';
export const LITERAL_EXEMPT_COUNT = 4;

function matchingLines(source, pattern) {
  return source
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => pattern.test(line));
}

function check(files) {
  const violations = [];
  let exemptSeen = false;
  let exemptCount = 0;

  for (const file of files) {
    if (LITERAL_EXEMPT_DIR.test(file.file)) continue;

    const matches = matchingLines(file.source, LITERAL_PATTERN);
    if (file.file === LITERAL_EXEMPT_FILE) {
      exemptSeen = true;
      exemptCount = matches.length;
      continue;
    }
    for (const { line, number } of matches) {
      violations.push({
        ruleId: ID,
        file: file.file,
        line: number,
        message: `send-keys/respawn-pane/capture-pane literal outside the tmux chokepoint: ${line.trim()}`,
      });
    }
  }

  if (!exemptSeen) {
    violations.push({
      ruleId: ID,
      file: LITERAL_EXEMPT_FILE,
      line: 1,
      message: `${LITERAL_EXEMPT_FILE} was not found in the swept files; the counted tmux-literal exemption cannot be verified`,
    });
  } else if (exemptCount !== LITERAL_EXEMPT_COUNT) {
    const grew = exemptCount > LITERAL_EXEMPT_COUNT;
    const follow = grew
      ? 'a fifth forces the recorded migration follow-up'
      : 'the recorded exemption count must be lowered to match';
    violations.push({
      ruleId: ID,
      file: LITERAL_EXEMPT_FILE,
      line: 1,
      message: `${LITERAL_EXEMPT_FILE} ${grew ? 'grew' : 'dropped'} to ${exemptCount} matching line(s) of the counted exemption, expected exactly ${LITERAL_EXEMPT_COUNT} -- ${follow}`,
    });
  }

  return violations;
}

export const tmuxLiteralChokepoint = Object.freeze({
  id: ID,
  description:
    'Ban send-keys/respawn-pane/capture-pane literals under bin/ and src/ outside adapter prose, except a counted exemption in src/capture/tmux.js.',
  paths: Object.freeze(['bin', 'src']),
  check,
});
