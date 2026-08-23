import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { checkSchema } from '../src/core/schema-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadSchema(name) {
  return JSON.parse(await readFile(path.join(ROOT, 'schema', name), 'utf8'));
}

test('published schemas carry stable ids and version 1', async () => {
  const cases = [
    ['session-1.json', 'asterism:schema/session-1'],
    ['handoff-1.json', 'asterism:schema/handoff-1'],
    ['layout-1.json', 'asterism:schema/layout-1'],
  ];

  for (const [name, id] of cases) {
    const schema = await loadSchema(name);
    assert.equal(schema.$id, id);
    assert.equal(schema.version, 1);
  }
});

test('layout schema accepts the minimal document and rejects forbidden entry fields', async () => {
  const schema = await loadSchema('layout-1.json');
  const valid = {
    version: 1,
    capturedAt: '2026-08-23T12:00:00.000Z',
    entries: [{ adapter: 'fake-a', sessionId: 'session-1', cwd: '/work/one' }],
  };

  assert.deepEqual(checkSchema(schema, valid), { ok: true, errors: [] });
  const broken = { ...valid, entries: [{ ...valid.entries[0], paneId: '%7' }] };
  const result = checkSchema(schema, broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.startsWith('entries[0].paneId:')));
});

test('session schema accepts its open document and rejects a missing nested requirement', async () => {
  const schema = await loadSchema('session-1.json');
  const valid = {
    version: 1,
    writtenAt: '2026-08-20T00:00:00.000Z',
    sessions: [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        adapter: 'fake',
        sessionId: 'fake-0001',
        status: 'waiting',
        waitingFor: 'approval',
        lastSeen: 1,
        writeDisabled: true,
        reason: null,
        futureField: 'allowed',
      },
    ],
  };

  assert.deepEqual(checkSchema(schema, valid), { ok: true, errors: [] });
  assert.equal(checkSchema(schema, { ...valid, sessions: [{ ...valid.sessions[0], status: null }] }).ok, true);

  const broken = structuredClone(valid);
  delete broken.sessions[0].id;
  const result = checkSchema(schema, broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.startsWith('sessions[0].id:')));
});

test('handoff schema pins required prose and excludes preemptive priority', async () => {
  const schema = await loadSchema('handoff-1.json');
  const valid = {
    id: 'handoff-1',
    sessionRef: 'session-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    prose: 'Continue the task.',
    priority: 'normal',
  };

  assert.equal(checkSchema(schema, valid).ok, true);
  const broken = { ...valid };
  delete broken.prose;
  const result = checkSchema(schema, broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.startsWith('prose:')));
  assert.equal(schema.properties.priority.enum.includes('now'), false);
  assert.equal(checkSchema(schema, { ...valid, priority: 'now' }).ok, false);
});

test('checker handles every supported predicate in both directions and fails closed', () => {
  const cases = [
    [{ type: 'integer' }, 2, 2.5],
    [{ type: 'number' }, 2.5, '2.5'],
    [{ type: 'string' }, 'x', 1],
    [{ type: 'boolean' }, false, 0],
    [{ type: 'object' }, {}, []],
    [{ type: 'array' }, [], {}],
    [{ type: 'null' }, null, undefined],
    [{ type: ['string', 'null'] }, null, 1],
    [{ enum: ['a', 'b'] }, 'a', 'c'],
    [{ const: 1 }, 1, 2],
    [{ type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, { ok: true }, { extra: true }],
    [{ type: 'array', items: { type: 'string' } }, ['x'], [1]],
  ];

  for (const [schema, passing, failing] of cases) {
    assert.equal(checkSchema(schema, passing).ok, true, JSON.stringify(schema));
    assert.equal(checkSchema(schema, failing).ok, false, JSON.stringify(schema));
  }

  const unsupported = checkSchema({ type: 'string', pattern: '^x$' }, 'x');
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.errors.some((entry) => entry.includes('unsupported keyword "pattern"')));
});
