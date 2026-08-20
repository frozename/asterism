import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { walkFiles } from '../harness/structural.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const UNINSTALL_TARGETS_PATH = path.join(SRC_DIR, 'io', 'uninstall-targets.js');

const INSTALL_SITE_PATTERN = /cfgedit\.|LaunchAgents|\.plist\b/;

// A quoted import/require specifier can contain the collector pattern as a
// harmless side effect of naming the module that defines it -- strip only
// the quoted text of `from '...'` / `import('...')` / `import '...'` /
// `require('...')`, never the rest of the line, so a real call site on the
// same line still counts as a site.
const IMPORT_SPECIFIER_STRIP_PATTERNS = [
  /(\bfrom\s*)(['"])[^'"]*\2/g,
  /(\bimport\s*\(\s*)(['"])[^'"]*\2/g,
  /(\bimport\s+)(['"])[^'"]*\2/g,
  /(\brequire\s*\(\s*)(['"])[^'"]*\2/g,
];

function stripImportSpecifiers(line) {
  return IMPORT_SPECIFIER_STRIP_PATTERNS.reduce(
    (stripped, pattern) => stripped.replace(pattern, (_match, prefix, quote) => `${prefix}${quote}${quote}`),
    line,
  );
}

function findUncoveredInstallSites(sites, targets) {
  return sites.filter((site) => !targets.some((target) => site.line.includes(target.matches)));
}

function collectInstallSites(root) {
  const sites = [];
  for (const file of walkFiles(root)) {
    const relPath = path.relative(ROOT, file).split(path.sep).join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (INSTALL_SITE_PATTERN.test(stripImportSpecifiers(line))) {
        sites.push({ path: relPath, lineNumber: index + 1, line });
      }
    });
  }
  return sites;
}

async function loadUninstallTargets() {
  if (!existsSync(UNINSTALL_TARGETS_PATH)) return [];
  const mod = await import(pathToFileURL(UNINSTALL_TARGETS_PATH).href);
  return mod.UNINSTALL_TARGETS ?? [];
}

test('every install site under src/ has a matching uninstall target', async () => {
  assert.ok(existsSync(SRC_DIR), 'src/ is missing; uninstall coverage cannot be checked');

  const sites = collectInstallSites(SRC_DIR);
  const targets = await loadUninstallTargets();
  const uncovered = findUncoveredInstallSites(sites, targets);

  // A zero-site sweep proves nothing on its own -- the registry's own
  // `matches` lines are themselves install sites, so a healthy sweep must
  // find at least that many.
  assert.ok(sites.length >= 1, 'expected at least one install site (the registry self-covers its own matches lines)');

  assert.deepEqual(
    uncovered.map((site) => `${site.path}:${site.lineNumber}`),
    [],
    `uncovered install sites:\n${uncovered.map((site) => `${site.path}:${site.lineNumber}: ${site.line.trim()}`).join('\n')}`,
  );
});

test('stripImportSpecifiers skips an import specifier but still catches a real call site on the same line', () => {
  const namespaceImport = 'import * as cfgedit from \'../io/cfgedit.js\';';
  assert.equal(INSTALL_SITE_PATTERN.test(stripImportSpecifiers(namespaceImport)), false);

  const dynamicImport = "await import('../io/cfgedit.js')";
  assert.equal(INSTALL_SITE_PATTERN.test(stripImportSpecifiers(dynamicImport)), false);

  const realCall = 'cfgedit.apply(plan);';
  assert.equal(INSTALL_SITE_PATTERN.test(stripImportSpecifiers(realCall)), true);

  const mixedLine = "cfgedit.apply(plan); // from './x.js'";
  assert.equal(INSTALL_SITE_PATTERN.test(stripImportSpecifiers(mixedLine)), true);
});

test('registry: UNINSTALL_TARGETS is frozen, ids unique, matches non-empty, kinds allowed; LaunchAgents and .plist entries pre-exist and are report-only', async () => {
  const targets = await loadUninstallTargets();
  const ALLOWED_KINDS = new Set(['managed-block', 'owned-file', 'report-only']);

  assert.ok(Object.isFrozen(targets));
  assert.ok(targets.length > 0);

  const ids = new Set();
  for (const target of targets) {
    assert.ok(!ids.has(target.id), `duplicate uninstall target id "${target.id}"`);
    ids.add(target.id);
    assert.equal(typeof target.matches, 'string');
    assert.ok(target.matches.length > 0, `${target.id} has an empty matches`);
    assert.ok(ALLOWED_KINDS.has(target.kind), `${target.id} has an unexpected kind "${target.kind}"`);
  }

  const launchAgentsTarget = targets.find((target) => target.matches === 'LaunchAgents');
  assert.ok(launchAgentsTarget, 'expected a target with matches "LaunchAgents"');
  assert.equal(launchAgentsTarget.kind, 'report-only');

  const plistTarget = targets.find((target) => target.matches === '.plist');
  assert.ok(plistTarget, 'expected a target with matches ".plist"');
  assert.equal(plistTarget.kind, 'report-only');
});

test('control: an install site with no target fails; the same site with a matching target passes', () => {
  const site = { path: 'src/synthetic.js', lineNumber: 1, line: 'cfgedit.apply(plan);' };

  assert.deepEqual(findUncoveredInstallSites([site], []), [site]);

  const matchingTargets = [{ id: 'tmux-conf', matches: 'cfgedit.apply' }];
  assert.deepEqual(findUncoveredInstallSites([site], matchingTargets), []);

  const nonMatchingTargets = [{ id: 'other', matches: 'LaunchAgents' }];
  assert.deepEqual(findUncoveredInstallSites([site], nonMatchingTargets), [site]);
});
