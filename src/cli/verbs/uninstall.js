import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as cfgedit from '../../io/cfgedit.js';
import { openStore, resolveConfigDir } from '../../io/store.js';
import { UNINSTALL_TARGETS } from '../../io/uninstall-targets.js';

export const mutating = true;
export const summary = 'remove installed hooks, keybindings, and completion';

const USAGE = 'usage: ast uninstall [--dry-run]\n';
const BLOCK_ID = 'cockpit-keys';
const OWNED_MARKER = 'asterism managed file';

function parseArgs(argv) {
  if (argv.length === 0) return { dryRun: false };
  if (argv.length === 1 && argv[0] === '--dry-run') return { dryRun: true };
  return null;
}

async function readIfPresent(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function tmuxConfigPath(env, home) {
  if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0) {
    const candidate = path.join(env.XDG_CONFIG_HOME, 'tmux', 'tmux.conf');
    if ((await readIfPresent(candidate)) !== null) return candidate;
  }
  return path.join(home, '.tmux.conf');
}

async function dryOwnedFile(filePath) {
  const bytes = await readIfPresent(filePath);
  if (bytes === null) return 'noop';
  if (!bytes.toString('utf8').includes(OWNED_MARKER)) {
    throw new Error(`refusing to remove ${filePath}: file carries no asterism marker`);
  }
  return 'would-remove';
}

function combineActions(actions, dryRun) {
  if (actions.some((action) => action === (dryRun ? 'would-remove' : 'remove'))) {
    return dryRun ? 'would-remove' : 'removed';
  }
  return 'noop';
}

export async function run(argv, ctx) {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  const home = typeof ctx.env.HOME === 'string' && ctx.env.HOME.length > 0 ? ctx.env.HOME : os.homedir();
  const env = ctx.env.HOME === home ? ctx.env : { ...ctx.env, HOME: home };
  const configDir = resolveConfigDir(env);
  const completionPath = path.join(configDir, '_ast');
  const pluginPaths = [];
  for (const adapter of ctx.adapters.values()) {
    if (typeof adapter.installPlan !== 'function') continue;
    for (const entry of adapter.installPlan(ctx.root, home)) pluginPaths.push(entry.targetPath);
  }

  let store = null;
  if (!options.dryRun) store = await openStore({ env });

  const tmuxPlan = await cfgedit.planManagedBlock({
    targetPath: await tmuxConfigPath(env, home),
    blockId: BLOCK_ID,
    content: null,
  });

  const pluginActions = [];
  for (const targetPath of pluginPaths) {
    if (options.dryRun) pluginActions.push(await dryOwnedFile(targetPath));
    else pluginActions.push((await cfgedit.removeFilePlan({ targetPath })).action);
  }

  const completionAction = options.dryRun
    ? await dryOwnedFile(completionPath)
    : (await cfgedit.removeFilePlan({ targetPath: completionPath })).action;

  if (!options.dryRun && tmuxPlan.action !== 'noop') {
    await cfgedit.apply(tmuxPlan, { writeBackup: (slug, bytes) => store.writeBackup(slug, bytes) });
  }

  const outcomes = new Map([
    [
      'tmux-conf-managed-block',
      tmuxPlan.action === 'noop' ? 'noop' : options.dryRun ? 'would-remove' : 'removed',
    ],
    ['vendor-tree-owned-files', combineActions(pluginActions, options.dryRun)],
    ['shell-completion-file', combineActions([completionAction], options.dryRun)],
  ]);

  for (const target of UNINSTALL_TARGETS) {
    const outcome = outcomes.get(target.id) ?? (target.kind === 'report-only' ? 'report-only: skipped' : 'noop');
    process.stdout.write(`uninstall: ${target.id}: ${outcome}\n`);
  }
  return 0;
}
