#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  cpus = availableParallelism(),
  perfCores = detectPerformanceCores(),
  platform = process.platform,
  totalMemBytes = totalmem(),
  env = process.env,
} = {}) {
  const forcedBudget = Number.parseInt(String(env.LODY_TEST_BUDGET ?? ''), 10);
  const memGiB = totalMemBytes / 1024 ** 3;
  const effectiveCores =
    perfCores && perfCores < cpus
      ? perfCores
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
  };

  const makeRestTask = (workspaceConcurrency, restWorkers) => ({
    id: 'rest',
    command: 'corepack',
    args: [
      'pnpm',
      '-r',
      '--no-sort',
      `--workspace-concurrency=${workspaceConcurrency}`,
      '--filter',
      '!{**/acp-extension-*}',
      '--filter',
      '!@lody/components',
      '--filter',
      '!lody',
      '--filter',
      '!@lody/electron',
      'run',
      'test',
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

  // Only co-schedule heavy Vitest suites when true performance-core headroom >= 16.
  // On hybrid laptops (e.g. Apple Silicon 6P+12E), capping --maxWorkers to P-cores and running
  // electron's unbounded node --test pool in its own wave avoids E-core stragglers and cache thrash.
  if (budget >= 16 && effectiveCores >= 16) {
    const dedicatedWorkers = Math.min(8, Math.floor(budget / 2));
    return [
      [scriptsTask, makeComponentsTask(dedicatedWorkers), makeCliTask(dedicatedWorkers)],
      [makeRestTask(2, Math.min(6, dedicatedWorkers))],
      [electronTask],
    ];
  }

  const suiteWorkers = Math.max(2, Math.min(8, budget));
  return [
    [scriptsTask, makeComponentsTask(suiteWorkers)],
    [makeCliTask(suiteWorkers)],
    [makeRestTask(1, suiteWorkers)],
    [electronTask],
  ];
}

function runTask(task, { cwd, env }) {
  const startedAt = performance.now();
  console.log(`[test:${task.id}] starting: ${task.command} ${task.args.join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(task.command, task.args, {
      cwd,
      env,
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
  const waves = computeLocalTestWaves({ env: process.env });
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
