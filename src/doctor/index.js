import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRegistry } from '../adapters/index.js';
import { resolveRecipe } from '../capture/run.js';
import { GATED_AXES_BY_PHASE, unknownAxes, validateRecord } from '../core/caps.js';
import { checkPipePaneOccupied, checkTmuxVersionFloor } from '../core/tmuxver.js';
import { parseToml } from '../core/toml.js';
import * as cfgedit from '../io/cfgedit.js';
import { checkDiscoverySources } from '../io/discover.js';
import { verifyIdentity } from '../io/identity.js';
import { procexec } from '../io/procexec.js';
import {
  auditPermissions,
  checkAttentionStuck,
  checkCanaryUnknownFields,
  checkRetentionCounts,
  checkTargetsAreIds,
  resolveStateDir,
} from '../io/store.js';
import { execTmux, serverInfo } from '../io/tmuxexec.js';
import { resolveServer } from '../io/tmuxsock.js';

export const STATUS = Object.freeze(['pass', 'warn', 'fail', 'todo', 'unknown']);

const SEVERITY = Object.freeze({ pass: 0, warn: 1, fail: 2 });
const DAY_MS = 24 * 60 * 60 * 1000;

function worseStatus(a, b) {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

function captureCommandFor(id, capture) {
  const resolved = resolveRecipe(id);
  const isManual = resolved?.recipe?.source === 'manual';
  return isManual ? `${capture} --from <file>` : capture;
}

async function inspectManifestCell(root, id, cell, env) {
  const dir = path.join(root, 'fixtures', ...id.split('/'));

  let rawBytes;
  let meta;
  try {
    rawBytes = await readFile(path.join(dir, 'raw'));
    meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return { captured: false, stale: false, status: cell.kind === 'required' ? 'fail' : 'warn', versionUnknown: false };
  }

  const actualSha = createHash('sha256').update(rawBytes).digest('hex');
  if (meta.sha256 !== actualSha) {
    return { captured: false, stale: false, status: 'fail', versionUnknown: false };
  }

  if (cell.kind !== 'manual') {
    return { captured: true, stale: false, status: 'pass', versionUnknown: false };
  }

  let stale = false;
  let staleReason = null;
  let status = 'pass';
  let versionUnknown = false;

  const capturedAtMs = Date.parse(meta.capturedAt ?? '');
  if (!Number.isNaN(capturedAtMs) && (Date.now() - capturedAtMs) / DAY_MS > cell.maxAgeDays) {
    stale = true;
    staleReason = `older than ${cell.maxAgeDays}d`;
    status = 'fail';
  }

  const resolved = resolveRecipe(id);
  if (resolved?.recipe?.cliVersionArgv) {
    try {
      const result = await procexec(resolved.recipe.cliVersionArgv, { env, timeoutMs: 10000 });
      const installed = result.stdout.toString('utf8').trim();
      if (installed.length > 0 && installed !== meta.cliVersion) {
        stale = true;
        staleReason = staleReason ? `${staleReason}, cliVersion drift` : 'cliVersion drift';
        status = 'fail';
      }
    } catch {
      // cannot verify version -- do not escalate an otherwise-fresh capture
      versionUnknown = true;
      status = worseStatus(status, 'warn');
    }
  }

  return { captured: true, stale, staleReason, status, versionUnknown };
}

async function checkFixturesManifest({ root, env }) {
  const manifestPath = path.join(root, 'fixtures', 'MANIFEST.toml');

  let manifest;
  try {
    manifest = parseToml(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return { status: 'fail', detail: `fixtures/MANIFEST.toml is missing or unparseable: ${error.message}` };
  }

  const cells = manifest?.cells ?? {};
  let overall = 'pass';
  let total = 0;
  let captured = 0;
  let manualPending = 0;
  let stale = 0;

  const missingRequired = [];
  const missingManual = [];
  const staleCells = [];
  const versionUnknownCells = [];

  for (const [id, cell] of Object.entries(cells)) {
    if (cell.kind === 'n/a') continue;
    total += 1;

    const state = await inspectManifestCell(root, id, cell, env);

    if (state.captured) captured += 1;
    if (cell.kind === 'manual' && !state.captured) manualPending += 1;
    if (cell.kind === 'manual' && state.stale) stale += 1;

    if (!state.captured && cell.kind === 'required') missingRequired.push({ id, capture: captureCommandFor(id, cell.capture) });
    if (!state.captured && cell.kind === 'manual') missingManual.push({ id, capture: captureCommandFor(id, cell.capture) });
    if (state.stale) staleCells.push({ id, capture: captureCommandFor(id, cell.capture), reason: state.staleReason });
    if (state.versionUnknown) versionUnknownCells.push(id);

    overall = worseStatus(overall, state.status);
  }

  let detail = `${captured}/${total} captured, ${manualPending} manual pending, ${stale} stale`;
  if (missingRequired.length > 0) {
    detail += `; missing required: ${missingRequired.map((c) => `${c.id} (${c.capture})`).join(', ')}`;
  }
  if (missingManual.length > 0) {
    detail += `; missing manual: ${missingManual.map((c) => `${c.id} (${c.capture})`).join(', ')}`;
  }
  if (staleCells.length > 0) {
    detail += `; stale: ${staleCells.map((c) => `${c.id} [${c.reason}] (${c.capture})`).join(', ')}`;
  }
  if (versionUnknownCells.length > 0) {
    detail += `; cannot verify version: ${versionUnknownCells.join(', ')}`;
  }

  return { status: overall, detail };
}

async function checkCapabilityUnknowns(ctx) {
  const registry = ctx.registry ?? buildRegistry(ctx.env ?? {});
  const gatedAxes = GATED_AXES_BY_PHASE[1];

  const clauses = [];
  let hasGatedUnknown = false;
  let adapterCount = 0;

  for (const adapter of registry.values()) {
    adapterCount += 1;

    let record;
    try {
      record = validateRecord(adapter.capabilities);
    } catch (error) {
      return { status: 'fail', detail: `${adapter.id}: invalid capability record — ${error.message}` };
    }

    for (const entry of unknownAxes(record)) {
      if (gatedAxes.includes(entry.axis)) hasGatedUnknown = true;
      clauses.push(`${adapter.id}.${entry.axis} unknown — deferred to ${entry.deferredTo}; resolve with: ${entry.probe}`);
    }
  }

  if (clauses.length === 0) {
    return { status: 'pass', detail: `no unknown axes across ${adapterCount} adapters` };
  }

  return { status: hasGatedUnknown ? 'fail' : 'warn', detail: clauses.join('; ') };
}

async function withStateDir(ctx, check) {
  let stateDir;
  try {
    stateDir = resolveStateDir(ctx.env ?? {});
  } catch (error) {
    return {
      status: 'unknown',
      detail: `state directory cannot be resolved: ${error.message}; set HOME or XDG_STATE_HOME`,
    };
  }
  return check(stateDir);
}

async function tmuxExecuteFor(env) {
  const resolved = await resolveServer({
    env,
    uid: process.getuid(),
    probe: ({ socketPath, env: probeEnv }) => serverInfo({ socketPath, env: probeEnv }),
  });
  const socketPath = resolved.ok ? resolved.socketPath : path.join(os.tmpdir(), 'asterism-test-doctor-no-server');
  return (tmuxArgs, opts) => execTmux(tmuxArgs, { socketPath, env: opts?.env ?? env });
}

export function tmuxBlockContent(root) {
  return (
    `bind-key g display-popup -E -w 80% -h 60% '${root}/bin/ast ls'\n` +
    `bind-key G display-popup -E -w 80% -h 60% '${root}/bin/ast go'`
  );
}

async function tmuxConfigTarget(env, home) {
  if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0) {
    const candidate = path.join(env.XDG_CONFIG_HOME, 'tmux', 'tmux.conf');
    try {
      await readFile(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') return candidate;
    }
  }
  return path.join(home, '.tmux.conf');
}

async function checkManagedBlock(ctx) {
  const targetPath = await tmuxConfigTarget(ctx.env ?? {}, ctx.home);
  const result = await cfgedit.checkManagedBlockDrift({
    targetPath,
    blockId: 'cockpit-keys',
    content: tmuxBlockContent(ctx.root),
  });
  return {
    status: result.status,
    detail: result.detail ?? `managed block "cockpit-keys" matches in ${targetPath}`,
  };
}

export async function checkStaleLaunchdPlists({ home, platform = process.platform }) {
  if (platform !== 'darwin') return { status: 'pass', detail: `launchd does not apply on ${platform}` };

  const dir = path.join(home, 'Library', 'LaunchAgents');
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'pass', detail: `no LaunchAgents directory at ${dir}` };
    return { status: 'unknown', detail: `cannot read LaunchAgents directory at ${dir}: ${error.message}` };
  }

  const stale = entries.filter((name) => name.includes('asterism') && name.includes('.bak-')).sort();
  if (stale.length > 0) return { status: 'warn', detail: `stale launchd plist backup(s): ${stale.join(', ')}` };
  return { status: 'pass', detail: `${entries.length} entries in ${dir}, none asterism-stale` };
}

