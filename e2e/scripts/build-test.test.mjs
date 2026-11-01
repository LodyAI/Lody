import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testDesktopBuild } from './build-test.mjs';

void test('test desktop build keeps preparation, worker bundles and import checks before staging and app build', () => {
  const calls = [];
  const env = { NODE_OPTIONS: '--no-warnings --max-old-space-size=8192', SENTINEL: 'preserved' };
  testDesktopBuild({ root: '/repo', env, run: (args, options) => calls.push({ args, options }) });
  assert.deepEqual(
    calls.slice(0, 6).map((c) => c.args.at(-1)),
    [
      'clean',
      'prepare:acp-adapters',
      'build:bundle',
      'copy:dsh-presets',
      'check:published-bundle-imports',
      'copy:wasm',
    ]
  );
  assert.equal(calls[6].args.at(-1), 'sync:cli');
  assert.equal(calls[7].args.at(-1), 'build:app:test');
  assert.ok(
    calls
      .slice(0, 6)
      .every(
        (c) =>
          c.options.env.LODY_PLATFORM === 'local' &&
          c.options.env.NODE_OPTIONS.split(/\s+/u).join(' ') ===
            '--no-warnings --max-old-space-size=2048'
      )
  );
  assert.equal(calls[7].options.env, env, 'renderer must not inherit the forced CLI heap');
  assert.equal(env.NODE_OPTIONS, '--no-warnings --max-old-space-size=8192');
  assert.equal(
    calls.some((c) => c.args.includes('typecheck')),
    false
  );
});
void test('a failed prerequisite cannot stage or launch a stale renderer', () => {
  const calls = [];
  assert.throws(
    () =>
      testDesktopBuild({
        root: '/repo',
        run: (args) => {
          calls.push(args);
          throw new Error('prepare failed');
        },
      }),
    /prepare failed/
  );
  assert.equal(calls.length, 1);
});
