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

function findUncoveredInstallSites(sites, targets) {
  return sites.filter((site) => !targets.some((target) => site.line.includes(target.matches)));
}

function collectInstallSites(root) {
  const sites = [];
  for (const file of walkFiles(root)) {
    const relPath = path.relative(ROOT, file).split(path.sep).join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (INSTALL_SITE_PATTERN.test(line)) {
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

  assert.deepEqual(
    uncovered.map((site) => `${site.path}:${site.lineNumber}`),
    [],
    `uncovered install sites:\n${uncovered.map((site) => `${site.path}:${site.lineNumber}: ${site.line.trim()}`).join('\n')}`,
  );
});

test('control: an install site with no target fails; the same site with a matching target passes', () => {
  const site = { path: 'src/synthetic.js', lineNumber: 1, line: 'cfgedit.apply(plan);' };

  assert.deepEqual(findUncoveredInstallSites([site], []), [site]);

  const matchingTargets = [{ id: 'tmux-conf', matches: 'cfgedit.apply' }];
  assert.deepEqual(findUncoveredInstallSites([site], matchingTargets), []);

  const nonMatchingTargets = [{ id: 'other', matches: 'LaunchAgents' }];
  assert.deepEqual(findUncoveredInstallSites([site], nonMatchingTargets), [site]);
});
