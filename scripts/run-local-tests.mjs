#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELATED_FLAGS, relatedTestFiles } from '../.github/scripts/related-test-files.mjs';
import { collectLocalScope } from './local-check-scope.mjs';
import { REST_PACKAGES } from './vitest-rest.config.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function detectPerformanceCores() {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.logicalcpu'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function stripSessionGitShimFromPath(pathValue, delimiter = path.delimiter) {
  if (!pathValue) return '';
  return String(pathValue)
    .split(delimiter)
    .filter((segment) => {
      const normalized = segment.replaceAll('\\', '/');
      return !normalized.includes('/.lody/gh-session-bin');
    })
    .join(delimiter);
}

export function buildSanitizedTestEnv(baseEnv = process.env, delimiter = path.delimiter) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH' && typeof env[key] === 'string') {
      env[key] = stripSessionGitShimFromPath(env[key], delimiter);
    }
  }
  if (env.GIT_CONFIG_COUNT === undefined) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'commit.gpgSign';
    env.GIT_CONFIG_VALUE_0 = 'false';
  }
  return env;
}

export function computeLocalTestWaves({
  scope = null,
  related = null,
  cpus = availableParallelism(),
  perfCores = detectPerformanceCores(),
  platform = process.platform,
  totalMemBytes = totalmem(),
  env = process.env,
} = {}) {
  const forcedBudget = Number.parseInt(String(env.LODY_TEST_BUDGET ?? ''), 10);
  const memGiB = totalMemBytes / 1024 ** 3;
  // After splitting large suites, efficiency cores can contribute throughput
  // without owning an entire long tail. Count them at half a performance core;
  // per-suite pools remain capped at eight and memory still limits the budget.
  const effectiveCores =
    perfCores && perfCores < cpus
      ? perfCores + Math.floor((cpus - perfCores) / 2)
      : platform === 'darwin'
        ? Math.max(4, Math.min(8, Math.floor(cpus * 0.5)))
        : Math.max(4, cpus - 2);
  const memBudget = Math.max(4, Math.floor(memGiB / 2.5));
  const budget =
    Number.isFinite(forcedBudget) && forcedBudget >= 4
      ? Math.min(24, forcedBudget)
      : Math.min(24, effectiveCores, memBudget);

  const scriptsTask = {
    id: 'scripts',
    command: 'corepack',
    args: ['pnpm', 'test:scripts'],
  };
  const electronTask = {
    id: 'electron',
    command: 'corepack',
    args: ['pnpm', '--filter', '@lody/electron', 'run', 'test'],
    env: {
      LODY_ELECTRON_TEST_CONCURRENCY: String(Math.max(2, Math.min(3, Math.floor(budget / 3)))),
    },
  };

  const clientTasks = ['@lody/client-e2ee', '@lody/mobile-capacitor'].map((name) => ({
    id: name === '@lody/mobile-capacitor' ? 'mobile' : 'client-e2ee',
    command: 'corepack',
    args: ['pnpm', '--filter', name, 'run', 'test'],
  }));

  const siteDocsTask = {
    id: 'site-docs',
    command: 'corepack',
    args: ['pnpm', '--filter', '@lody/site-docs', 'run', 'test'],
  };
  const makeRestTask = (restWorkers) => ({
    id: 'rest',
    command: process.execPath,
    args: [
      'packages/shared/node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'scripts/vitest-rest.config.mjs',
      `--maxWorkers=${restWorkers}`,
    ],
  });

  const makeComponentsTask = (workers) => ({
    id: 'components',
    command: 'corepack',
    args: ['pnpm', '--filter', '@lody/components', 'run', 'test', `--maxWorkers=${workers}`],
  });

  const makeCliTask = (workers) => ({
    id: 'cli',
    command: 'corepack',
    args: ['pnpm', '--filter', 'lody', 'run', 'test', `--maxWorkers=${workers}`],
  });

  // Rest's reusable Vitest workers and Electron's bounded groups share the last
  // wave. Leave capacity for the script/docs tasks alongside their worker pools.
  const restWorkers = Math.max(
    2,
    Math.min(8, budget - Number(electronTask.env.LODY_ELECTRON_TEST_CONCURRENCY) - 1)
  );

  const select = (waves) => selectAffectedTestWaves(waves, scope, related);

  if (budget >= 16 && effectiveCores >= 16) {
    const dedicatedWorkers = Math.min(8, Math.floor(budget / 2));
    return select([
      [makeComponentsTask(dedicatedWorkers), makeCliTask(dedicatedWorkers)],
      [scriptsTask, siteDocsTask, makeRestTask(restWorkers), electronTask, ...clientTasks],
    ]);
  }

  const suiteWorkers = Math.max(2, Math.min(8, budget));
  return select([
    [makeComponentsTask(suiteWorkers)],
    [makeCliTask(suiteWorkers)],
    [scriptsTask, siteDocsTask, makeRestTask(restWorkers), electronTask, ...clientTasks],
  ]);
}

