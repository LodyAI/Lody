import assert from 'node:assert/strict';
import test from 'node:test';

import { BOUNDARY_CHECK_SCRIPTS, runBoundaryChecks } from './run-boundary-checks.mjs';
import {
  buildSanitizedTestEnv,
  computeLocalTestWaves,
  stripSessionGitShimFromPath,
} from './run-local-tests.mjs';

function coveredPackages(waves) {
  const candidates = ['@lody/components', 'lody', '@lody/electron', '@lody/shared', '@lody/ui'];
  const owners = new Map(candidates.map((name) => [name, []]));
  let ranScripts = 0;

  for (const wave of waves) {
    for (const task of wave) {
      const args = task.args;
      if (args.includes('test:scripts')) {
        ranScripts += 1;
        continue;
      }
      const positive = [];
      const negative = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== '--filter') continue;
        const filter = args[index + 1];
        if (filter.startsWith('!')) negative.push(filter.slice(1));
        else positive.push(filter);
      }
      for (const pkg of candidates) {
        const matched = positive.length > 0 ? positive.includes(pkg) : !negative.includes(pkg);
        if (matched) owners.get(pkg).push(task.id);
      }
    }
  }
  return { owners, ranScripts };
}

test('stripSessionGitShimFromPath removes session git shims while preserving system PATH entries', () => {
  const cleaned = stripSessionGitShimFromPath(
    '/opt/homebrew/bin:/tmp/.lody/gh-session-bin/abc123:/usr/bin:/bin',
    ':'
  );
  assert.equal(cleaned, '/opt/homebrew/bin:/usr/bin:/bin');

  const winCleaned = stripSessionGitShimFromPath(
    'C:\\Users\\dev\\.lody\\gh-session-bin\\abc;C:\\Program Files\\Git\\cmd',
    ';'
  );
  assert.equal(winCleaned, 'C:\\Program Files\\Git\\cmd');
});

test('buildSanitizedTestEnv disables git gpgSign by default without clobbering explicit git config', () => {
  const sanitized = buildSanitizedTestEnv({ PATH: '/tmp/.lody/gh-session-bin/1:/usr/bin' }, ':');
  assert.equal(sanitized.PATH, '/usr/bin');
  assert.equal(sanitized.GIT_CONFIG_COUNT, '1');
  assert.equal(sanitized.GIT_CONFIG_KEY_0, 'commit.gpgSign');
  assert.equal(sanitized.GIT_CONFIG_VALUE_0, 'false');

  const preserved = buildSanitizedTestEnv({
    PATH: '/usr/bin',
    GIT_CONFIG_COUNT: '2',
  });
  assert.equal(preserved.GIT_CONFIG_COUNT, '2');
  assert.equal(preserved.GIT_CONFIG_KEY_0, undefined);
});

test('computeLocalTestWaves caps workers to performance cores on hybrid laptops and scales on workstations', () => {
  const hybridWaves = computeLocalTestWaves({
    cpus: 18,
    perfCores: 6,
    totalMemBytes: 64 * 1024 ** 3,
    env: {},
  });
  assert.equal(hybridWaves.length, 4);
  assert.ok(hybridWaves[0][1].args.includes('--maxWorkers=6'));
  assert.ok(hybridWaves[1][0].args.includes('--maxWorkers=6'));
  const hybridCoverage = coveredPackages(hybridWaves);
  assert.equal(hybridCoverage.ranScripts, 1);
  for (const [pkg, ids] of hybridCoverage.owners) {
    assert.deepEqual(ids.length, 1, `${pkg} covered by [${ids.join(', ')}]`);
  }

  const workstationWaves = computeLocalTestWaves({
    cpus: 32,
    perfCores: null,
    platform: 'linux',
    totalMemBytes: 128 * 1024 ** 3,
    env: {},
  });
  assert.equal(workstationWaves.length, 3);
  const workstationCoverage = coveredPackages(workstationWaves);
  assert.equal(workstationCoverage.ranScripts, 1);
  for (const [pkg, ids] of workstationCoverage.owners) {
    assert.deepEqual(ids.length, 1, `${pkg} covered by [${ids.join(', ')}]`);
  }

  const sandboxedDarwinWaves = computeLocalTestWaves({
    cpus: 18,
    perfCores: null,
    platform: 'darwin',
    totalMemBytes: 64 * 1024 ** 3,
    env: {},
  });
  assert.equal(sandboxedDarwinWaves.length, 4);
  assert.ok(sandboxedDarwinWaves[0][1].args.includes('--maxWorkers=8'));

  const lowWaves = computeLocalTestWaves({
    cpus: 8,
    perfCores: 4,
    totalMemBytes: 16 * 1024 ** 3,
    env: {},
  });
  assert.equal(lowWaves.length, 4);
  assert.ok(lowWaves[0][1].args.includes('--maxWorkers=4'));
  const lowCoverage = coveredPackages(lowWaves);
  assert.equal(lowCoverage.ranScripts, 1);
  for (const [pkg, ids] of lowCoverage.owners) {
    assert.deepEqual(ids.length, 1, `${pkg} covered by [${ids.join(', ')}]`);
  }
});

test('runBoundaryChecks preserves deterministic script order and reports non-zero exits', async () => {
  assert.equal(BOUNDARY_CHECK_SCRIPTS.length, 9);
  const passResult = await runBoundaryChecks({
    scripts: ['a.mjs', 'b.mjs', 'c.mjs'],
    concurrency: 2,
    spawnCheck: async (script) => ({
      script,
      code: 0,
      signal: null,
      stdout: `ok:${script}\n`,
      stderr: '',
    }),
  });
  assert.equal(passResult.ok, true);
  assert.deepEqual(
    passResult.results.map((item) => item.stdout.trim()),
    ['ok:a.mjs', 'ok:b.mjs', 'ok:c.mjs']
  );

  const failResult = await runBoundaryChecks({
    scripts: ['a.mjs', 'b.mjs'],
    concurrency: 2,
    spawnCheck: async (script) => ({
      script,
      code: script === 'b.mjs' ? 1 : 0,
      signal: null,
      stdout: '',
      stderr: script === 'b.mjs' ? 'violation' : '',
    }),
  });
  assert.equal(failResult.ok, false);
  assert.deepEqual(
    failResult.failed.map((item) => item.script),
    ['b.mjs']
  );
});
