#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectLocalScope } from './local-check-scope.mjs';

export function planLocalCheck(scope = null) {
  if (!scope || !['affected', 'skip-tests'].includes(scope.mode))
    return {
      prepare: ['--filter', 'lody', 'prepare:acp-adapters'],
      static: [
        [
          '-r',
          '--no-sort',
          '--filter',
          '!{**/acp-extension-*}',
          '--workspace-concurrency=4',
          'run',
          'typecheck',
        ],
        ['check:quick'],
      ],
      tests: ['exec', 'node', 'scripts/run-local-tests.mjs'],
    };
  const packages = scope.typecheckPackages ?? [];
  const prepare = !scope.prepareAcpAdapters
    ? null
    : [...packages, ...(scope.testPackages ?? [])].includes('lody')
      ? ['--filter', 'lody', 'prepare:acp-adapters']
      : scope.adapterPackages?.length
        ? [
            '-r',
            '--no-sort',
            '--workspace-concurrency=5',
            ...scope.adapterPackages.flatMap((name) => ['--filter', name]),
            'run',
            'build',
          ]
        : null;
  return {
    prepare,
    static: [
      ...(scope.runTypecheck
        ? [
            [
              '-r',
              '--no-sort',
              '--workspace-concurrency=4',
              ...packages.flatMap((name) => ['--filter', name]),
              'run',
              'typecheck',
            ],
          ]
        : []),
      ...(scope.runCheckQuick ? [['check:quick']] : []),
    ],
    tests: scope.runTests ? ['exec', 'node', 'scripts/run-local-tests.mjs', '--affected'] : null,
  };
}

export async function runLocalCheck({
  run = runCommand,
  affected = false,
  scope = affected ? collectLocalScope() : null,
} = {}) {
  if (affected) console.log(`[check:affected] ${scope.mode}: ${scope.reason}`);
  const plan = planLocalCheck(scope);
  if (plan.prepare && !(await run(plan.prepare))) return false;
  const results = await Promise.all(plan.static.map(run));
  if (!results.every(Boolean)) return false;
  return plan.tests ? run(plan.tests) : true;
}

function runCommand(args) {
  const id = args.includes('prepare:acp-adapters')
    ? 'prepare'
    : args.includes('typecheck')
      ? 'typecheck'
      : args.includes('check:quick')
        ? 'quick'
        : 'tests';
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn('corepack', ['pnpm', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (error) => {
      console.error(error);
      resolve(false);
    });
    child.on('close', (code, signal) => {
      console.log(
        `[check:${id}] ${code === 0 && signal === null ? 'passed' : 'failed'} in ${((performance.now() - started) / 1000).toFixed(2)}s`
      );
      resolve(code === 0 && signal === null);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = performance.now();
  process.exitCode = (await runLocalCheck({ affected: process.argv.includes('--affected') }))
    ? 0
    : 1;
  console.log(
    `[check] ${process.exitCode === 0 ? 'passed' : 'failed'} in ${((performance.now() - started) / 1000).toFixed(2)}s`
  );
}
