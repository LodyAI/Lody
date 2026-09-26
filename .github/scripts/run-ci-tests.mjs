#!/usr/bin/env node

import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXCLUDED_FILTERS = ['!@lody/electron', '!acp-extension-codex', '!acp-extension-claude'];

// The two suites that dominate CI get their own runners. On a 4-vCPU runner
// they are CPU-bound, so overlapping them in one job gains nothing; splitting
// them across jobs does. `rest` runs every other package, then electron.
const DEDICATED_PACKAGES = { components: '@lody/components', cli: 'lody' };
const DEDICATED_WORKERS = 4;
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
 */
export function planCiTests({ scope, group, shard = null, full = false }) {
  if (!TEST_GROUPS.includes(group)) throw new Error(`Unknown test group: ${group}`);
  if (shard !== null && (group !== 'components' || !/^[1-9]\d*\/[1-9]\d*$/.test(shard))) {
    throw new Error(`Invalid shard for group ${group}: ${shard}`);
  }
  const forceFull = full || !scope || scope.mode === 'full' || typeof scope.runTests !== 'boolean';
  if (!forceFull && scope.runTests === false) return [];
  const listed = !forceFull && Array.isArray(scope.testPackages) ? scope.testPackages : [];
  // An affected scope that names no package is not trusted to mean "nothing".
  const runAll = listed.length === 0;
  const selected = (name) => runAll || listed.includes(name);

  if (group in DEDICATED_PACKAGES) {
    const name = DEDICATED_PACKAGES[group];
    if (!selected(name)) return [];
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
    commands.push([
      ...recursive,
      ...filters([...EXCLUDED_FILTERS, ...dedicated.map((name) => `!${name}`)]),
      'run',
      'test',
      '--maxWorkers=2',
    ]);
  } else {
    const others = listed.filter((name) => name !== '@lody/electron' && !dedicated.includes(name));
    if (others.length > 0) {
      commands.push([
        ...recursive,
        ...filters(EXCLUDED_FILTERS),
        ...filters(others),
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
  const commands = planCiTests({ scope, group, shard, full });
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
