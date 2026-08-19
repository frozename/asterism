import { stat } from 'node:fs/promises';
import os from 'node:os';
import { countSymbols, locateBinary, makeLedgerEntries } from '../../probe/static.js';

export const mutating = false;
export const summary = 'probe an installed agent CLI for known symbols';

const USAGE = 'usage: ast probe --static [--json] [--home <dir>] [--adapter <id>]\n';

function parseArgs(argv) {
  const options = { static: false, json: false, home: undefined, adapter: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--static') {
      options.static = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--home') {
      const value = argv[index + 1];
      if (value === undefined) return null;
      options.home = value;
      index += 1;
    } else if (arg === '--adapter') {
      const value = argv[index + 1];
      if (value === undefined) return null;
      options.adapter = value;
      index += 1;
    } else {
      return null;
    }
  }

  return options;
}

export async function run(argv, ctx) {
  const options = parseArgs(argv);
  if (options === null || !options.static) {
    process.stderr.write(USAGE);
    return 2;
  }

  let selected;
  if (options.adapter !== undefined) {
    const adapter = ctx.adapters.get(options.adapter);
    if (adapter === undefined) {
      process.stderr.write(`probe: unknown adapter "${options.adapter}"\n${USAGE}`);
      return 2;
    }
    selected = [adapter];
  } else {
    selected = [...ctx.adapters.values()];
  }

  const home = options.home ?? os.homedir();
  const at = new Date().toISOString();
  const entries = [];
  let foundAny = false;

  for (const adapter of selected) {
    const binary = await locateBinary(adapter, { home });

    if (binary === null) {
      const dirs = adapter.staticProbe
        .binaryCandidates(home)
        .map((candidate) => candidate.dir.replaceAll(home, '~'))
        .join(', ');
      process.stderr.write(`probe: ${adapter.id}: no binary found under ${dirs}\n`);
      continue;
    }

    foundAny = true;
    const counts = await countSymbols(binary.path, adapter.staticProbe.symbols);
    const bytes = (await stat(binary.path)).size;
    entries.push(
      ...makeLedgerEntries({
        adapter: adapter.id,
        binary: { version: binary.version, bytes },
        counts,
        at,
      }),
    );
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(entries)}\n`);
  } else {
    process.stdout.write('adapter  symbol  count\n');
    for (const entry of entries) {
      process.stdout.write(`${entry.adapter}  ${entry.symbol}  ${entry.count}\n`);
    }
  }

  return foundAny ? 0 : 1;
}
