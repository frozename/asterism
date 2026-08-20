import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { isLive, parseCtime } from '../src/core/liveness.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVENESS_URL = pathToFileURL(path.join(ROOT, 'src', 'core', 'liveness.js')).href;

// Spawns one fresh node child with an explicit, minimal env (never a
// process.env spread -- a child that inherited the runner's own TZ would
// measure nothing). Inside that single child, process.env.TZ is reassigned
// between zones before each parse: V8 re-reads the zone from the live env on
// every Date construction rather than caching it at process start, so this
// still exercises a real, fresh-process TZ propagation per (zone, form) pair.
async function parseCtimeAcrossZonesInChild(zoneForms) {
  const script = `
    import { parseCtime } from ${JSON.stringify(LIVENESS_URL)};
    const zoneForms = ${JSON.stringify(zoneForms)};
    const epochs = zoneForms.map(([tz, form]) => {
      process.env.TZ = tz;
      return parseCtime(form, { utc: false });
    });
    process.stdout.write(JSON.stringify(epochs));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { TZ: zoneForms[0][0] },
  });
  return JSON.parse(stdout);
}

// ---- parseCtime ----

test('parseCtime parses the UTC form and matches Date.UTC exactly', () => {
  const expected = Date.UTC(2026, 7, 17, 23, 27, 33) / 1000;
  assert.equal(parseCtime('Mon Aug 17 23:27:33 2026', { utc: true }), expected);
});

test('parseCtime parses the space-padded single-digit day form', () => {
  const expected = Date.UTC(2026, 7, 3, 8, 5, 9) / 1000;
  assert.equal(parseCtime('Mon Aug  3 08:05:09 2026', { utc: true }), expected);
});

test('parseCtime throws RangeError on malformed input, beside a well-formed control', () => {
  assert.throws(() => parseCtime('not a ctime', { utc: true }), RangeError);
  assert.throws(() => parseCtime('Mon Xyz 17 23:27:33 2026', { utc: true }), RangeError);
  assert.doesNotThrow(() => parseCtime('Mon Aug 17 23:27:33 2026', { utc: true }));
});

// ---- RED 2 (synthetic): the TZ trap ----

test(
  'RED 2 (synthetic): local ctime parses within 1s of UTC ctime across timezones, never by string equality',
  async () => {
    const utcForm = 'Mon Aug 17 23:27:33 2026';
    const utcEpoch = parseCtime(utcForm, { utc: true });

    const saoPauloForm = 'Mon Aug 17 20:27:33 2026';
    const tokyoForm = 'Tue Aug 18 08:27:33 2026';

    const [saoPauloEpoch, tokyoEpoch, sameStringTokyoEpoch] = await parseCtimeAcrossZonesInChild([
      ['America/Sao_Paulo', saoPauloForm],
      ['Asia/Tokyo', tokyoForm],
      ['Asia/Tokyo', saoPauloForm],
    ]);

    assert.ok(
      Math.abs(saoPauloEpoch - utcEpoch) <= 1,
      `Sao Paulo epoch ${saoPauloEpoch} should be within 1s of UTC epoch ${utcEpoch}`,
    );
    assert.ok(
      Math.abs(tokyoEpoch - utcEpoch) <= 1,
      `Tokyo epoch ${tokyoEpoch} should be within 1s of UTC epoch ${utcEpoch}`,
    );

    // TZ-took-effect control (must hit): the identical string, parsed under two
    // zones 12 hours apart, must yield epochs exactly 12 hours apart -- proving
    // the env reached the child rather than the child inheriting the runner's zone.
    assert.equal(Math.abs(sameStringTokyoEpoch - saoPauloEpoch), 12 * 60 * 60);

    // String-compare control (must hit): the two rendered forms of the same
    // instant are unequal as strings while their epochs match within 1s --
    // the measured -03 trap in one assertion: string equality matches zero
    // live sessions.
    assert.notEqual(saoPauloForm, utcForm);
    assert.ok(Math.abs(saoPauloEpoch - utcEpoch) <= 1);
  },
);

// ---- isLive ----

test('isLive: pidAlive true and |delta| <= 1 is live', () => {
  assert.equal(isLive({ pidAlive: true, procStartEpoch: 1000, observedStartEpoch: 1000 }), true);
  assert.equal(isLive({ pidAlive: true, procStartEpoch: 1000, observedStartEpoch: 1001 }), true);
});

test('isLive: |delta| > 1 is dead, including the -03 offset control (10800s)', () => {
  assert.equal(isLive({ pidAlive: true, procStartEpoch: 1000, observedStartEpoch: 1002 }), false);
  assert.equal(isLive({ pidAlive: true, procStartEpoch: 1000, observedStartEpoch: 1000 + 10800 }), false);
});

test('isLive: pidAlive false is dead even with equal epochs', () => {
  assert.equal(isLive({ pidAlive: false, procStartEpoch: 1000, observedStartEpoch: 1000 }), false);
});

test('isLive throws TypeError on string epochs instead of coercing (the coercion control)', () => {
  assert.throws(
    () => isLive({ pidAlive: true, procStartEpoch: '1000', observedStartEpoch: 1000 }),
    TypeError,
  );
});
