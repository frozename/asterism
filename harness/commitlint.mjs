#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = Object.freeze(['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf', 'build', 'ci']);
const REPOSITORY_SCOPES = Object.freeze(['bin', 'harness', 'test', 'ci', 'docs']);
const HEADER_PATTERN = /^([a-z]+)\(([a-z0-9-]+)\)(!)?: (.*)$/;
const MISSING_SCOPE_PATTERN = /^[a-z]+!?: /;
const NON_IMPERATIVE_FIRST_WORD = /^(?:added|adds|built|builds|changed|changes|created|creates|documented|documents|fixed|fixes|implemented|implements|improved|improves|introduced|introduces|removed|removes|refactored|refactors|tested|tests|updated|updates|was|were|is|are|has|had|(?!(?:bring|cling|fling|ring|sing|spring|string|swing)$)\S+ing)$/;
const EXAMPLE = 'feat(cli): add ast new';
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const DEFAULT_COMMENT_CHAR = '#';
const SCISSORS_PATTERN = /^\s*-{8,}\s*>8\s*-{8,}\s*$/;

const srcScopes = (await readdir(SRC_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

export const SCOPE_VOCABULARY = Object.freeze([...new Set([...srcScopes, ...REPOSITORY_SCOPES])].sort());

function lengthOf(text) {
  return [...text].length;
}

function addViolation(violations, code, message) {
  violations.push(Object.freeze({ code, message }));
}

function normalizeCommentChar(commentChar) {
  if (commentChar === undefined || commentChar === '' || commentChar === 'auto') return DEFAULT_COMMENT_CHAR;
  if (typeof commentChar !== 'string') {
    throw new TypeError('validateCommitMessage: core.commentChar must be a string; commit cleanup cannot be parsed');
  }
  if (/[\r\n]/.test(commentChar)) {
    throw new TypeError(
      'validateCommitMessage: core.commentChar cannot contain newline; commit cleanup cannot be parsed',
    );
  }
  return commentChar;
}

function lineAfterCommentChar(line, commentChar) {
  if (!line.startsWith(commentChar)) return null;
  return line.slice(commentChar.length).trim();
}

function stripGitCleanupLines(lines, commentChar) {
  const authored = [lines[0] ?? ''];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const commentBody = lineAfterCommentChar(line, commentChar);
    if (commentBody !== null) {
      if (SCISSORS_PATTERN.test(commentBody)) break;
      continue;
    }
    authored.push(line);
  }

  return authored;
}

function validateBody(lines, violations) {
  const hasBody = lines.slice(1).some((line) => line.length > 0);
  if (!hasBody) return;

  const hasBlankSeparator = lines[1] === '';
  if (!hasBlankSeparator) {
    addViolation(violations, 'body.blank-line', 'a blank line is required before the commit body');
  }

  const bodyStart = hasBlankSeparator ? 2 : 1;
  for (let index = bodyStart; index < lines.length; index += 1) {
    if (lengthOf(lines[index]) > 100) {
      addViolation(
        violations,
        'body.line-length',
        `body line ${index + 1} is ${lengthOf(lines[index])} characters; maximum is 100`,
      );
    }
  }
}

export function validateCommitMessage(rawMessage, options = {}) {
  if (typeof rawMessage !== 'string') {
    throw new TypeError('validateCommitMessage: rawMessage must be a string');
  }

  const lines = rawMessage.split(/\r?\n/);
  const header = lines[0] ?? '';
  const violations = [];

  if (lengthOf(header) > 72) {
    addViolation(violations, 'header.length', `header is ${lengthOf(header)} characters; maximum is 72`);
  }

  const match = HEADER_PATTERN.exec(header);
  if (match === null) {
    if (MISSING_SCOPE_PATTERN.test(header)) {
      addViolation(violations, 'scope.required', 'scope is required; use <type>(<scope>): <subject>');
    } else {
      addViolation(
        violations,
        'header.format',
        'header must match <type>(<scope>): <subject>, with optional ! before the colon',
      );
    }
  } else {
    const [, type, scope, , subject] = match;

    if (!TYPES.includes(type)) {
      addViolation(violations, 'type.unknown', `type "${type}" is not allowed; expected one of: ${TYPES.join(', ')}`);
    }
    if (!SCOPE_VOCABULARY.includes(scope)) {
      addViolation(
        violations,
        'scope.unknown',
        `scope "${scope}" is not allowed; expected one of: ${SCOPE_VOCABULARY.join(', ')}`,
      );
    }

    if (subject.length === 0) {
      addViolation(violations, 'subject.empty', 'subject must be between 1 and 72 characters');
    } else {
      if (!/^[a-z]/.test(subject)) {
        addViolation(violations, 'subject.lowercase', 'subject must start with a lowercase letter');
      }
      if (subject.endsWith('.')) {
        addViolation(violations, 'subject.period', 'subject must not end with a period');
      }
      if (NON_IMPERATIVE_FIRST_WORD.test(subject.split(/\s+/, 1)[0])) {
        addViolation(violations, 'subject.imperative', 'subject must use imperative mood, such as "add" instead of "added"');
      }
      if (lengthOf(subject) > 72) {
        addViolation(
          violations,
          'subject.length',
          `subject is ${lengthOf(subject)} characters; maximum is 72`,
        );
      }
    }
  }

  validateBody(stripGitCleanupLines(lines, normalizeCommentChar(options.commentChar)), violations);
  return { valid: violations.length === 0, violations };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function parseArgs(argv) {
  const options = { commentChar: DEFAULT_COMMENT_CHAR, messagePath: undefined, error: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--comment-char') {
      options.commentChar = argv[index + 1];
      index += 1;
    } else if (options.messagePath === undefined) {
      options.messagePath = arg;
    } else {
      options.error = 'expected at most one commit-message file path';
    }
  }

  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.error !== null) {
    process.stderr.write('commitlint: expected at most one commit-message file path\n');
    process.stderr.write(`commitlint: example: ${EXAMPLE}\n`);
    return 2;
  }

  let rawMessage;
  try {
    rawMessage =
      options.messagePath === undefined ? await readStdin() : await readFile(options.messagePath, 'utf8');
  } catch (error) {
    const source = options.messagePath ?? 'stdin';
    process.stderr.write(`commitlint: could not read ${source}: ${error?.message ?? error}\n`);
    process.stderr.write(`commitlint: example: ${EXAMPLE}\n`);
    return 2;
  }

  const result = validateCommitMessage(rawMessage, { commentChar: options.commentChar });
  if (result.valid) return 0;

  for (const violation of result.violations) {
    process.stderr.write(`commitlint: ${violation.message}\n`);
  }
  process.stderr.write(`commitlint: example: ${EXAMPLE}\n`);
  return 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`commitlint: ${error?.message ?? error}\n`);
    process.stderr.write(`commitlint: example: ${EXAMPLE}\n`);
    process.exitCode = 2;
  }
}
