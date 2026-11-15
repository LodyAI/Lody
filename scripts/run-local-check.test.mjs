import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { withFileIsolation } from './vitest-file-isolation.mjs';
import {
  ELECTRON_TEST_GROUPS,
  isolationFlag,
  runElectronTests,
} from '../apps/electron/scripts/run-tests.mjs';
import path from 'node:path';
import { REST_PACKAGES } from './vitest-rest.config.mjs';
import { runLocalCheck } from './run-local-check.mjs';
import { prepareAdapters, ADAPTERS } from './prepare-acp-adapters.mjs';

import { BOUNDARY_CHECK_SCRIPTS, runBoundaryChecks } from './run-boundary-checks.mjs';
import {
  buildSanitizedTestEnv,
  computeLocalTestWaves,
  stripSessionGitShimFromPath,
} from './run-local-tests.mjs';

function coveredPackages(waves) {
  const candidates = [
    '@lody/components',
    'lody',
    '@lody/electron',
    '@lody/site-docs',
    ...REST_PACKAGES.map((name) => (name === 'ignore' ? '@loro-dev/ignore' : `@lody/${name}`)),
  ];
  const owners = new Map(candidates.map((name) => [name, []]));
  let ranScripts = 0;

  for (const wave of waves) {
    for (const task of wave) {
      const args = task.args;
      if (args.includes('test:scripts')) {
        ranScripts += 1;
        continue;
      }
      if (task.id === 'rest') {
        for (const name of REST_PACKAGES)
          owners.get(name === 'ignore' ? '@loro-dev/ignore' : `@lody/${name}`).push(task.id);
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

test('computeLocalTestWaves bounds hybrid worker pools and scales on workstations', () => {
  const hybridWaves = computeLocalTestWaves({
    cpus: 18,
    perfCores: 6,
    totalMemBytes: 64 * 1024 ** 3,
    env: {},
  });
  assert.equal(hybridWaves.length, 3);
  assert.ok(hybridWaves[0][0].args.includes('--maxWorkers=8'));
  assert.ok(hybridWaves[1][0].args.includes('--maxWorkers=8'));
  assert.ok(hybridWaves[2].find((task) => task.id === 'rest').args.includes('--maxWorkers=8'));
  assert.equal(
    hybridWaves[2].find((task) => task.id === 'electron').env.LODY_ELECTRON_TEST_CONCURRENCY,
    '4'
  );
  const constrained = computeLocalTestWaves({
    cpus: 18,
    perfCores: 6,
    totalMemBytes: 64 * 1024 ** 3,
    env: { LODY_TEST_BUDGET: '4' },
  });
  assert.ok(constrained[0][0].args.includes('--maxWorkers=4'));
  assert.ok(constrained[2].find((task) => task.id === 'rest').args.includes('--maxWorkers=2'));
  assert.equal(
    constrained[2].find((task) => task.id === 'electron').env.LODY_ELECTRON_TEST_CONCURRENCY,
    '2'
  );
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
  assert.equal(workstationWaves.length, 2);
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
  assert.equal(sandboxedDarwinWaves.length, 3);
  assert.ok(sandboxedDarwinWaves[0][0].args.includes('--maxWorkers=8'));

  const lowWaves = computeLocalTestWaves({
    cpus: 8,
    perfCores: 4,
    totalMemBytes: 16 * 1024 ** 3,
    env: {},
  });
  assert.equal(lowWaves.length, 3);
  assert.ok(lowWaves[0][0].args.includes('--maxWorkers=6'));
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

test('local check builds adapters before parallel static checks and waits before tests', async () => {
  const events = [];
  let releaseTypecheck;
  let quickStarted;
  const quick = new Promise((resolve) => {
    quickStarted = resolve;
  });
  const typecheck = new Promise((resolve) => {
    releaseTypecheck = resolve;
  });
  const result = runLocalCheck({
    run: async (args) => {
      const kind = args.includes('prepare:acp-adapters')
        ? 'prepare'
        : args.includes('typecheck')
          ? 'types'
          : args.includes('check:quick')
            ? 'quick'
            : 'tests';
      events.push(kind);
      if (kind === 'types') return typecheck;
      if (kind === 'quick') quickStarted();
      return true;
    },
  });
  await quick;
  assert.deepEqual(events, ['prepare', 'types', 'quick']);
  releaseTypecheck(true);
  assert.equal(await result, true);
  assert.deepEqual(events, ['prepare', 'types', 'quick', 'tests']);
  for (const failedStage of ['prepare:acp-adapters', 'typecheck', 'check:quick']) {
    let tested = false;
    assert.equal(
      await runLocalCheck({
        run: async (args) => {
          if (args.includes('scripts/run-local-tests.mjs')) tested = true;
          return !args.includes(failedStage);
        },
      }),
      false
    );
    assert.equal(tested, false);
  }
});

test('ACP preparation reuses complete output and invalidates source, lock and missing artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-adapter-cache-'));
  try {
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'synthetic lock');
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'synthetic workspace');
    for (const name of ADAPTERS) {
      const directory = path.join(root, 'packages', `acp-extension-${name}`);
      await mkdir(path.join(directory, 'src'), { recursive: true });
      await writeFile(path.join(directory, 'src/index.js'), 'export const value = 1;');
    }
    await symlink(
      'missing-fixture-target',
      path.join(root, 'packages/acp-extension-codex/dangling-config')
    );
    const build = async (name) => {
      if (name === 'grok') return;
      const directory = path.join(root, 'packages', `acp-extension-${name}`, 'dist');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'index.js'), 'synthetic output');
      await writeFile(path.join(directory, 'index.d.ts'), 'synthetic types');
    };
    const prepare = () => prepareAdapters({ root, build });
    assert.deepEqual((await prepare()).sort(), [...ADAPTERS].sort());
    assert.deepEqual(await prepare(), []);
    await writeFile(
      path.join(root, 'packages/acp-extension-codex/src/index.js'),
      'export const value = 2;'
    );
    assert.deepEqual(await prepare(), ['codex']);
    await rm(path.join(root, 'packages/acp-extension-dsh/dist/index.d.ts'));
    assert.deepEqual(await prepare(), ['dsh']);
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'changed lock');
    assert.deepEqual((await prepare()).sort(), [...ADAPTERS].sort());
    await mkdir(path.join(root, 'packages/acp-extension-core/src'), { recursive: true });
    await writeFile(
      path.join(root, 'packages/acp-extension-core/src/index.ts'),
      'export type Command = string;'
    );
    assert.deepEqual((await prepare()).sort(), [...ADAPTERS].sort());
    await writeFile(
      path.join(root, 'packages/acp-extension-core/src/index.ts'),
      'export type Command = number;'
    );
    assert.deepEqual((await prepare()).sort(), [...ADAPTERS].sort());
    const stampPath = path.join(root, 'node_modules/.cache/lody-acp-adapters-stamp.json');
    await writeFile(path.join(root, 'packages/acp-extension-codex/src/index.js'), 'changed again');
    await assert.rejects(
      prepareAdapters({
        root,
        build: async () => {
          throw new Error('compile failed');
        },
      }),
      /compile failed/
    );
    await assert.rejects(readFile(stampPath), { code: 'ENOENT' });
    assert.deepEqual((await prepare()).sort(), [...ADAPTERS].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local test plan covers every package with a test script exactly once', () => {
  const actual = [];
  for (const parent of ['packages', 'apps']) {
    for (const entry of readdirSync(new URL(`../${parent}/`, import.meta.url), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.name.startsWith('acp-extension-')) continue;
      try {
        const pkg = JSON.parse(
          readFileSync(new URL(`../${parent}/${entry.name}/package.json`, import.meta.url), 'utf8')
        );
        if (pkg.scripts?.test) actual.push(pkg.name);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  const plan = coveredPackages(computeLocalTestWaves({ cpus: 8, perfCores: 4, env: {} }));
  assert.deepEqual(
    [...plan.owners.keys()].filter((name) => name !== '@lody/site-docs').sort(),
    actual.sort()
  );
});

test('module-mock suites stay isolated and preserve the package test exclusions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-test-isolation-'));
  try {
    await mkdir(path.join(directory, 'test'));
    await writeFile(path.join(directory, 'test/pure.test.ts'), 'test("pure", () => {});');
    const options = { exclude: ['test/*.browser.test.ts'], testTimeout: 180000 };
    assert.equal(withFileIsolation(directory, options).isolate, false);
    await writeFile(path.join(directory, 'test/mock.test.ts'), 'vi.mock("crypto");');
    const partitioned = withFileIsolation(directory, options);
    const [shared, isolated] = partitioned.projects;
    assert.equal(shared.test.isolate, false);
    assert.deepEqual(shared.test.exclude, ['test/*.browser.test.ts', 'test/mock.test.ts']);
    assert.equal(isolated.test.isolate, true);
    assert.deepEqual(isolated.test.include, ['test/mock.test.ts']);
    assert.equal(partitioned.testTimeout, 180000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Electron groups include all source tests once and settle failures across groups', async () => {
  const groups = ELECTRON_TEST_GROUPS;
  const files = groups.flatMap((group) => group.files);
  assert.equal(new Set(files).size, files.length);
  const source = readdirSync(new URL('../apps/electron/src/', import.meta.url), {
    recursive: true,
  });
  assert.deepEqual(
    files.filter((file) => file.startsWith('src/')).sort(),
    source
      .filter((file) => file.endsWith('.test.mjs'))
      .map((file) => `src/${file.replaceAll(path.sep, '/')}`)
      .sort()
  );
  assert.equal(isolationFlag('22.23.4'), '--experimental-test-isolation=none');
  assert.equal(isolationFlag('24.22.1'), '--test-isolation=none');
  const completed = [];
  assert.equal(
    await runElectronTests({
      run: async (group) => {
        completed.push(group.id);
        return group.id !== 'desktop';
      },
    }),
    false
  );
  assert.deepEqual(completed.sort(), groups.map((group) => group.id).sort());
});
