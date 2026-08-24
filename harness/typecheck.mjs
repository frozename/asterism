#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CI_WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const PINNED_VERSIONS_PATTERN = /npm install[^\n]*\btypescript@(\S+)\s+@types\/node@(\S+)/;
const TEMP_PREFIX_TEMPLATE = path.join(os.tmpdir(), 'asterism-typecheck-');

// The `types` CI job installs these into a disposable runner checkout; this
// repo has no runtime dependencies and test/no-deps.test.mjs fails if either
// version ever lands in the tree. Read from ci.yml so this script cannot pin
// a version CI has moved past.
const FALLBACK_TYPESCRIPT_VERSION = '7.0.2';
const FALLBACK_TYPES_NODE_VERSION = '26.2.0';

export function parsePinnedVersions(ciWorkflowText) {
  const match = ciWorkflowText.match(PINNED_VERSIONS_PATTERN);
  if (match === null) return null;
  return { typescript: match[1], typesNode: match[2] };
}

function resolvePinnedVersions() {
  let ciWorkflowText;
  try {
    ciWorkflowText = readFileSync(CI_WORKFLOW_PATH, 'utf8');
  } catch (error) {
    process.stderr.write(
      `typecheck: could not read ${CI_WORKFLOW_PATH} (${error?.message ?? error}); falling back to typescript@${FALLBACK_TYPESCRIPT_VERSION} @types/node@${FALLBACK_TYPES_NODE_VERSION}\n`,
    );
    return { typescript: FALLBACK_TYPESCRIPT_VERSION, typesNode: FALLBACK_TYPES_NODE_VERSION };
  }

  const parsed = parsePinnedVersions(ciWorkflowText);
  if (parsed === null) {
    process.stderr.write(
      `typecheck: could not find pinned versions in ${CI_WORKFLOW_PATH}; falling back to typescript@${FALLBACK_TYPESCRIPT_VERSION} @types/node@${FALLBACK_TYPES_NODE_VERSION}\n`,
    );
    return { typescript: FALLBACK_TYPESCRIPT_VERSION, typesNode: FALLBACK_TYPES_NODE_VERSION };
  }
  return parsed;
}

// The install prefix is always a fresh OS-temp directory, never a path under
// ROOT -- that is the one property standing between this script and the
// node_modules pollution test/no-deps.test.mjs exists to catch. Kept as its
// own export so a test can pin the property without paying for a real
// network install.
export async function createTempPrefix() {
  return mkdtemp(TEMP_PREFIX_TEMPLATE);
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', (error) => resolve({ status: null, error }));
    child.on('close', (status) => resolve({ status, error: null }));
  });
}

export async function runTypecheck() {
  const { typescript, typesNode } = resolvePinnedVersions();
  let prefix = null;

  try {
    prefix = await createTempPrefix();

    const install = await run('npm', [
      'install',
      '--prefix',
      prefix,
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      `typescript@${typescript}`,
      `@types/node@${typesNode}`,
    ]);

    if (install.error) {
      process.stderr.write(`typecheck: failed to launch npm install: ${install.error.message}\n`);
      return 1;
    }
    if (install.status !== 0) {
      process.stderr.write(`typecheck: npm install exited ${install.status}\n`);
      return install.status ?? 1;
    }

    const tscBin = path.join(prefix, 'node_modules', '.bin', 'tsc');
    const typeRoots = path.join(prefix, 'node_modules', '@types');
    const tsc = await run(tscBin, ['--noEmit', '-p', path.join(ROOT, 'tsconfig.json'), '--typeRoots', typeRoots], {
      cwd: ROOT,
    });

    if (tsc.error) {
      process.stderr.write(`typecheck: failed to launch tsc: ${tsc.error.message}\n`);
      return 1;
    }
    return tsc.status ?? 1;
  } finally {
    if (prefix !== null) {
      try {
        await rm(prefix, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`typecheck: warning: failed to remove temp prefix ${prefix}: ${error?.message ?? error}\n`);
      }
    }
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await runTypecheck();
  } catch (error) {
    process.stderr.write(`typecheck: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}
