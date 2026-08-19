import { createReadStream } from 'node:fs';
import * as fsPromises from 'node:fs/promises';

const VERSION_SEGMENT = /^\d+$/;

function splitVersionSegments(name) {
  return name.split(/[.-]/);
}

function looksVersioned(name) {
  return splitVersionSegments(name).some((segment) => VERSION_SEGMENT.test(segment));
}

function compareVersionNames(a, b) {
  const partsA = splitVersionSegments(a);
  const partsB = splitVersionSegments(b);
  const length = Math.max(partsA.length, partsB.length);

  for (let index = 0; index < length; index += 1) {
    const partA = partsA[index];
    const partB = partsB[index];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;

    const numA = VERSION_SEGMENT.test(partA) ? Number(partA) : null;
    const numB = VERSION_SEGMENT.test(partB) ? Number(partB) : null;

    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA - numB;
      continue;
    }

    const cmp = partA.localeCompare(partB);
    if (cmp !== 0) return cmp;
  }

  return 0;
}

async function pickNewest(files, dir, fs) {
  if (files.length === 0) return null;

  if (files.some((file) => looksVersioned(file.name))) {
    return files.reduce((best, file) => (compareVersionNames(file.name, best.name) > 0 ? file : best));
  }

  const withMtimes = await Promise.all(
    files.map(async (file) => ({ file, mtimeMs: (await fs.stat(`${dir}/${file.name}`)).mtimeMs })),
  );
  return withMtimes.reduce((best, current) => (current.mtimeMs > best.mtimeMs ? current : best)).file;
}

export async function locateBinary(adapter, { home, fs = fsPromises } = {}) {
  const candidates = adapter.staticProbe.binaryCandidates(home);

  for (const { dir, pick } of candidates) {
    if (pick !== 'newest') continue;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const files = entries.filter((entry) => entry.isFile());
    const chosen = await pickNewest(files, dir, fs);
    if (chosen === null) continue;

    return { path: `${dir}/${chosen.name}`, version: chosen.name };
  }

  return null;
}

export async function countSymbols(path, symbols, { chunkBytes = 4 * 1024 * 1024 } = {}) {
  const counts = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  if (symbols.length === 0) return counts;

  const needles = symbols.map((symbol) => Buffer.from(symbol, 'utf8'));
  const longest = Math.max(...needles.map((needle) => needle.length));
  const overlap = Math.max(0, longest - 1);

  const countIn = (buf, upTo) => {
    for (let index = 0; index < symbols.length; index += 1) {
      const needle = needles[index];
      let at = buf.indexOf(needle, 0);
      while (at !== -1) {
        if (at < upTo) counts[symbols[index]] += 1;
        at = buf.indexOf(needle, at + needle.length);
      }
    }
  };

  let carry = Buffer.alloc(0);

  for await (const chunk of createReadStream(path, { highWaterMark: chunkBytes })) {
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const splitPoint = Math.max(0, buf.length - overlap);
    countIn(buf, splitPoint);
    carry = buf.subarray(splitPoint);
  }

  if (carry.length > 0) countIn(carry, carry.length);

  return counts;
}

export function makeLedgerEntries({ adapter, binary, counts, at }) {
  return Object.entries(counts).map(([symbol, count]) => ({
    adapter,
    symbol,
    present: count > 0,
    count,
    source: 'symbol-extraction',
    gates: false,
    binary: { version: binary.version, bytes: binary.bytes },
    at,
  }));
}
