import assert from 'node:assert/strict';
import test from 'node:test';
import { parseToml } from '../src/core/toml.js';

const LINE_NUMBER = /line \d+/;

test('round-trips the supported subset', () => {
  const text = `
# a leading comment, and a blank line above

[manifest]
schema = 1
enabled = true
disabled = false
name = "asterism"
literal = 'raw \\n not an escape'
tags = ["a", "b", "c"]
empty = []
trailing = ["x", "y",]

[cells."sample/help"]
kind = "required"
why = "flag surface; capability signature" # trailing comment
escaped = "line one\\nline two\\ttabbed \\"quoted\\" \\\\backslash"
`;

  const result = parseToml(text);

  assert.deepEqual(result, {
    manifest: {
      schema: 1,
      enabled: true,
      disabled: false,
      name: 'asterism',
      literal: 'raw \\n not an escape',
      tags: ['a', 'b', 'c'],
      empty: [],
      trailing: ['x', 'y'],
    },
    cells: {
      'sample/help': {
        kind: 'required',
        why: 'flag surface; capability signature',
        escaped: 'line one\nline two\ttabbed "quoted" \\backslash',
      },
    },
  });
});

test('dotted table headers nest, including a quoted segment containing a slash', () => {
  const result = parseToml(`
[a.b.c]
x = 1

[cells."sample/agents-json/idle"]
y = 2
`);

  assert.deepEqual(result, {
    a: { b: { c: { x: 1 } } },
    cells: { 'sample/agents-json/idle': { y: 2 } },
  });
});

test('a bare-key-only document with no tables at all parses to the root object', () => {
  assert.deepEqual(parseToml('a = 1\nb = "two"\n'), { a: 1, b: 'two' });
});

test('a basic-quoted key is supported', () => {
  const result = parseToml('[t]\n"a key" = "value"\n');
  assert.deepEqual(result, { t: { 'a key': 'value' } });
});

test('blank lines and comment-only lines are ignored', () => {
  assert.deepEqual(parseToml('\n\n# just a comment\n\na = 1\n'), { a: 1 });
});

test('inline tables throw with a line number', () => {
  assert.throws(() => parseToml('[t]\nx = { a = 1 }\n'), LINE_NUMBER);
});

test('multi-line strings throw with a line number', () => {
  assert.throws(() => parseToml('[t]\nx = """\nhello\n"""\n'), LINE_NUMBER);
  assert.throws(() => parseToml('[t]\nx = """inline"""\n'), LINE_NUMBER);
});

test('floats throw with a line number', () => {
  assert.throws(() => parseToml('[t]\nx = 1.5\n'), LINE_NUMBER);
});

test('dates throw with a line number', () => {
  assert.throws(() => parseToml('[t]\nx = 2024-01-01\n'), LINE_NUMBER);
});

test('array tables throw with a line number', () => {
  assert.throws(() => parseToml('[[items]]\nx = 1\n'), LINE_NUMBER);
});

test('duplicate keys throw with a line number', () => {
  assert.throws(() => parseToml('[t]\nx = 1\nx = 2\n'), LINE_NUMBER);
});

test('duplicate tables throw with a line number', () => {
  assert.throws(() => parseToml('[t]\nx = 1\n[t]\ny = 2\n'), LINE_NUMBER);
});

test('a key outside any table when tables exist throws with a line number', () => {
  assert.throws(() => parseToml('a = 1\n[t]\nx = 1\n'), LINE_NUMBER);
});

test('a key outside any table is fine when no tables exist anywhere in the document', () => {
  assert.deepEqual(parseToml('a = 1\nb = 2\n'), { a: 1, b: 2 });
});

test('unterminated strings throw with a line number', () => {
  assert.throws(() => parseToml('[t]\nx = "unterminated\n'), LINE_NUMBER);
  assert.throws(() => parseToml('[t]\nx = \'unterminated\n'), LINE_NUMBER);
  assert.throws(() => parseToml('[t."unterminated]\nx = 1\n'), LINE_NUMBER);
});

test('unterminated arrays throw with a line number', () => {
  assert.throws(() => parseToml('[t]\nx = ["a", "b"\n'), LINE_NUMBER);
});
