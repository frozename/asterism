import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildRegistry } from '../adapters/index.js';
import { resolveRecipe } from '../capture/run.js';
import { GATED_AXES_BY_PHASE, unknownAxes, validateRecord } from '../core/caps.js';
import { parseToml } from '../core/toml.js';
import { procexec } from '../io/procexec.js';

export const STATUS = Object.freeze(['pass', 'warn', 'fail', 'todo']);

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

async function todo(phase) {
  return { status: 'todo', detail: `lands in Phase ${phase}` };
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

export const CHECKS = Object.freeze([
  Object.freeze({
    id: 'state.permissions',
    prevents: 'a state file that other users on the machine can read.',
    run: () => todo(2),
  }),
  Object.freeze({
    id: 'state.targets-are-ids',
    prevents: 'state that persists a pane or session target keyed by a mutable name instead of a stable id.',
    run: () => todo(2),
  }),
  Object.freeze({
    id: 'identity.sha',
    prevents: "asterism acting on its own binary or state after either was modified out from under it.",
    run: () => todo(2),
  }),
  Object.freeze({
    id: 'tmux.version-floor',
    prevents: "asterism's tmux integration running against a tmux release below the supported floor.",
    run: () => todo(3),
  }),
  Object.freeze({
    id: 'tmux.managed-block-drift',
    prevents: "the managed block in tmux's config silently drifting from what asterism last wrote, unnoticed (report-only).",
    run: () => todo(3),
  }),
  Object.freeze({
    id: 'tmux.pipe-pane-occupied',
    prevents: 'a second process piping a managed pane asterism believes it owns exclusively.',
    run: () => todo(3),
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
    run: () => todo(5),
  }),
  Object.freeze({
    id: 'retention.counts',
    prevents: "asterism's own state growing without bound over the life of a long-running session.",
    run: () => todo(5),
  }),
  Object.freeze({
    id: 'canary.unknown-fields',
    prevents: "a parser silently ignoring a field it doesn't recognize in real target output, until it matters.",
    run: () => todo(5),
  }),
  Object.freeze({
    id: 'launchd.stale-plists',
    prevents: 'a stale launchd service definition still loaded alongside the current one.',
    run: () => todo(6),
  }),
]);

export async function runDoctor({ root, home, env, checks = CHECKS }) {
  const results = [];
  for (const check of checks) {
    const { status, detail } = await check.run({ root, home, env });
    results.push({ id: check.id, status, detail });
  }

  const exit = results.every((result) => result.status === 'pass' || result.status === 'warn') ? 0 : 1;
  return { results, exit };
}
