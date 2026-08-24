import { noSilentCatch } from './rules/no-silent-catch.mjs';
import { verbRefusalsAreReturned } from './rules/verb-refusals-are-returned.mjs';
import { verbExportContract } from './rules/verb-export-contract.mjs';
import { noConsole } from './rules/no-console.mjs';
import { cliSubprocessUsesNode } from './rules/cli-subprocess-uses-node.mjs';
import { writerChokepoint } from './rules/writer-chokepoint.mjs';
import { tmuxArgvChokepoint } from './rules/tmux-argv-chokepoint.mjs';
import { tmuxLiteralChokepoint } from './rules/tmux-literal-chokepoint.mjs';
import { execBan } from './rules/exec-ban.mjs';
import { stringQuarantine } from './rules/string-quarantine.mjs';
import { purity } from './rules/purity.mjs';
import { adapterBoundary } from './rules/adapter-boundary.mjs';
import { childProcessChokepoint } from './rules/child-process-chokepoint.mjs';
import { paneioContainment } from './rules/paneio-containment.mjs';
import { noTestHarnessImports } from './rules/no-test-harness-imports.mjs';
import { hookKeypressBan } from './rules/hook-keypress-ban.mjs';

export const RULES = Object.freeze([
  noSilentCatch,
  verbRefusalsAreReturned,
  verbExportContract,
  noConsole,
  cliSubprocessUsesNode,
  writerChokepoint,
  tmuxArgvChokepoint,
  tmuxLiteralChokepoint,
  execBan,
  stringQuarantine,
  purity,
  adapterBoundary,
  childProcessChokepoint,
  paneioContainment,
  noTestHarnessImports,
  hookKeypressBan,
]);