async function checkDiscoveryAgreement(ctx) {
  const registry = ctx.registry ?? buildRegistry(ctx.env ?? {});
  const clauses = [];
  let overall = 'pass';

  for (const adapter of registry.values()) {
    const result = await checkDiscoverySources(adapter, { env: ctx.env, home: ctx.home });
    clauses.push(`${adapter.id}: ${result.detail}`);
    if (result.status === 'fail') overall = 'fail';
    else if (result.status === 'unknown' && overall === 'pass') overall = 'unknown';
  }

  return {
    status: overall,
    detail: overall === 'pass' ? `sources agree across ${registry.size} adapter(s)` : clauses.join('; '),
  };
}

export const CHECKS = Object.freeze([
  Object.freeze({
    id: 'state.permissions',
    prevents: 'a state file that other users on the machine can read.',
    run: (ctx) => withStateDir(ctx, (stateDir) => auditPermissions({ stateDir })),
  }),
  Object.freeze({
    id: 'state.targets-are-ids',
    prevents: 'state that persists a pane or session target keyed by a mutable name instead of a stable id.',
    run: (ctx) => withStateDir(ctx, (stateDir) => checkTargetsAreIds({ stateDir })),
  }),
  Object.freeze({
    id: 'identity.sha',
    prevents: "asterism acting on its own binary or state after either was modified out from under it.",
    run: (ctx) =>
      withStateDir(ctx, async (stateDir) => {
        const result = await verifyIdentity({ root: ctx.root, stateDir });
        return { status: result.status, detail: result.note ?? 'installed tree matches identity.json' };
      }),
  }),
  Object.freeze({
    id: 'tmux.version-floor',
    prevents: "asterism's tmux integration running against a tmux release below the supported floor.",
    run: async ({ env }) => checkTmuxVersionFloor({ env, execute: await tmuxExecuteFor(env) }),
  }),
  Object.freeze({
    id: 'tmux.managed-block-drift',
    prevents: "the managed block in tmux's config silently drifting from what asterism last wrote, unnoticed (report-only).",
    run: checkManagedBlock,
  }),
  Object.freeze({
    id: 'tmux.pipe-pane-occupied',
    prevents: 'a second process piping a managed pane asterism believes it owns exclusively.',
    run: async ({ env }) => checkPipePaneOccupied({ env, execute: await tmuxExecuteFor(env) }),
  }),
  Object.freeze({
    id: 'fixtures.manifest',
    prevents: 'the fixture capture campaign stalling silently, or a manual capture going stale without anyone noticing.',
    run: checkFixturesManifest,
  }),
  Object.freeze({
    id: 'probe.capability-unknowns',
    prevents: 'a feature gating its behavior on a capability axis nobody has actually probed.',
    run: checkCapabilityUnknowns,
  }),
  Object.freeze({
    id: 'attention.stuck',
    prevents: 'a prompt the loop believes it already answered, but the target never received the answer.',
    run: (ctx) => withStateDir(ctx, (stateDir) => checkAttentionStuck({ stateDir })),
  }),
  Object.freeze({
    id: 'retention.counts',
    prevents: "asterism's own state growing without bound over the life of a long-running session.",
    run: (ctx) => withStateDir(ctx, (stateDir) => checkRetentionCounts({ stateDir })),
  }),
  Object.freeze({
    id: 'canary.unknown-fields',
    prevents: "a parser silently ignoring a field it doesn't recognize in real target output, until it matters.",
    run: (ctx) => withStateDir(ctx, (stateDir) => checkCanaryUnknownFields({ stateDir, now: Date.now() })),
  }),
  Object.freeze({
    id: 'launchd.stale-plists',
    prevents: 'a stale launchd service definition still loaded alongside the current one.',
    run: ({ home }) => checkStaleLaunchdPlists({ home }),
  }),
  Object.freeze({
    id: 'discovery.source-agreement',
    prevents: 'the contract listing and the enrichment registry silently disagreeing about the same session.',
    run: checkDiscoveryAgreement,
  }),
]);

export async function runDoctor({ root, home, env, registry, checks = CHECKS }) {
  const results = [];
  for (const check of checks) {
    const { status, detail } = await check.run({ root, home, env, registry });
    results.push({ id: check.id, status, detail });
  }

  const exit = results.every((result) => result.status === 'pass' || result.status === 'warn') ? 0 : 1;
  return { results, exit };
}
