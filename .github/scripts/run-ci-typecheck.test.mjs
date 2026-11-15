import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main, runCiTypecheck } from './run-ci-typecheck.mjs';

function recordExec() {
  const calls = [];
  return {
    calls,
    execFileSync(cmd, args) {
      calls.push({ cmd, args: [...args] });
    },
  };
}

void test('28. full mode argv is exactly pnpm typecheck', () => {
  const { calls, execFileSync } = recordExec();
  runCiTypecheck({
    scope: { mode: 'full', runTypecheck: true, typecheckPackages: ['lody'] },
    execFileSync,
  });
  assert.deepEqual(calls, [{ cmd: 'pnpm', args: ['typecheck'] }]);
});

void test('affected typecheck prepares full adapters when lody is included and only dsh otherwise', () => {
  const { calls, execFileSync } = recordExec();
  runCiTypecheck({
    scope: {
      mode: 'affected',
      runTypecheck: true,
      typecheckPackages: ['@loro-dev/ignore', 'lody'],
    },
    execFileSync,
  });
  assert.deepEqual(calls[0].args, ['--filter', 'lody', 'prepare:acp-adapters']);
  assert.equal(calls[1].args[0], '-r');
  assert.ok(calls[1].args.includes('--no-sort'));
  assert.ok(calls[1].args.includes('--workspace-concurrency=4'));
  assert.ok(calls[1].args.includes('!{**/acp-extension-*}'));
  assert.ok(calls[1].args.includes('@loro-dev/ignore'));
  assert.ok(calls[1].args.includes('lody'));

  const nonCli = recordExec();
  runCiTypecheck({
    scope: {
      mode: 'affected',
      runTypecheck: true,
      typecheckPackages: ['@lody/components'],
    },
    execFileSync: nonCli.execFileSync,
  });
  assert.deepEqual(nonCli.calls[0].args, ['--filter', 'acp-extension-dsh', 'build']);
  assert.ok(nonCli.calls[1].args.includes('@lody/components'));
});

void test('37. invalid scope file execs pnpm typecheck', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-typecheck-'));
  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, '{}');
  const { calls, execFileSync } = recordExec();
  main(['node', 'run-ci-typecheck.mjs', '--scope', invalid], { execFileSync });
  assert.deepEqual(calls, [{ cmd: 'pnpm', args: ['typecheck'] }]);
});
