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
]);
