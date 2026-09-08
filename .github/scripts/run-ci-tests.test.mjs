import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main, runCiTests } from './run-ci-tests.mjs';

function recordExec() {
  const calls = [];
  return {
    calls,
    execFileSync(cmd, args) {
      calls.push({ cmd, args: [...args] });
    },
  };
}

void test('27. electron last-run argv omits maxWorkers on the electron command', () => {
  const { calls, execFileSync } = recordExec();
  runCiTests({
    scope: {
      mode: 'affected',
      runTests: true,
      testPackages: ['@lody/electron', 'lody'],
    },
    execFileSync,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 4), [
    '-r',
    '--workspace-concurrency=2',
    '--filter',
    '!@lody/electron',
  ]);
  assert.ok(calls[0].args.includes('lody'));
  assert.ok(calls[0].args.includes('--maxWorkers=2'));
  assert.ok(!calls[0].args.includes('@lody/electron') || calls[0].args.includes('!@lody/electron'));
  assert.deepEqual(calls[1].args, ['--filter', '@lody/electron', 'run', 'test']);
  assert.ok(!calls[1].args.includes('--maxWorkers=2'));
});

void test('28. full mode argv is exactly pnpm test:ci', () => {
  const { calls, execFileSync } = recordExec();
  runCiTests({
    scope: { mode: 'full', runTests: true, testPackages: ['lody'] },
    execFileSync,
  });
  assert.deepEqual(calls, [{ cmd: 'pnpm', args: ['test:ci'] }]);
});

void test('37. invalid or missing scope file execs pnpm test:ci', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-tests-'));
  const missing = join(dir, 'missing.json');
  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, '{');
  const { calls, execFileSync } = recordExec();
  main(['node', 'run-ci-tests.mjs', '--scope', missing], { execFileSync });
  main(['node', 'run-ci-tests.mjs', '--scope', invalid], { execFileSync });
  assert.deepEqual(
    calls.map((call) => call.args),
    [['test:ci'], ['test:ci']]
  );
});

void test('affected electron-only skips the recursive pass', () => {
  const { calls, execFileSync } = recordExec();
  runCiTests({
    scope: {
      mode: 'affected',
      runTests: true,
      testPackages: ['@lody/electron'],
    },
    execFileSync,
  });
  assert.deepEqual(calls, [{ cmd: 'pnpm', args: ['--filter', '@lody/electron', 'run', 'test'] }]);
});
