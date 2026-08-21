import assert from 'node:assert/strict';
import test from 'node:test';
import { procexec } from '../src/io/procexec.js';

const NODE_ENV = { PATH: process.env.PATH ?? '' };

test('runs node -e with an argv array and returns code/stdout', async () => {
  const result = await procexec(['node', '-e', 'process.stdout.write("hello"); process.exit(7)'], {
    env: NODE_ENV,
  });

  assert.equal(result.code, 7);
  assert.equal(result.stdout.toString('utf8'), 'hello');
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

test('writes an explicit string to child stdin and closes the pipe', async () => {
  const result = await procexec(
    ['node', '-e', 'process.stdin.pipe(process.stdout)'],
    { env: NODE_ENV, input: 'commit message bytes\n' },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString('utf8'), 'commit message bytes\n');
});

test('rejects a non-array argv', async () => {
  await assert.rejects(() => procexec('node -e 1', { env: NODE_ENV }), TypeError);
  await assert.rejects(() => procexec([], { env: NODE_ENV }), TypeError);
  await assert.rejects(() => procexec(['node', 7], { env: NODE_ENV }), TypeError);
});

test('a 100ms timeout on a 5s sleep reports timedOut: true', async () => {
  const result = await procexec(['node', '-e', 'setTimeout(() => {}, 5000)'], {
    env: NODE_ENV,
    timeoutMs: 100,
  });

  assert.equal(result.timedOut, true);
});

test('a control run without hitting the timeout does not report timedOut', async () => {
  const result = await procexec(['node', '-e', '1'], { env: NODE_ENV, timeoutMs: 5000 });
  assert.equal(result.timedOut, false);
});

test('kills the child when stdout exceeds maxBytes', async () => {
  const result = await procexec(
    ['node', '-e', 'while (true) process.stdout.write("x".repeat(1024))'],
    { env: NODE_ENV, maxBytes: 4096, timeoutMs: 5000 },
  );

  assert.ok(result.stdout.length >= 4096, 'should have buffered at least up to the cap before being killed');
  assert.notEqual(result.code, 0);
  assert.equal(result.truncated, true, 'a maxBytes kill should be surfaced in the result');
});
