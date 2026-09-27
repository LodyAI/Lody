import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main, planCiTests, TEST_GROUPS } from './run-ci-tests.mjs';

const affected = (testPackages) => ({ mode: 'affected', runTests: true, testPackages });

// Every package must be tested by exactly one group, or a full run silently
// drops (or doubles) a suite when the matrix is split.
function packagesCoveredInFullRun() {
  const all = ['@lody/components', 'lody', '@lody/shared', '@lody/ui', '@lody/electron'];
  const owners = new Map(all.map((name) => [name, []]));
  for (const group of TEST_GROUPS) {
    for (const args of planCiTests({ scope: null, group })) {
      // Root scripts such as `test:scripts` run no workspace package.
      if (!args.includes('-r') && !args.includes('--filter')) continue;
      const positive = [];
      const negative = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] !== '--filter') continue;
        const value = args[i + 1];
        (value.startsWith('!') ? negative : positive).push(
          value.slice(value.startsWith('!') ? 1 : 0)
        );
      }
      for (const name of all) {
        const included = positive.length > 0 ? positive.includes(name) : !negative.includes(name);
        if (included) owners.get(name).push(group);
      }
    }
  }
  return owners;
}

void test('full run assigns each package to exactly one group', () => {
  for (const [name, groups] of packagesCoveredInFullRun()) {
    assert.equal(groups.length, 1, `${name} ran in [${groups.join(', ')}]`);
  }
});

void test('full rest group runs repository scripts, the remaining packages, then electron', () => {
  const plan = planCiTests({ scope: null, group: 'rest' });
  assert.deepEqual(plan[0], ['test:scripts']);
  assert.deepEqual(plan.at(-1), ['--filter', '@lody/electron', 'run', 'test']);
});

void test('components shard is forwarded to vitest; other groups reject a shard', () => {
  assert.deepEqual(planCiTests({ scope: null, group: 'components', shard: '2/3' }), [
    ['--filter', '@lody/components', 'run', 'test', '--maxWorkers=4', '--shard=2/3'],
  ]);
  assert.throws(() => planCiTests({ scope: null, group: 'cli', shard: '1/3' }), /Invalid shard/);
  assert.throws(
    () => planCiTests({ scope: null, group: 'components', shard: '0/3' }),
    /Invalid shard/
  );
});

void test('affected scope runs only the groups that own a listed package', () => {
  const scope = affected(['lody', '@lody/electron']);
  assert.deepEqual(planCiTests({ scope, group: 'components', shard: '1/3' }), []);
  assert.deepEqual(planCiTests({ scope, group: 'cli' }), [
    ['--filter', 'lody', 'run', 'test', '--maxWorkers=4'],
  ]);
  assert.deepEqual(planCiTests({ scope, group: 'rest' }), [
    ['--filter', '@lody/electron', 'run', 'test'],
  ]);
});

void test('affected rest group filters to its own listed packages', () => {
  const [recursive] = planCiTests({ scope: affected(['@lody/shared', 'lody']), group: 'rest' });
  assert.ok(recursive.includes('@lody/shared'));
  assert.ok(!recursive.includes('lody'));
});

void test('skip-tests scope runs nothing; empty affected list fails open to full', () => {
  const skip = { mode: 'skip-tests', runTests: false, testPackages: [] };
  for (const group of TEST_GROUPS) assert.deepEqual(planCiTests({ scope: skip, group }), []);
  assert.deepEqual(
    planCiTests({ scope: affected([]), group: 'rest' }),
    planCiTests({ scope: null, group: 'rest' })
  );
});

void test('--full ignores a scope that would skip the group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-tests-'));
  const scopePath = join(dir, 'scope.json');
  writeFileSync(scopePath, JSON.stringify(affected(['@lody/shared'])));
  const lines = [];
  main(['node', 'run-ci-tests.mjs', '--scope', scopePath, '--group', 'cli', '--plan'], {
    log: (line) => lines.push(line),
  });
  main(['node', 'run-ci-tests.mjs', '--full', '--group', 'cli', '--plan'], {
    log: (line) => lines.push(line),
  });
  assert.deepEqual(lines, ['run=false', 'run=true']);
});

void test('invalid or missing scope file plans the full group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-tests-'));
  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, '{');
  const lines = [];
  for (const scopePath of [join(dir, 'missing.json'), invalid]) {
    main(['node', 'run-ci-tests.mjs', '--scope', scopePath, '--group', 'components', '--plan'], {
      log: (line) => lines.push(line),
    });
  }
  assert.deepEqual(lines, ['run=true', 'run=true']);
});