const VITEST_PACKAGE_DIRECTORIES = { components: 'packages/components', cli: 'apps/cli' };

/**
 * Rewrite a Vitest suite task to `vitest related` over the changed modules.
 * Package tasks run from their own directory, so paths are made relative to it.
 */
function relatedTask(task, related) {
  if (task.id === 'rest') {
    const [entry, , ...rest] = task.args;
    return { ...task, args: [entry, 'related', ...RELATED_FLAGS, ...rest, ...related] };
  }
  // Package tasks are `pnpm --filter <name> run test ...flags`.
  const directory = VITEST_PACKAGE_DIRECTORIES[task.id];
  const name = task.args[task.args.indexOf('--filter') + 1];
  const flags = task.args.slice(task.args.indexOf('test') + 1);
  return {
    ...task,
    args: [
      'pnpm',
      '--filter',
      name,
      'exec',
      'vitest',
      'related',
      ...RELATED_FLAGS,
      ...flags,
      ...related.map((file) => path.posix.relative(directory, file)),
    ],
  };
}

export function selectAffectedTestWaves(waves, scope, related = null) {
  if (!scope || !['affected', 'skip-tests'].includes(scope.mode)) return waves;
  if (!scope.runTests) return [];
  if (!Array.isArray(scope.testPackages) || scope.testPackages.length === 0) return waves;
  const selected = new Set(scope.testPackages);
  const narrow = (task) =>
    related?.length && (task.id === 'rest' || task.id in VITEST_PACKAGE_DIRECTORIES)
      ? relatedTask(task, related)
      : task;
  const dedicated = {
    components: '@lody/components',
    cli: 'lody',
    electron: '@lody/electron',
    'site-docs': '@lody/site-docs',
    'client-e2ee': '@lody/client-e2ee',
    mobile: '@lody/mobile-capacitor',
  };
  const rest = REST_PACKAGES.filter((dir) =>
    selected.has(dir === 'ignore' ? '@loro-dev/ignore' : `@lody/${dir}`)
  );
  const result = waves
    .map((wave) =>
      wave.flatMap((task) => {
        if (task.id === 'scripts') return scope.runScriptTests ? [task] : [];
        if (task.id === 'rest')
          return rest.length
            ? [
                narrow({
                  ...task,
                  args: [...task.args, ...rest.map((dir) => `--project=${dir}:*`)],
                }),
              ]
            : [];
        return selected.has(dedicated[task.id]) ? [narrow(task)] : [];
      })
    )
    .filter((wave) => wave.length);
  const known = new Set([
    ...Object.values(dedicated),
    ...REST_PACKAGES.map((dir) => (dir === 'ignore' ? '@loro-dev/ignore' : `@lody/${dir}`)),
  ]);
  for (const name of selected)
    if (!known.has(name))
      result.push([
        {
          id: `workspace:${name}`,
          command: 'corepack',
          args: ['pnpm', '--filter', name, 'run', 'test'],
        },
      ]);
  return result;
}

function runTask(task, { cwd, env }) {
  const startedAt = performance.now();
  console.log(`[test:${task.id}] starting: ${task.command} ${task.args.join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(task.command, task.args, {
      cwd,
      env: { ...env, ...task.env },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
      resolve({
        id: task.id,
        code: 1,
        signal: null,
        elapsedSeconds,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${Buffer.concat(stderrChunks).toString('utf8')}${error.message}\n`,
      });
    });
    child.on('close', (code, signal) => {
      const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
      const ok = code === 0 && signal === null;
      console.log(
        `[test:${task.id}] ${ok ? 'passed' : `failed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`} in ${elapsedSeconds}s`
      );
      resolve({
        id: task.id,
        code: code ?? 1,
        signal,
        elapsedSeconds,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function main() {
  const verbose = process.argv.includes('--verbose') || process.env.LODY_CHECK_VERBOSE === '1';
  const env = buildSanitizedTestEnv(process.env);
  const scope = process.argv.includes('--affected') ? collectLocalScope() : null;
  const related = relatedTestFiles(scope, { root: repoRoot });
  const waves = computeLocalTestWaves({ env: process.env, scope, related });
  const failures = [];

  for (const wave of waves) {
    const results = await Promise.all(wave.map((task) => runTask(task, { cwd: repoRoot, env })));
    for (const result of results) {
      const failed = result.code !== 0 || result.signal !== null;
      if (failed || verbose) {
        console.log(`\n=== [test:${result.id}] output (${result.elapsedSeconds}s) ===`);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      if (failed) failures.push(result);
    }
    if (failures.length > 0) break;
  }

  if (failures.length > 0) {
    console.error(`\nLocal test suite failed in: ${failures.map((item) => item.id).join(', ')}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
