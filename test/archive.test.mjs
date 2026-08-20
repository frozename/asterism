import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run as runArchive } from '../src/cli/verbs/archive.js';
import { run as runLs } from '../src/cli/verbs/ls.js';
import { openStore, readArchive, readSessions } from '../src/io/store.js';

const RECORD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function recordFor(lifecycle = 'Live') {
  return {
    id: RECORD_ID,
    adapter: 'fake',
    agent: { sessionId: 'fake-0001' },
    lifecycle,
    flags: { parked: lifecycle === 'Parked', writeDisabled: false },
    observed: { status: 'idle', waitingFor: null, lastSeen: 42 },
    prov: {},
  };
}

async function setupStoredRecord(lifecycle = 'Live') {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ast-archive-store-'));
  const env = { HOME: tmp, XDG_STATE_HOME: tmp };
  const store = await openStore({ env });
  const record = recordFor(lifecycle);
  await store.writeSession(record.id, record);
  return {
    store,
    record,
    sourcePath: path.join(store.stateDir, 'sessions', `${record.id}.json`),
    archivePath: path.join(store.stateDir, 'archive', `${record.id}.json`),
  };
}

async function runDirect(argv, env, run = runArchive) {
  let stdout = '';
  let stderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };

  try {
    const code = await run(argv, { env, adapters: new Map(), root: process.cwd() });
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

test('archiveSession writes and verifies a 0600 archive copy before removing the source', async () => {
  const box = await setupStoredRecord();

  await box.store.archiveSession(box.record.id, box.record);

  assert.deepEqual(await readSessions(box.store.stateDir), { records: [], errors: [] });
  assert.deepEqual((await readArchive(box.store.stateDir)).records[0].record, box.record);
  assert.equal((await stat(box.archivePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(box.archivePath))).mode & 0o777, 0o700);
});

test('archiveSession crash injection after the copy leaves both readable records', async () => {
  const box = await setupStoredRecord();

  await assert.rejects(
    () => box.store.archiveSession(box.record.id, box.record, {
      beforeRemove: async () => {
        throw new Error('injected crash');
      },
    }),
    /injected crash/,
  );

  assert.deepEqual((await readSessions(box.store.stateDir)).records[0].record, box.record);
  assert.deepEqual((await readArchive(box.store.stateDir)).records[0].record, box.record);
});

test('archiveSession refuses to remove the source when archive verification fails', async () => {
  const box = await setupStoredRecord();
  const sourceBefore = await readFile(box.sourcePath);

  await assert.rejects(
    () => box.store.archiveSession(box.record.id, box.record, {
      beforeRemove: async (archivePath) => writeFile(archivePath, '{}\n'),
    }),
    /archive verification failed/,
  );

  assert.deepEqual(await readFile(box.sourcePath), sourceBefore);
});

test('archive run accepts Live default and Parked while changing only lifecycle', async () => {
  for (const lifecycle of [undefined, 'Parked']) {
    const box = await setupStoredRecord(lifecycle ?? 'Live');
    if (lifecycle === undefined) {
      delete box.record.lifecycle;
      await box.store.writeSession(box.record.id, box.record);
    }

    const result = await runDirect(['fake-0001'], {
      HOME: path.dirname(path.dirname(box.store.stateDir)),
      XDG_STATE_HOME: path.dirname(box.store.stateDir),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readSessions(box.store.stateDir), { records: [], errors: [] });
    assert.deepEqual((await readArchive(box.store.stateDir)).records[0].record, {
      ...box.record,
      lifecycle: 'Archived',
    });
  }
});

test('archive run resolves an already-archived refusal and preserves archive bytes', async () => {
  const box = await setupStoredRecord('Archived');
  await box.store.archiveSession(box.record.id, box.record);
  const before = await readFile(box.archivePath);

  const result = await runDirect(['fake-0001'], {
    HOME: path.dirname(path.dirname(box.store.stateDir)),
    XDG_STATE_HOME: path.dirname(box.store.stateDir),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /lifecycle: illegal transition "Archived" \+ "archive"/);
  assert.deepEqual(await readFile(box.archivePath), before);
});

test('archive run resolves an unknown lifecycle refusal with the session and offending value', async () => {
  const box = await setupStoredRecord('Zombie');
  const before = await readFile(box.sourcePath);

  const result = await runDirect(['fake-0001'], {
    HOME: path.dirname(path.dirname(box.store.stateDir)),
    XDG_STATE_HOME: path.dirname(box.store.stateDir),
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'ast archive: fake-0001: Zombie: lifecycle: unknown state "Zombie"\n');
  assert.deepEqual(await readFile(box.sourcePath), before);
  assert.deepEqual(await readArchive(box.store.stateDir), { records: [], errors: [] });
});

test('archive run resolves an unknown-ref refusal without writing any file', async () => {
  const box = await setupStoredRecord();
  const sourceBefore = await readFile(box.sourcePath);

  const result = await runDirect(['missing'], {
    HOME: path.dirname(path.dirname(box.store.stateDir)),
    XDG_STATE_HOME: path.dirname(box.store.stateDir),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /no session matches "missing"/);
  assert.deepEqual(await readFile(box.sourcePath), sourceBefore);
  assert.deepEqual(await readArchive(box.store.stateDir), { records: [], errors: [] });
});

test('archive run returns usage for malformed argv without writing', async () => {
  const box = await setupStoredRecord();
  const sourceBefore = await readFile(box.sourcePath);

  const result = await runDirect([], {
    HOME: path.dirname(path.dirname(box.store.stateDir)),
    XDG_STATE_HOME: path.dirname(box.store.stateDir),
  });

  assert.equal(result.code, 2);
  assert.equal(result.stderr, 'usage: ast archive <sessionRef>\n');
  assert.deepEqual(await readFile(box.sourcePath), sourceBefore);
});

test('archive round-trip is hidden from plain ls and visible as non-waiting under ls --all', async () => {
  const box = await setupStoredRecord();
  box.record.observed.status = 'waiting';
  box.record.observed.waitingFor = 'approval';
  await box.store.writeSession(box.record.id, box.record);
  const env = {
    HOME: path.dirname(path.dirname(box.store.stateDir)),
    XDG_STATE_HOME: path.dirname(box.store.stateDir),
  };
  assert.equal((await runDirect(['fake-0001'], env)).code, 0);

  const plain = await runDirect([], env, runLs);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, '0 sessions · 0 need you\n');

  const all = await runDirect(['--all'], env, runLs);
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.stdout.split('\n')[0], '1 session · 0 need you');
  assert.match(all.stdout, new RegExp(`^archived\\s+fake\\s+${box.record.id}\\s+`, 'm'));
});
