import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emitNotes } from '../notes.js';
import { listVerbs } from '../router.js';
import { STRONG_WITNESSES } from '../../core/binding.js';
import { collectObservations } from '../../io/discover.js';
import { buildIdentityManifest } from '../../io/identity.js';
import * as cfgedit from '../../io/cfgedit.js';
import {
  DEFAULT_CONFIG_TOML,
  openStore,
  readBindings,
  resolveConfigDir,
  resolveStateDir,
  writeJsonAtomic,
  writeTextAtomic,
} from '../../io/store.js';
import { serverInfo } from '../../io/tmuxexec.js';
import { resolveServers } from '../../io/tmuxsock.js';

export const mutating = true;
export const summary = 'install asterism state, hooks, keybindings, and completion';

const USAGE = 'usage: ast init [--dry-run] [--refresh]\n';
const BLOCK_ID = 'cockpit-keys';
const SHA256_HEX = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const options = { dryRun: false, refresh: false };
  for (const arg of argv) {
    if (arg === '--dry-run' && options.dryRun === false) options.dryRun = true;
    else if (arg === '--refresh' && options.refresh === false) options.refresh = true;
    else return null;
  }
  return options;
}

async function readIfPresent(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function previousInstallId(bytes) {
  if (bytes === null) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8'))?.installId;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function manifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function refreshRefusal(message) {
  process.stderr.write(`init refresh: ${message}; run ast init\n`);
  return 1;
}

function validIdentityManifest(value) {
  return value !== null &&
    typeof value === 'object' &&
    typeof value.installId === 'string' &&
    typeof value.installPath === 'string' &&
    value.files !== null &&
    typeof value.files === 'object' &&
    !Array.isArray(value.files) &&
    Object.values(value.files).every((digest) => typeof digest === 'string' && SHA256_HEX.test(digest));
}

async function refreshIdentity({ dryRun, root, identityPath, env }) {
  const existingIdentity = await readIfPresent(identityPath);
  if (existingIdentity === null) return refreshRefusal('identity manifest is absent');

  let previous;
  try {
    previous = JSON.parse(existingIdentity.toString('utf8'));
  } catch {
    return refreshRefusal('identity manifest is unparseable');
  }
  if (!validIdentityManifest(previous)) return refreshRefusal('identity manifest has an invalid shape');

  const next = await buildIdentityManifest({ root, previousInstallId: previous.installId });
  const movedPaths = [...new Set([...Object.keys(previous.files), ...Object.keys(next.files)])]
    .filter((relativePath) => previous.files[relativePath] !== next.files[relativePath])
    .sort();
  const nextIdentity = manifestBytes(next);
  if (!dryRun && !existingIdentity.equals(nextIdentity)) {
    try {
      await openStore({ env });
    } catch (error) {
      process.stderr.write(`init refresh: ${error?.message ?? error}\n`);
      return 1;
    }
    await writeJsonAtomic(identityPath, next);
  }
  for (const relativePath of movedPaths) {
    process.stdout.write(`init refresh: ${dryRun ? 'would re-attest' : 're-attested'} ${relativePath} (sha256 moved)\n`);
  }
  if (movedPaths.length === 0) process.stdout.write('init refresh: no file sha256 moved\n');
  return 0;
}

async function tmuxConfigPath(env, home) {
  if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0) {
    const candidate = path.join(env.XDG_CONFIG_HOME, 'tmux', 'tmux.conf');
    if ((await readIfPresent(candidate)) !== null) return candidate;
  }
  return path.join(home, '.tmux.conf');
}

function tmuxContent(root) {
  return (
    `bind-key g display-popup -E -w 80% -h 60% '${root}/bin/ast ls'\n` +
    `bind-key G display-popup -E -w 80% -h 60% '${root}/bin/ast go'`
  );
}

async function completionContent(root) {
  const verbs = await listVerbs(path.join(root, 'src', 'cli', 'verbs'));
  return `#compdef ast\n# asterism managed file -- removed by ast uninstall\n_arguments '1:verb:(${verbs.join(' ')})'\n`;
}

async function pluginFilePlans(ctx, home) {
  const plans = [];
  for (const adapter of ctx.adapters.values()) {
    if (typeof adapter.installPlan !== 'function') continue;
    for (const entry of adapter.installPlan(ctx.root, home)) {
      plans.push(await cfgedit.planFile({ targetPath: entry.targetPath, content: entry.content }));
    }
  }
  return plans;
}

function printInit(action, rollback, dryRun) {
  process.stdout.write(`init: ${dryRun ? 'would ' : ''}${action} -- rollback: ${rollback}\n`);
}

async function printRestartSessions(ctx, env, home, stateDir) {
  const sessions = new Map();
  for (const adapter of ctx.adapters.values()) {
    const { observations } = await collectObservations(adapter, { env, home });
    for (const observation of observations) {
      const sessionId = observation.fields?.sessionId;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        sessions.set(`${adapter.id}\0${sessionId}`, { adapter: adapter.id, sessionId });
      }
    }
  }
  if (sessions.size === 0) {
    process.stdout.write('no running sessions need a restart\n');
    return;
  }

  const { records: bindings } = await readBindings(stateDir);
  const probedPids = new Map();
  const notes = [];
  const servers = await resolveServers({
    env,
    uid: process.getuid(),
    probe: async ({ socketPath, env: probeEnv }) => {
      const result = await serverInfo({ socketPath, env: probeEnv });
      if (result.ok === true) probedPids.set(socketPath, result.pid);
      return result;
    },
    notes,
  });
  emitNotes(notes);
  const liveServerPids = new Set(servers.map((server) => probedPids.get(server.socketPath)).filter(Number.isInteger));
  const needsRestart = [...sessions.values()].filter(({ adapter, sessionId }) =>
    !bindings.some(({ record }) =>
      record.adapter === adapter &&
      record.sessionId === sessionId &&
      STRONG_WITNESSES.includes(record.by) &&
      liveServerPids.has(record.serverPid),
    ),
  );
  if (needsRestart.length === 0) {
    process.stdout.write('no running sessions need a restart\n');
    return;
  }
  for (const { adapter, sessionId } of needsRestart) {
    process.stdout.write(`restart to become bindable: ${adapter} ${sessionId}\n`);
  }
}

