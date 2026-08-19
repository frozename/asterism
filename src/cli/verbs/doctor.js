import os from 'node:os';
import { runDoctor } from '../../doctor/index.js';

export const mutating = false;
export const summary = 'run every registered health check and report pass/warn/fail/todo';

const USAGE = 'usage: ast doctor [--json]\n';

function parseArgs(argv) {
  const options = { json: false };
  for (const arg of argv) {
    if (arg === '--json') {
      options.json = true;
    } else {
      return null;
    }
  }
  return options;
}

export async function run(argv, ctx) {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  const home = os.homedir();
  const env = {
    PATH: ctx.env.PATH ?? '',
    HOME: home,
    TERM: ctx.env.TERM ?? '',
    LANG: ctx.env.LANG ?? '',
  };

  const { results, exit } = await runDoctor({ root: ctx.root, home, env });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return exit;
  }

  const idWidth = Math.max(0, ...results.map((result) => result.id.length));
  for (const result of results) {
    process.stdout.write(`${result.status.padEnd(4)}  ${result.id.padEnd(idWidth)}  ${result.detail}\n`);
  }

  const counts = { pass: 0, warn: 0, fail: 0, todo: 0 };
  for (const result of results) counts[result.status] += 1;
  process.stdout.write(`doctor: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail, ${counts.todo} todo\n`);

  return exit;
}
