import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emitNotes } from '../notes.js';
import { checkSchema } from '../../core/schema-check.js';
import { collectObservations } from '../../io/discover.js';
import { readLayout, resolveStateDir } from '../../io/store.js';
import { assertFormatSafe, newWindow, serverInfo } from '../../io/tmuxexec.js';
import { resolveServers } from '../../io/tmuxsock.js';

export const mutating = true;
export const summary = 'resume saved agent sessions in detached tmux windows';

const USAGE = 'usage: ast restore [--dry-run] [--only <ref>] [--force]\n';

function parseArgs(argv) {
  const options = { dryRun: false, only: null, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run' && options.dryRun === false) {
      options.dryRun = true;
    } else if (arg === '--force' && options.force === false) {
      options.force = true;
    } else if (arg === '--only' && options.only === null) {
      const ref = argv[index + 1];
      if (typeof ref !== 'string' || ref.length === 0 || ref.startsWith('--')) return null;
      options.only = ref;
      index += 1;
    } else {
      return null;
    }
  }
  return options;
}

function refusal(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ast restore: ${message}\n`);
  return 1;
}

function selectEntries(entries, ref) {
  if (ref === null) return { entries };
  const exact = entries.filter((entry) => entry.sessionId === ref);
  if (exact.length === 1) return { entries: exact };

  const matches = entries.filter((entry) => entry.sessionId.startsWith(ref));
  if (matches.length === 0) return { error: `no layout entry matches "${ref}"` };
  if (matches.length > 1) {
    return { error: `ambiguous layout ref "${ref}": matches ${matches.map((entry) => entry.sessionId).sort().join(', ')}` };
  }
  return { entries: matches };
}

async function validateEntries(entries, adapters) {
  const plan = [];
  for (const entry of entries) {
    const adapter = adapters.get(entry.adapter);
    if (adapter === undefined) {
      return { error: `adapter-unknown: ${JSON.stringify(entry.adapter)} for ${entry.sessionId}` };
    }
    if (!path.isAbsolute(entry.cwd)) {
      return { error: `cwd-unsafe: ${JSON.stringify(entry.cwd)} for ${entry.sessionId}: must be an absolute path` };
    }
    try {
      assertFormatSafe(entry.cwd);
    } catch (error) {
      return {
        error: `cwd-unsafe: ${JSON.stringify(entry.cwd)} for ${entry.sessionId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let cwdInfo;
    try {
      cwdInfo = await fs.stat(entry.cwd);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { error: `cwd-missing: ${JSON.stringify(entry.cwd)} for ${entry.sessionId}` };
      }
      throw error;
    }
    if (!cwdInfo.isDirectory()) {
      return { error: `cwd-missing: ${JSON.stringify(entry.cwd)} for ${entry.sessionId} is not a directory` };
    }
    plan.push(Object.freeze({ entry, adapter }));
  }
  return { plan: Object.freeze(plan) };
}

function entryKey(entry) {
  return JSON.stringify([entry.adapter, entry.sessionId]);
}

async function discoverLive(plan, ctx) {
  const keys = new Set();
  const seenAdapters = new Set();
  const notes = [];
  for (const item of plan) {
    if (seenAdapters.has(item.entry.adapter)) continue;
    seenAdapters.add(item.entry.adapter);
    const discovered = await collectObservations(item.adapter, {
      env: ctx.env,
      home: os.homedir(),
      execute: ctx.execute,
    });
    notes.push(...discovered.notes);
    for (const observation of discovered.observations) {
      if (typeof observation.fields.sessionId !== 'string') continue;
      keys.add(JSON.stringify([observation.adapter, observation.fields.sessionId]));
    }
  }
  emitNotes(notes);
  return keys;
}

async function reachableServer(ctx) {
  const findServers = ctx.resolveServers ?? resolveServers;
  const notes = [];
  const servers = await findServers({
    env: ctx.env,
    uid: process.getuid(),
    probe: ({ socketPath, env }) => serverInfo({ socketPath, env, execute: ctx.execute }),
    notes,
  });
  emitNotes(notes);
  return servers[0] ?? null;
}

function printSkip(entry) {
  process.stdout.write(`restore: skip ${entry.sessionId} (already live)\n`);
}

function printDryRun(entry, command) {
  process.stdout.write(
    `restore: would resume ${entry.sessionId} (${entry.adapter}) in ${JSON.stringify(entry.cwd)} with ` +
      `${JSON.stringify(command)} -- rollback: tmux kill-window -t %N\n`,
  );
}

export async function run(argv, ctx) {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  try {
    const layout = await readLayout(resolveStateDir(ctx.env));
    if (layout === null) return refusal('no layout is available');

    const schema = JSON.parse(await fs.readFile(path.join(ctx.root, 'schema', 'layout-1.json'), 'utf8'));
    const checked = checkSchema(schema, layout);
    if (!checked.ok) return refusal(`schema-invalid: ${checked.errors.join('; ')}`);

    const selected = selectEntries(layout.entries, options.only);
    if (selected.error) return refusal(selected.error);
    const validated = await validateEntries(selected.entries, ctx.adapters);
    if (validated.error) return refusal(validated.error);

    const live = await discoverLive(validated.plan, ctx);
    const survivors = [];
    for (const item of validated.plan) {
      if (!options.force && live.has(entryKey(item.entry))) {
        printSkip(item.entry);
        continue;
      }
      survivors.push(item);
    }
    if (survivors.length === 0) return 0;

    const server = await reachableServer(ctx);
    if (server === null) return refusal('no tmux server is reachable');

    for (const item of survivors) {
      const entry = item.entry;
      const command = item.adapter.resumeArgv({ sessionId: entry.sessionId });
      if (options.dryRun) {
        printDryRun(entry, command);
        continue;
      }
      const paneId = await newWindow({
        cwd: entry.cwd,
        command,
        detached: true,
        socketPath: server.socketPath,
        env: ctx.env,
        execute: ctx.execute,
      });
      process.stdout.write(`${entry.sessionId} -> ${paneId} (resumed; unbound until the session-start hook fires)\n`);
    }
    return 0;
  } catch (error) {
    return refusal(error);
  }
}
