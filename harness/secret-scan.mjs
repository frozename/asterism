import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_COMMITTED_FIXTURE = path.join('test', 'fixtures', 'secret-digests.sha256');
const DEFAULT_OVERLAY = path.join('private', 'secret-digests.sha256');
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const EDGE_PUNCTUATION = /^[`'"‘’“”()[\]{}<>,.;:!?*|#]+|[`'"‘’“”()[\]{}<>,.;:!?*|#]+$/g;

export function normalize(text) {
  return String(text).split(/\s+/).map(normalizeToken).filter(Boolean).join(' ');
}

export function normalizeToken(token) {
  return String(token).toLowerCase().replace(EDGE_PUNCTUATION, '');
}

export function tokenize(normalizedText) {
  if (normalizedText.length === 0) return [];
  return normalizedText.split(' ');
}

export function windows(tokens, maxTokens = 4) {
  const result = [];

  for (let start = 0; start < tokens.length; start += 1) {
    const limit = Math.min(tokens.length, start + maxTokens);
    for (let end = start + 1; end <= limit; end += 1) {
      result.push(tokens.slice(start, end).join(' '));
    }
  }

  return result;
}

export function digestOf(str) {
  return createHash('sha256').update(normalize(str), 'utf8').digest('hex');
}

export function parseFixture(text, { source }) {
  const digests = new Set();
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('#')) continue;

    const lower = line.toLowerCase();
    if (!HEX_DIGEST.test(lower) || line.length !== 64) {
      throw new Error(`${source}:${index + 1}: expected a bare 64-character sha256 digest`);
    }

    digests.add(lower);
  }

  if (digests.size === 0) {
    throw new Error(`${source}: fixture contains no digests`);
  }

  return digests;
}

export function loadDigests(options = {}) {
  const root = options.root ?? process.cwd();
  const committedPath = options.committedPath ?? path.join(root, DEFAULT_COMMITTED_FIXTURE);
  const overlayPath = resolveOverlayPath(root, options.overlayPath ?? process.env.ASTERISM_SECRET_DIGESTS);

  if (!existsSync(committedPath)) {
    throw new Error(`${committedPath}: committed secret digest fixture is missing`);
  }

  const committed = parseFixture(readFileSync(committedPath, 'utf8'), { source: committedPath });
  const digests = new Set(committed);
  let overlayCount = 0;

  if (overlayPath !== null && existsSync(overlayPath)) {
    const overlay = parseFixture(readFileSync(overlayPath, 'utf8'), { source: overlayPath });
    overlayCount = overlay.size;
    for (const digest of overlay) digests.add(digest);
  }

  return {
    digests,
    committedCount: committed.size,
    overlayCount,
    overlayPath,
  };
}

export function scanText(text, digests) {
  const tokensWithLines = tokensFromText(text);
  const findings = [];

  for (let start = 0; start < tokensWithLines.length; start += 1) {
    const parts = [];
    const limit = Math.min(tokensWithLines.length, start + 4);

    for (let end = start; end < limit; end += 1) {
      parts.push(tokensWithLines[end].token);
      const digest = digestOf(parts.join(' '));
      if (digests.has(digest)) {
        findings.push({ line: tokensWithLines[start].line, digest });
      }
    }
  }

  return findings;
}

export async function listFiles(cwd) {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );

  return stdout
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
}

export async function listUnpushedCommits(cwd, range) {
  if (typeof range !== 'string' || range.length === 0) {
    throw new TypeError('listUnpushedCommits: range is required');
  }

  return parseLogOutput(await execGit(cwd, ['log', range, '--format=%h%x00%B%x00%x1e']));
}

function resolveOverlayPath(root, explicitPath) {
  const selected = explicitPath ?? DEFAULT_OVERLAY;
  if (selected === '') return null;
  return path.isAbsolute(selected) ? selected : path.join(root, selected);
}

function tokensFromText(text) {
  const result = [];
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(/\S+/g)) {
      const token = normalizeToken(match[0]);
      if (token.length > 0) result.push({ token, line: index + 1 });
    }
  }

  return result;
}

async function execGit(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export function parseLogOutput(output) {
  return output
    .split('\x1e')
    .map((record) => record.trim().replace(/\0$/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const separator = record.indexOf('\0');
      if (separator === -1) return { sha: record.trim(), message: '' };
      return {
        sha: record.slice(0, separator),
        message: record.slice(separator + 1).replace(/\0$/, ''),
      };
    });
}

function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write('secret-scan: expected exactly one message file path\n');
    return 2;
  }

  const messagePath = argv[0];
  let message;
  try {
    message = readFileSync(messagePath, 'utf8');
  } catch (error) {
    process.stderr.write(`secret-scan: could not read ${messagePath}: ${error?.message ?? error}\n`);
    return 2;
  }

  const { digests } = loadDigests({ root: REPOSITORY_ROOT });
  const findings = scanText(message, digests);
  for (const finding of findings) {
    process.stderr.write(`secret-scan: ${messagePath}:${finding.line} ${finding.digest}\n`);
  }
  return findings.length === 0 ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`secret-scan: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}
