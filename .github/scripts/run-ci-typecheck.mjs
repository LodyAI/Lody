#!/usr/bin/env node

import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXCLUDED_FILTERS = ['!acp-extension-claude', '!acp-extension-codex'];

function loadScope(scopePath) {
  try {
    const scope = JSON.parse(readFileSync(scopePath, 'utf8'));
    if (!scope || typeof scope !== 'object') return null;
    if (!['full', 'affected', 'skip-tests'].includes(scope.mode)) return null;
    if (typeof scope.runTypecheck !== 'boolean') return null;
    return scope;
  } catch {
    return null;
  }
}

function runPnpm(execFileSync, cwd, args) {
  execFileSync('pnpm', args, { cwd, stdio: 'inherit' });
}

export function runCiTypecheck({
  scope,
  execFileSync = defaultExecFileSync,
  cwd = process.cwd(),
} = {}) {
  if (!scope || scope.mode === 'full' || typeof scope.runTypecheck !== 'boolean') {
    runPnpm(execFileSync, cwd, ['typecheck']);
    return 'full';
  }
  if (scope.runTypecheck === false) {
    console.log(`Skipping typecheck: ${scope.reason ?? 'runTypecheck=false'}`);
    return 'skip';
  }

  const typecheckPackages = Array.isArray(scope.typecheckPackages) ? scope.typecheckPackages : [];
  if (typecheckPackages.length === 0) {
    console.log('Skipping typecheck: empty typecheckPackages');
    return 'skip';
  }

  runPnpm(execFileSync, cwd, ['--filter', 'lody', 'prepare:acp-adapters']);
  runPnpm(execFileSync, cwd, [
    '-r',
    '--workspace-concurrency=1',
    ...EXCLUDED_FILTERS.flatMap((filter) => ['--filter', filter]),
    ...typecheckPackages.flatMap((name) => ['--filter', name]),
    'run',
    'typecheck',
  ]);
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
  runCiTypecheck({
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
