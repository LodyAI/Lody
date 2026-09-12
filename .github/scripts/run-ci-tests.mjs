#!/usr/bin/env node

import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXCLUDED_FILTERS = ['!@lody/electron', '!acp-extension-codex', '!acp-extension-claude'];

function loadScope(scopePath) {
  try {
    const scope = JSON.parse(readFileSync(scopePath, 'utf8'));
    if (!scope || typeof scope !== 'object') return null;
    if (!['full', 'affected', 'skip-tests'].includes(scope.mode)) return null;
    if (typeof scope.runTests !== 'boolean') return null;
    return scope;
  } catch {
    return null;
  }
}

function runPnpm(execFileSync, cwd, args) {
  execFileSync('pnpm', args, { cwd, stdio: 'inherit' });
}

export function runCiTests({
  scope,
  execFileSync = defaultExecFileSync,
  cwd = process.cwd(),
} = {}) {
  if (!scope || scope.mode === 'full' || typeof scope.runTests !== 'boolean') {
    runPnpm(execFileSync, cwd, ['test:ci']);
    return 'full';
  }
  if (scope.runTests === false) {
    console.log(`Skipping tests: ${scope.reason ?? 'runTests=false'}`);
    return 'skip';
  }

  const testPackages = Array.isArray(scope.testPackages) ? scope.testPackages : [];
  const nonElectron = testPackages.filter((name) => name !== '@lody/electron');
  if (nonElectron.length > 0) {
    runPnpm(execFileSync, cwd, [
      '-r',
      '--workspace-concurrency=2',
      ...EXCLUDED_FILTERS.flatMap((filter) => ['--filter', filter]),
      ...nonElectron.flatMap((name) => ['--filter', name]),
      'run',
      'test',
      '--maxWorkers=2',
    ]);
  }
  if (testPackages.includes('@lody/electron')) {
    runPnpm(execFileSync, cwd, ['--filter', '@lody/electron', 'run', 'test']);
  }
  if (nonElectron.length === 0 && !testPackages.includes('@lody/electron')) {
    runPnpm(execFileSync, cwd, ['test:ci']);
    return 'full';
  }
  return 'affected';
}

function parseArgs(argv) {
  const options = { scopePath: null };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--scope') {
      options.scopePath = argv[++index] ?? null;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!options.scopePath) throw new Error('--scope is required');
  return options;
}

export function main(argv = process.argv, deps = {}) {
  const options = parseArgs(argv);
  const scope = loadScope(options.scopePath);
  runCiTests({
    scope,
    execFileSync: deps.execFileSync,
    cwd: deps.cwd,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