export async function run(argv, ctx) {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  const home = typeof ctx.env.HOME === 'string' && ctx.env.HOME.length > 0 ? ctx.env.HOME : os.homedir();
  const env = ctx.env.HOME === home ? ctx.env : { ...ctx.env, HOME: home };
  const stateDir = resolveStateDir(env);
  const configDir = resolveConfigDir(env);
  const configPath = path.join(configDir, 'config.toml');
  const identityPath = path.join(stateDir, 'identity.json');
  const completionPath = path.join(configDir, '_ast');

  if (options.refresh) {
    return refreshIdentity({ dryRun: options.dryRun, root: ctx.root, identityPath, env });
  }

  if (options.dryRun) {
    const storeReady =
      (await pathExists(stateDir)) &&
      (await pathExists(configDir)) &&
      (await pathExists(path.join(stateDir, 'schema-version')));
    if (!storeReady) printInit('prepare state and config directories', 'delete the state and config directories', true);
    if ((await readIfPresent(configPath)) === null) printInit(`install ${configPath}`, 'delete the file', true);
    const existingIdentity = await readIfPresent(identityPath);
    const manifest = await buildIdentityManifest({
      root: ctx.root,
      previousInstallId: previousInstallId(existingIdentity),
    });
    const nextIdentity = manifestBytes(manifest);
    if (existingIdentity === null || !existingIdentity.equals(nextIdentity)) {
      printInit(
        `install ${identityPath}`,
        existingIdentity === null ? 'delete the file' : 'restore the previous identity manifest',
        true,
      );
    }
    const pluginPlans = await pluginFilePlans(ctx, home);
    for (const plan of pluginPlans) {
      if (plan.action !== 'noop') printInit(`${plan.action} ${plan.target}`, 'remove the managed file', true);
    }
    const tmuxPlan = await cfgedit.planManagedBlock({
      targetPath: await tmuxConfigPath(env, home),
      blockId: BLOCK_ID,
      content: tmuxContent(ctx.root),
    });
    if (tmuxPlan.action !== 'noop') printInit(`${tmuxPlan.action} ${tmuxPlan.target}`, 'remove the managed block', true);
    const completion = await completionContent(ctx.root);
    const completionPlan = await cfgedit.planFile({ targetPath: completionPath, content: completion });
    if (completionPlan.action !== 'noop') printInit(`${completionPlan.action} ${completionPath}`, 'remove the file', true);
    return 0;
  }

  const storeWasReady =
    (await pathExists(stateDir)) &&
    (await pathExists(configDir)) &&
    (await pathExists(path.join(stateDir, 'schema-version')));
  const store = await openStore({ env });
  printInit(storeWasReady ? 'noop store' : 'prepared state and config directories', 'delete the state and config directories', false);

  if ((await readIfPresent(configPath)) === null) {
    await writeTextAtomic(configPath, DEFAULT_CONFIG_TOML, { mode: 0o600 });
    printInit(`installed ${configPath}`, 'delete the file', false);
  } else {
    printInit(`noop ${configPath}`, 'nothing changed', false);
  }

  const existingIdentity = await readIfPresent(identityPath);
  const manifest = await buildIdentityManifest({
    root: ctx.root,
    previousInstallId: previousInstallId(existingIdentity),
  });
  const nextIdentity = manifestBytes(manifest);
  if (existingIdentity === null || !existingIdentity.equals(nextIdentity)) {
    await writeJsonAtomic(identityPath, manifest);
    printInit(
      `installed ${identityPath}`,
      existingIdentity === null ? 'delete the file' : 'restore the previous identity manifest',
      false,
    );
  } else {
    printInit(`noop ${identityPath}`, 'nothing changed', false);
  }

  const writeBackup = (slug, bytes) => store.writeBackup(slug, bytes);
  const pluginPlans = await pluginFilePlans(ctx, home);
  for (const plan of pluginPlans) {
    if (plan.action !== 'noop') await cfgedit.applyFilePlan(plan, { writeBackup });
    printInit(`${plan.action === 'noop' ? 'noop' : plan.action} ${plan.target}`, 'remove the managed file', false);
  }

  const tmuxPlan = await cfgedit.planManagedBlock({
    targetPath: await tmuxConfigPath(env, home),
    blockId: BLOCK_ID,
    content: tmuxContent(ctx.root),
  });
  if (tmuxPlan.action !== 'noop') await cfgedit.apply(tmuxPlan, { writeBackup });
  printInit(`${tmuxPlan.action === 'noop' ? 'noop' : tmuxPlan.action} ${tmuxPlan.target}`, 'remove the managed block', false);

  const completion = await completionContent(ctx.root);
  const completionPlan = await cfgedit.planFile({ targetPath: completionPath, content: completion });
  if (completionPlan.action !== 'noop') await writeTextAtomic(completionPath, completion, { mode: 0o600 });
  printInit(
    `${completionPlan.action === 'noop' ? 'noop' : completionPlan.action} ${completionPath}`,
    'delete the file',
    false,
  );
  process.stdout.write(`add fpath=(${configDir} $fpath) and run compinit\n`);
  await printRestartSessions(ctx, env, home, store.stateDir);
  return 0;
}
