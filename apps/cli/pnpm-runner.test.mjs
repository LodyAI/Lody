import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePnpmRunner } from './pnpm-runner.mjs';

void test('runs a pnpm JavaScript entry point with Node on Windows', () => {
  assert.deepEqual(
    resolvePnpmRunner({
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      npmExecPath: 'C:\\pnpm\\bin\\pnpm.cjs',
    }),
    {
      command: 'C:\\node\\node.exe',
      args: ['C:\\pnpm\\bin\\pnpm.cjs'],
      shell: false,
    }
  );
});

void test('runs a pnpm executable directly without a shell', () => {
  assert.deepEqual(
    resolvePnpmRunner({
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      npmExecPath: 'C:\\pnpm\\pnpm.exe',
    }),
    {
      command: 'C:\\pnpm\\pnpm.exe',
      args: [],
      shell: false,
    }
  );
});

void test('rejects an npm entry point instead of treating it as pnpm on Windows', () => {
  assert.throws(
    () =>
      resolvePnpmRunner({
        platform: 'win32',
        execPath: 'C:\\node\\node.exe',
        npmExecPath: 'C:\\npm\\bin\\npm-cli.js',
      }),
    /must be launched through pnpm/u
  );
});

void test('falls back to corepack without a shell on non-Windows platforms', () => {
  assert.deepEqual(
    resolvePnpmRunner({
      platform: 'linux',
      execPath: '/usr/bin/node',
      npmExecPath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
    }),
    { command: 'corepack', args: ['pnpm'], shell: false }
  );
});
