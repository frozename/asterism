import { noSilentCatch } from './rules/no-silent-catch.mjs';
import { verbRefusalsAreReturned } from './rules/verb-refusals-are-returned.mjs';
import { verbExportContract } from './rules/verb-export-contract.mjs';
import { noConsole } from './rules/no-console.mjs';
import { cliSubprocessUsesNode } from './rules/cli-subprocess-uses-node.mjs';
import { writerChokepoint } from './rules/writer-chokepoint.mjs';

export const RULES = Object.freeze([
  noSilentCatch,
  verbRefusalsAreReturned,
  verbExportContract,
  noConsole,
  cliSubprocessUsesNode,
  writerChokepoint,
]);
