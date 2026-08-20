// The enumerable uninstall registry. Every artifact this module or its
// siblings write must have an entry here before the writer lands -- see
// test/uninstall-coverage.test.mjs, which sweeps src/ for call sites and
// fails the build on anything not covered by a `matches` value below.

export const UNINSTALL_TARGETS = Object.freeze([
  Object.freeze({
    id: 'tmux-conf-managed-block',
    kind: 'managed-block',
    matches: 'cfgedit.apply(',
    description:
      'the tmux.conf managed block; removed by applying a content-null plan; uninstall leaves the rest byte-identical and succeeds twice.',
  }),
  Object.freeze({
    id: 'managed-block-plan-sites',
    kind: 'report-only',
    matches: 'cfgedit.planManagedBlock(',
    description: 'planning call sites; the artifact is owned by tmux-conf-managed-block.',
  }),
  Object.freeze({
    id: 'managed-block-diff-sites',
    kind: 'report-only',
    matches: 'cfgedit.diffManagedBlock(',
    description: 'pure drift diff; never a writer.',
  }),
  Object.freeze({
    id: 'managed-block-drift-check',
    kind: 'report-only',
    matches: 'cfgedit.checkManagedBlockDrift(',
    description: 'the doctor drift check body; report-only by construction.',
  }),
  Object.freeze({
    id: 'vendor-tree-owned-files',
    kind: 'owned-file',
    matches: 'cfgedit.applyFilePlan(',
    description:
      'whole asterism-owned files placed in a foreign config tree (the plugin scaffold); removed by the file-plan remover, marker-gated.',
  }),
  Object.freeze({
    id: 'file-plan-plan-sites',
    kind: 'report-only',
    matches: 'cfgedit.planFile(',
    description: 'file-plan planning call sites.',
  }),
  Object.freeze({
    id: 'file-plan-remove-sites',
    kind: 'report-only',
    matches: 'cfgedit.removeFilePlan(',
    description: 'the uninstall path itself.',
  }),
  Object.freeze({
    id: 'shell-completion-file',
    kind: 'owned-file',
    matches: 'writeTextAtomic(',
    description:
      'the shell completion file ast init writes through the store chokepoint; listed here so ast uninstall can enumerate it.',
  }),
  Object.freeze({
    id: 'launchd-agents-scan',
    kind: 'report-only',
    matches: 'LaunchAgents',
    description: 'pre-covers a later phase doctor scan; backups go to $STATE, never there.',
  }),
  Object.freeze({
    id: 'launchd-plist-scan',
    kind: 'report-only',
    matches: '.plist',
    description: 'pre-covers any bare plist-suffix scan line; self-covering since its own source line matches itself.',
  }),
]);
