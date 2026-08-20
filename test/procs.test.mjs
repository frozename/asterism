import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCtime } from '../src/core/liveness.js';
import {
  ancestry,
  bootId,
  hostId,
  linuxStart,
  parseProcStatStart,
  parsePsPidLstart,
  processTable,
} from '../src/io/procs.js';

function response(stdout, code = 0) {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

test('processTable batches all pids into one ps call and parses local ctime values', async () => {
  const calls = [];
  const execute = async (argv, options) => {
    calls.push({ argv, options });
    return response(' 111 Mon Aug 17 20:27:33 2026\n 222 Mon Aug  3 07:05:09 2026\n');
  };

  const result = await processTable([111, 222], { execute, env: { PATH: '/bin' } });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['ps', '-o', 'pid=,lstart=', '-p', '111,222']);
  assert.equal(result.table.get(111), parseCtime('Mon Aug 17 20:27:33 2026', { utc: false }));
  assert.equal(result.table.get(222), parseCtime('Mon Aug  3 07:05:09 2026', { utc: false }));
  assert.equal(result.note, null);
});

test('processTable skips an empty list and fails closed on malformed output', async () => {
  let calls = 0;
  const empty = await processTable([], {
    execute: async () => {
      calls += 1;
      return response('');
    },
  });
  assert.equal(calls, 0);
  assert.equal(empty.table.size, 0);
  assert.equal(empty.note, null);
  const malformed = await processTable([111], { execute: async () => response('zzz\n') });
  assert.equal(malformed.table.size, 0);
  assert.equal(typeof malformed.note, 'string');
  const clean = parsePsPidLstart(' 111 Mon Aug 17 20:27:33 2026\n');
  assert.equal(clean.size, 1);
});

test('parseProcStatStart reads field 22 after the last parenthesis', () => {
  const tricky = '1234 (a b) c) R 1 1 0 0 -1 4194560 100 0 0 0 5 5 0 0 20 0 1 0 9999 0';
  const plain = '1234 (node) R 1 1 0 0 -1 4194560 100 0 0 0 5 5 0 0 20 0 1 0 8888 0';

  assert.equal(parseProcStatStart(tricky), 9999);
  assert.equal(parseProcStatStart(plain), 8888);
  assert.throws(() => parseProcStatStart('1234 (short) R 1 2'), RangeError);
});

test('linuxStart combines boot time with whole clock-tick seconds', async () => {
  const statLine = '1234 (node) R 1 1 0 0 -1 4194560 100 0 0 0 5 5 0 0 20 0 1 0 9999 0';
  const reads = [];
  const result = await linuxStart(42, {
    readText: async (filePath) => {
      reads.push(filePath);
      return filePath === '/proc/stat' ? 'cpu 1 2 3\nbtime 1700000000\n' : statLine;
    },
  });

  assert.deepEqual(reads, ['/proc/stat', '/proc/42/stat']);
  assert.equal(result, 1700000099);
});

test('ancestry reads the whole pid table with one call', async () => {
  const calls = [];
  const result = await ancestry({
    env: { PATH: '/bin' },
    execute: async (argv, options) => {
      calls.push({ argv, options });
      return response(' 10 1\n 20 10\n');
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['ps', '-A', '-o', 'pid=,ppid=']);
  assert.deepEqual([...result.table], [[10, 1], [20, 10]]);
  assert.equal(result.note, null);
});

test('bootId and hostId return null on environmental failure, beside a darwin parse control', async () => {
  const failed = await bootId({
    platform: 'darwin',
    execute: async () => {
      throw new Error('absent');
    },
  });
  assert.equal(failed, null);

  const parsed = await bootId({
    platform: 'darwin',
    execute: async () => response('{ sec = 1700000000, usec = 0 }'),
  });
  assert.equal(parsed, '1700000000');

  const unsupported = await bootId({ platform: 'other', execute: async () => response('unused') });
  assert.equal(unsupported, null);

  const hostname = hostId();
  assert.ok(hostname === null || typeof hostname === 'string');
});

test('processTable parses ps lstart output with four trailing spaces without degrading', async () => {
  const result = await processTable([111], {
    execute: async () => response(' 111 Mon Aug 17 20:27:33 2026    \n'),
  });

  assert.equal(result.table.get(111), parseCtime('Mon Aug 17 20:27:33 2026', { utc: false }));
  assert.equal(result.note, null);
});

test('parsePsPidLstart trims trailing padding without collapsing single-digit-day spacing', () => {
  const table = parsePsPidLstart(' 222 Thu Aug  1 07:05:09 2026    \n');

  assert.equal(table.get(222), parseCtime('Thu Aug  1 07:05:09 2026', { utc: false }));
});

test('processTable still degrades when a matched lstart value is genuinely malformed', async () => {
  const result = await processTable([333], {
    execute: async () => response(' 333 Mon Aug 17 20:27 2026\n'),
  });

  assert.equal(result.table.size, 0);
  assert.equal(typeof result.note, 'string');
  assert.ok(result.note.includes('parseCtime: input does not match the ctime shape'));
});
