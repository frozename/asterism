import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildRegistry } from '../src/adapters/index.js';
import { findLeaks } from '../src/core/scrub.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const IS_BUN = typeof globalThis.Bun !== 'undefined';
const adapterId = [...buildRegistry({ ASTERISM_FAKE_ROOT: '/x' }).keys()].find((id) => id !== 'fake');
const adapter = buildRegistry({ ASTERISM_FAKE_ROOT: '/x' }).get(adapterId);
const cell = adapter.goldenCells.find((entry) => entry.split('/')[1] === 'agents-json' && entry.endsWith('/waiting'));
const rawPath = path.join(ROOT, 'fixtures', ...cell.split('/'), 'raw');

function registerTodo(name, message) {
  if (IS_BUN) {
    test.todo(name, () => {
      throw new Error(message);
    });
  } else {
    test(name, { todo: message }, () => {});
  }
}

if (!existsSync(rawPath)) {
  registerTodo('ls golden waiting capture', `missing: run \`ast fixture capture ${cell}\``);
} else {
  test('ls golden waiting capture', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ast-ls-golden-'));
    const shimDir = path.join(tmp, 'bin');
    await mkdir(shimDir);
    const command = adapter.discoverArgv()[0];
    const shimPath = path.join(shimDir, command);
    await writeFile(
      shimPath,
      `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(rawPath)}));\n`,
    );
    await chmod(shimPath, 0o755);
    const env = {
      PATH: shimDir + path.delimiter + path.dirname(process.execPath),
      HOME: tmp,
      XDG_STATE_HOME: tmp,
      TERM: 'dumb',
    };
    const { stdout } = await execFileAsync(process.execPath, [AST_BIN, 'ls'], { cwd: ROOT, env, encoding: 'utf8' });
    const snapshotPath = path.join(ROOT, 'vectors', 'golden', ...cell.split('/'), 'ls.txt');
    if (process.env.ASTERISM_UPDATE_GOLDEN === '1') {
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, stdout);
    } else if (!existsSync(snapshotPath)) {
      assert.fail(`missing ${path.relative(ROOT, snapshotPath)}; set ASTERISM_UPDATE_GOLDEN=1 to create it`);
    } else {
      assert.equal(Buffer.from(stdout).equals(await readFile(snapshotPath)), true);
    }
  });
}

test('golden vectors contain no home, repository, uuid, or token leaks', async () => {
  const goldenRoot = path.join(ROOT, 'vectors', 'golden');
  if (existsSync(goldenRoot)) {
    for (const file of await listFiles(goldenRoot)) {
      const leaks = findLeaks((await readFile(file)).toString('utf8'), {
        home: os.homedir(),
        extraRoots: [ROOT],
      });
      assert.deepEqual(leaks, [], `${path.relative(ROOT, file)} leaks: ${JSON.stringify(leaks)}`);
    }
  }

  const token = 'aZ9qW3eR7tY1uI5oP2sD8fG4jK6lH0nQ';
  const synthetic = `home=${os.homedir()}\nid=6f9619ff-8b86-d011-b42d-00c04fc964ff\nkey=${token}\n`;
  const leaks = findLeaks(synthetic, { home: os.homedir(), extraRoots: [ROOT] });
  assert.equal(leaks.length, 3);
  assert.deepEqual(leaks.map((entry) => entry.kind).sort(), ['home', 'token', 'uuid']);
});

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else if (entry.isFile()) files.push(full);
    else throw new Error(`${full}: unsupported golden entry`);
  }
  return files;
}
