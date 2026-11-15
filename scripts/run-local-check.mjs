#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function runLocalCheck({ run = runCommand } = {}) {
  if (!(await run(['--filter', 'lody', 'prepare:acp-adapters']))) return false;
  const results = await Promise.all([
    run([
      '-r',
      '--no-sort',
      '--filter',
      '!{**/acp-extension-*}',
      '--workspace-concurrency=4',
      'run',
      'typecheck',
    ]),
    run(['check:quick']),
  ]);
  if (!results.every(Boolean)) return false;
  return run(['exec', 'node', 'scripts/run-local-tests.mjs']);
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
  process.exitCode = (await runLocalCheck()) ? 0 : 1;
  console.log(
    `[check] ${process.exitCode === 0 ? 'passed' : 'failed'} in ${((performance.now() - started) / 1000).toFixed(2)}s`
  );
}
