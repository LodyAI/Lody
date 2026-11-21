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
import { runLocalCheck, planLocalCheck } from './run-local-check.mjs';
import { collectLocalScope } from './local-check-scope.mjs';
import {
  prepareTypecheck as prepareSiteTypecheck,
  GENERATED_FILES,
} from '../site-docs/scripts/prepare-typecheck.mjs';
import { runTypechecks as runElectronTypechecks } from '../apps/electron/scripts/run-typecheck.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    '@lody/client-e2ee',
    '@lody/mobile-capacitor',
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
    '3'
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
  assert.equal(BOUNDARY_CHECK_SCRIPTS.length, 10);
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

// These fixtures exercise the same Git inventory and CI selector as the local
// entry point; no repository tests or network requests are launched here.
test('affected scope includes committed, staged, working and untracked paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-affected-'));
  const git = (args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Synthetic Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: buildSanitizedTestEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  try {
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture","private":true}');
    const manifests = [
      ['shared', '@lody/shared', {}],
      ['electron', '@lody/electron', { '@lody/shared': 'workspace:*' }],
      ['ui', '@lody/ui', {}],
      [
        'components',
        '@lody/components',
        { '@lody/ui': 'workspace:*', 'acp-extension-dsh': 'workspace:*' },
      ],
    ];
    for (const [dir, name, dependencies] of manifests) {
      await mkdir(path.join(root, 'packages', dir, 'src'), { recursive: true });
      await writeFile(
        path.join(root, 'packages', dir, 'package.json'),
        JSON.stringify({
          name,
          dependencies,
          scripts: { test: 'vitest run', typecheck: 'tsgo --noEmit' },
        })
      );
      await writeFile(path.join(root, 'packages', dir, 'src/index.ts'), 'export const value = 1;');
    }
    git(['init', '-q']);
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']);
    assert.equal(collectLocalScope({ root, git }).mode, 'skip-tests');
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await writeFile(path.join(root, 'packages/shared/src/index.ts'), 'export const value = 2;');
    git(['add', '.']);
    git(['commit', '-qm', 'committed source']);
    await writeFile(path.join(root, 'packages/ui/src/index.ts'), 'export const value = 3;');
    await writeFile(
      path.join(root, 'packages/electron/src/staged.test.ts'),
      'synthetic staged test'
    );
    git(['add', 'packages/electron/src/staged.test.ts']);
    await writeFile(
      path.join(root, 'packages/shared/src/new file.test.ts'),
      'synthetic untracked test'
    );
    // Reversing a committed edit locally must still include its committed path.
    await writeFile(path.join(root, 'packages/shared/src/index.ts'), 'export const value = 1;');
    const scope = collectLocalScope({ root, git });
    assert.equal(scope.mode, 'affected');
    assert.deepEqual(scope.changedFiles, [
      'packages/electron/src/staged.test.ts',
      'packages/shared/src/index.ts',
      'packages/shared/src/new file.test.ts',
      'packages/ui/src/index.ts',
    ]);
    assert.deepEqual(scope.testPackages, [
      '@lody/components',
      '@lody/electron',
      '@lody/shared',
      '@lody/ui',
    ]);
    assert.deepEqual(scope.adapterPackages, ['acp-extension-dsh']);
    const plan = planLocalCheck(scope);
    assert.ok(plan.prepare.includes('acp-extension-dsh'));
    assert.ok(plan.static[0].includes('--no-sort'));
    const waves = computeLocalTestWaves({ cpus: 8, perfCores: 4, env: {}, scope });
    const tasks = waves.flat();
    assert.deepEqual(
      tasks.map((t) => t.id),
      ['components', 'rest', 'electron']
    );
    assert.ok(tasks.find((t) => t.id === 'rest').args.includes('--project=shared:*'));
    assert.ok(tasks.find((t) => t.id === 'rest').args.includes('--project=ui:*'));
    assert.ok(!tasks.some((t) => t.id === 'cli'));
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'changed lock');
    assert.equal(collectLocalScope({ root, git }).mode, 'full');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('affected checks fail open on Git errors and skip all work for docs-only scope', async () => {
  const failed = collectLocalScope({
    git: () => {
      throw Object.assign(new Error('git unavailable'), { code: 'EACCES' });
    },
  });
  assert.equal(failed.mode, 'full');
  const unrelated = collectLocalScope({
    git: (args) => {
      if (args[0] === 'merge-base')
        throw Object.assign(new Error('unrelated history'), { status: 1 });
      return 'existing-ref\n';
    },
  });
  assert.equal(unrelated.mode, 'full');
  const commands = [];
  assert.equal(
    await runLocalCheck({
      affected: true,
      scope: failed,
      run: async (args) => {
        commands.push(args);
        return true;
      },
    }),
    true
  );
  assert.deepEqual(commands, [
    planLocalCheck().prepare,
    ...planLocalCheck().static,
    planLocalCheck().tests,
  ]);
  const scope = {
    mode: 'skip-tests',
    reason: 'docs_only',
    runTests: false,
    runTypecheck: false,
    runCheckQuick: false,
    prepareAcpAdapters: false,
    testPackages: [],
    typecheckPackages: [],
  };
  assert.equal(
    await runLocalCheck({
      affected: true,
      scope,
      run: () => {
        throw new Error('docs-only check launched work');
      },
    }),
    true
  );
  assert.deepEqual(computeLocalTestWaves({ scope }), []);
  const cli = {
    ...scope,
    mode: 'affected',
    runTests: true,
    runTypecheck: true,
    runCheckQuick: true,
    prepareAcpAdapters: true,
    testPackages: ['lody'],
    typecheckPackages: ['lody'],
  };
  assert.deepEqual(planLocalCheck(cli).prepare, ['--filter', 'lody', 'prepare:acp-adapters']);
  assert.deepEqual(
    computeLocalTestWaves({ scope: cli })
      .flat()
      .map((task) => task.id),
    ['cli']
  );
});

test('site-docs typecheck cache invalidates inputs and every generated output, and clears failures', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lody-site-cache-'));
  const root = path.join(workspace, 'site-docs');
  try {
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await mkdir(path.join(root, 'content'), { recursive: true });
    await writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'synthetic lock');
    await writeFile(path.join(root, 'package.json'), '{}');
    await writeFile(path.join(root, 'content/guide.mdx'), 'first content');
    const generate = async () => {
      for (const file of [...GENERATED_FILES, '.source/server.ts', '.source/browser.ts']) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), 'synthetic generated output');
      }
    };
    const prepare = () => prepareSiteTypecheck({ root, generate });
    assert.equal(await prepare(), true);
    assert.equal(await prepare(), false);
    await writeFile(path.join(root, 'content/guide.mdx'), 'edited content');
    assert.equal(await prepare(), true);
    for (const file of [...GENERATED_FILES, '.source/browser.ts']) {
      await rm(path.join(root, file));
      assert.equal(await prepare(), true, `missing ${file} must regenerate`);
    }
    assert.equal(await prepare(), false);
    await writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'new dependency lock');
    assert.equal(await prepare(), true);
    await writeFile(path.join(root, 'content/guide.mdx'), 'failing content');
    await assert.rejects(
      prepareSiteTypecheck({
        root,
        generate: async () => {
          await generate();
          throw new Error('generator failed');
        },
      }),
      /generator failed/
    );
    const stamp = path.join(workspace, 'node_modules/.cache/lody-site-docs-typecheck-stamp.json');
    await assert.rejects(readFile(stamp), { code: 'ENOENT' });
    assert.equal(await prepare(), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Electron native loader resolves TypeScript paths and non-erasable syntax without tsx', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-native-loader-'));
  try {
    await mkdir(path.join(root, 'directory'));
    await mkdir(path.join(root, 'packages/shared/src'), { recursive: true });
    await writeFile(
      path.join(root, 'packages/shared/src/type.ts'),
      'export type OnlyType = number;'
    );
    await writeFile(
      path.join(root, 'packages/shared/src/legacy.ts'),
      "import { OnlyType } from './type'; export const legacy: OnlyType = 0;"
    );
    await writeFile(path.join(root, 'real.js'), 'export const real = 7;');
    await writeFile(path.join(root, 'real.ts'), 'export const real = 999;');
    await writeFile(path.join(root, 'value.ts'), 'export const value: number = 2;');
    await writeFile(path.join(root, 'index.ts'), 'export const directory: number = 4;');
    await writeFile(path.join(root, 'data.json'), '{"value":0}');
    await writeFile(path.join(root, 'plain.tsx'), 'export const plain: number = 3;');
    await writeFile(path.join(root, 'directory/index.ts'), "export { directory } from '..';");
    await writeFile(
      path.join(root, 'types.generated.ts'),
      'export class Box { constructor(readonly number: number) {} }'
    );
    await writeFile(
      path.join(root, 'entry.ts'),
      "import {legacy} from './packages/shared/src/legacy'; import data from './data.json'; import {value} from './value.js'; import {plain} from './plain'; import {directory} from './directory'; import {Box} from './types.generated'; import {real} from './real.js'; export const result = legacy + data.value + value + plain + directory + new Box(5).number + real;"
    );
    await writeFile(
      path.join(root, 'main.mjs'),
      "import { createRequire } from 'node:module'; import { result } from './entry'; const required = createRequire(import.meta.url)('./entry'); if (required.result !== result) throw new Error('require and import disagree'); process.stdout.write(String(result));"
    );
    const loader = fileURLToPath(
      new URL('../apps/electron/scripts/node-test-ts-resolve.mjs', import.meta.url)
    );
    const output = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--import', loader, path.join(root, 'main.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    assert.equal(output.trim(), '21');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Electron typecheck joins both configurations before reporting failure', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const seen = [];
  const result = runElectronTypechecks({
    run: async (config) => {
      seen.push(config);
      return config === 'tsconfig.node.json' ? held : false;
    },
  });
  assert.deepEqual(seen, ['tsconfig.node.json', 'tsconfig.web.json']);
  release(true);
  assert.equal(await result, false);
});
