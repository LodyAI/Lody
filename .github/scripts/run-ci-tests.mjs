#!/usr/bin/env node

import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { RELATED_FLAGS, relatedTestFiles } from './related-test-files.mjs';

import { REST_PACKAGES } from '../../scripts/vitest-rest.config.mjs';

const EXCLUDED_FILTERS = [
  '!@lody/electron',
  '!{**/acp-extension-*}',
  '!acp-extension-codex',
  '!acp-extension-claude',
];

// The two suites that dominate CI get their own sharded runners. On a 4-vCPU
// runner they are CPU-bound, so overlapping them in one job gains nothing;
// splitting them across jobs does. `rest` runs repository scripts, site-docs,
// the single-boot aggregated Vitest workspace projects, then electron.
const DEDICATED_PACKAGES = { components: '@lody/components', cli: 'lody' };
const DEDICATED_DIRECTORIES = { components: 'packages/components', cli: 'apps/cli' };
const DEDICATED_WORKERS = 4;
export const REST_PACKAGE_DIRS = Object.fromEntries(
  REST_PACKAGES.map((dir) => [dir === 'ignore' ? '@loro-dev/ignore' : `@lody/${dir}`, dir])
);
export const TEST_GROUPS = [...Object.keys(DEDICATED_PACKAGES), 'rest'];

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

const filters = (names) => names.flatMap((name) => ['--filter', name]);

/**
 * pnpm argv lists for one CI test group. An empty list means the scope leaves
 * nothing for this group. Missing or invalid scope fails open to the full group.
 * `related` (repository-relative changed modules) narrows Vitest suites to the
 * test files whose import graph reaches them; null keeps whole suites.
 */
export function planCiTests({ scope, group, shard = null, full = false, related = null }) {
  if (!TEST_GROUPS.includes(group)) throw new Error(`Unknown test group: ${group}`);
  if (shard !== null && (!(group in DEDICATED_PACKAGES) || !/^[1-9]\d*\/[1-9]\d*$/.test(shard))) {
    throw new Error(`Invalid shard for group ${group}: ${shard}`);
  }
  const forceFull = full || !scope || scope.mode === 'full' || typeof scope.runTests !== 'boolean';
  if (!forceFull && scope.runTests === false) return [];
  const listed = !forceFull && Array.isArray(scope.testPackages) ? scope.testPackages : [];
  // An affected scope that names no package is not trusted to mean "nothing".
  const runAll = listed.length === 0;
  const relatedFiles = !runAll && related?.length ? related : null;
  const selected = (name) => runAll || listed.includes(name);

  if (group in DEDICATED_PACKAGES) {
    const name = DEDICATED_PACKAGES[group];
    if (!selected(name)) return [];
    if (relatedFiles) {
      const directory = DEDICATED_DIRECTORIES[group];
      return [
        [
          '--filter',
          name,
          'exec',
          'vitest',
          'related',
          ...RELATED_FLAGS,
          `--maxWorkers=${DEDICATED_WORKERS}`,
          ...(shard ? [`--shard=${shard}`] : []),
          ...relatedFiles.map((file) => path.posix.relative(directory, file)),
        ],
      ];
    }
    return [
      [
        '--filter',
        name,
        'run',
        'test',
        `--maxWorkers=${DEDICATED_WORKERS}`,
        ...(shard ? [`--shard=${shard}`] : []),
      ],
    ];
  }

  const dedicated = Object.values(DEDICATED_PACKAGES);
  const recursive = ['-r', '--workspace-concurrency=2', '--no-sort'];
  const commands = [];
  if (runAll) {
    commands.push(['test:scripts']);
    commands.push(['--filter', '@lody/site-docs', 'run', 'test']);
    commands.push(['test:rest', `--maxWorkers=${DEDICATED_WORKERS}`]);
  } else {
    const others = listed.filter((name) => name !== '@lody/electron' && !dedicated.includes(name));
    const restDirs = others
      .filter((name) => name in REST_PACKAGE_DIRS)
      .map((name) => REST_PACKAGE_DIRS[name]);
    const nonRestPackages = others.filter((name) => !(name in REST_PACKAGE_DIRS));
    if (restDirs.length > 0) {
      commands.push([
        relatedFiles ? 'test:rest:related' : 'test:rest',
        ...(relatedFiles ? ['--passWithNoTests'] : []),
        `--maxWorkers=${DEDICATED_WORKERS}`,
        ...restDirs.map((dir) => `--project=${dir}:*`),
        ...(relatedFiles ?? []),
      ]);
    }
    if (nonRestPackages.length > 0) {
      commands.push([
        ...recursive,
        ...filters(EXCLUDED_FILTERS),
        ...filters(nonRestPackages),
        'run',
        'test',
        '--maxWorkers=2',
      ]);
    }
  }
  if (selected('@lody/electron')) commands.push(['--filter', '@lody/electron', 'run', 'test']);
  return commands;
}

export function runCiTests({
  scope,
  group,
  shard = null,
  full = false,
  execFileSync = defaultExecFileSync,
  cwd = process.cwd(),
} = {}) {
  const related = full ? null : relatedTestFiles(scope, { root: cwd });
  const commands = planCiTests({ scope, group, shard, full, related });
  if (commands.length === 0) console.log(`Nothing to test in group ${group} for this scope.`);
  for (const args of commands) execFileSync('pnpm', args, { cwd, stdio: 'inherit' });
  return commands;
}

function parseArgs(argv) {
  const options = { scopePath: null, group: null, shard: null, full: false, plan: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scope') options.scopePath = argv[++index] ?? null;
    else if (arg === '--group') options.group = argv[++index] ?? null;
    else if (arg === '--shard') options.shard = argv[++index] || null;
    else if (arg === '--full') options.full = true;
    else if (arg === '--plan') options.plan = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.group) throw new Error('--group is required');
  if (!options.full && !options.scopePath) throw new Error('--scope or --full is required');
  return options;
}

/** `--plan` prints `run=true|false` for $GITHUB_OUTPUT instead of running. */
export function main(argv = process.argv, deps = {}) {
  const options = parseArgs(argv);
  const scope = options.full ? null : loadScope(options.scopePath);
  const request = { scope, group: options.group, shard: options.shard, full: options.full };
  if (options.plan) {
    const log = deps.log ?? console.log;
    log(`run=${planCiTests(request).length > 0}`);
    return;
  }
  runCiTests({ ...request, execFileSync: deps.execFileSync, cwd: deps.cwd });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
