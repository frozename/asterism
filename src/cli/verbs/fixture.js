import os from 'node:os';
import { captureCell, CELL_ID_PATTERN, listKnownCells } from '../../capture/run.js';

export const mutating = true;
export const summary = 'capture a scrubbed fixture cell into fixtures/, or list known cells';

export async function run(argv, ctx) {
  const [subcommand, ...rest] = argv;

  if (subcommand === 'list') {
    for (const cell of listKnownCells()) process.stdout.write(`${cell}\n`);
    return 0;
  }

  if (subcommand === 'capture') {
    return runCapture(rest, ctx);
  }

  printUsage();
  return 2;
}

function printUsage() {
  process.stderr.write(
    'usage: ast fixture capture <cell-id> [--provoked-by "<text>"] [--home <dir>] [--from <path>]\n' +
      '       ast fixture list\n',
  );
}

async function runCapture(rest, ctx) {
  const { cellId, provokedBy, home: homeFlag, from } = parseArgs(rest);

  if (cellId === undefined) {
    printUsage();
    return 2;
  }

  if (!CELL_ID_PATTERN.test(cellId)) {
    process.stderr.write(`ast fixture capture: invalid cell id "${cellId}"\n`);
    return 2;
  }

  const home = homeFlag ?? os.homedir();
  const env = {
    PATH: ctx.env.PATH ?? '',
    HOME: home,
    TERM: ctx.env.TERM ?? '',
    LANG: ctx.env.LANG ?? '',
  };

  const result = await captureCell(cellId, {
    home,
    env,
    cwd: process.cwd(),
    repoRoot: ctx.root,
    provokedBy: provokedBy ?? '',
    fromPath: from,
  });

  if (!result.ok) {
    process.stderr.write(`ast fixture capture: ${result.message}\n`);
    return result.exitCode;
  }

  process.stdout.write(
    `captured ${result.cellId} (${result.bytes} bytes, ${result.redactionCount} redactions) -> fixtures/${result.cellId}/\n`,
  );
  return 0;
}

function parseArgs(args) {
  let cellId;
  let provokedBy;
  let home;
  let from;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--provoked-by') {
      provokedBy = args[index + 1];
      index += 1;
    } else if (arg === '--home') {
      home = args[index + 1];
      index += 1;
    } else if (arg === '--from') {
      from = args[index + 1];
      index += 1;
    } else if (cellId === undefined) {
      cellId = arg;
    }
  }

  return { cellId, provokedBy, home, from };
}
