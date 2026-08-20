import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { parseCtime } from '../core/liveness.js';
import { procexec } from './procexec.js';

function result(table, note = null) {
  return Object.freeze({ table, note });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function parsePsPidLstart(text) {
  const table = new Map();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+)\s+([A-Za-z].*)$/.exec(line);
    if (match === null) throw new RangeError(`process table line ${index + 1} is malformed: "${line}"`);
    table.set(Number(match[1]), parseCtime(match[2].trimEnd(), { utc: false }));
  }
  return table;
}

export async function processTable(pids, { execute = procexec, env } = {}) {
  if (pids.length === 0) return result(new Map());

  try {
    const outcome = await execute(['ps', '-o', 'pid=,lstart=', '-p', pids.join(',')], { env });
    if (outcome.code !== 0) {
      return result(new Map(), `ps exited ${outcome.code}: ${outcome.stderr.toString('utf8').trim()}`);
    }
    return result(parsePsPidLstart(outcome.stdout.toString('utf8')));
  } catch (error) {
    return result(new Map(), `process table unavailable: ${errorMessage(error)}`);
  }
}

export function parseProcStatStart(statLine) {
  const close = statLine.lastIndexOf(')');
  if (close === -1) throw new RangeError('proc stat line has no closing comm parenthesis');
  const fields = statLine.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 20) throw new RangeError('proc stat line has fewer than 22 fields');
  const ticks = Number(fields[19]);
  if (!Number.isFinite(ticks)) throw new RangeError('proc stat starttime is not numeric');
  return ticks;
}

export const LINUX_CLOCK_TICK = 100;

export async function linuxStart(pid, { readText }) {
  const procStat = await readText('/proc/stat');
  const bootMatch = /^btime (\d+)$/m.exec(procStat);
  if (bootMatch === null) throw new RangeError('/proc/stat has no btime');
  const ticks = parseProcStatStart(await readText(`/proc/${pid}/stat`));
  return Number(bootMatch[1]) + Math.floor(ticks / LINUX_CLOCK_TICK);
}

function parseAncestry(text) {
  const table = new Map();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) throw new RangeError(`ancestry line ${index + 1} is malformed: "${line}"`);
    table.set(Number(match[1]), Number(match[2]));
  }
  return table;
}

export async function ancestry({ execute = procexec, env } = {}) {
  try {
    const outcome = await execute(['ps', '-A', '-o', 'pid=,ppid='], { env });
    if (outcome.code !== 0) {
      return result(new Map(), `ps exited ${outcome.code}: ${outcome.stderr.toString('utf8').trim()}`);
    }
    return result(parseAncestry(outcome.stdout.toString('utf8')));
  } catch (error) {
    return result(new Map(), `ancestry unavailable: ${errorMessage(error)}`);
  }
}

export async function bootId({ execute = procexec, env, platform = process.platform } = {}) {
  try {
    if (platform === 'darwin') {
      const outcome = await execute(['sysctl', '-n', 'kern.boottime'], { env });
      if (outcome.code !== 0) return null;
      const match = /sec = (\d+)/.exec(outcome.stdout.toString('utf8'));
      return match === null ? null : match[1];
    }
    if (platform === 'linux') {
      const match = /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'));
      return match === null ? null : match[1];
    }
    return null;
  } catch {
    return null;
  }
}

export function hostId() {
  try {
    return os.hostname();
  } catch {
    return null;
  }
}
