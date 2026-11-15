import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main, planCiTests, REST_PACKAGE_DIRS, TEST_GROUPS } from './run-ci-tests.mjs';

const affected = (testPackages) => ({ mode: 'affected', runTests: true, testPackages });

// Every package must be tested by exactly one group, or a full run silently
// drops (or doubles) a suite when the matrix is split.
function packagesCoveredInFullRun() {
  const all = [
    '@lody/components',
    'lody',
    '@lody/site-docs',
    '@lody/electron',
    ...Object.keys(REST_PACKAGE_DIRS),
  ];
  const owners = new Map(all.map((name) => [name, []]));
  for (const group of TEST_GROUPS) {
    for (const args of planCiTests({ scope: null, group })) {
      if (args[0] === 'test:rest') {
        for (const name of Object.keys(REST_PACKAGE_DIRS)) owners.get(name).push(group);
        continue;
      }
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

void test('full rest group runs repository scripts, site-docs, single-boot rest vitest, then electron', () => {
  const plan = planCiTests({ scope: null, group: 'rest' });
  assert.deepEqual(plan, [
    ['test:scripts'],
    ['--filter', '@lody/site-docs', 'run', 'test'],
    ['test:rest', '--maxWorkers=4'],
    ['--filter', '@lody/electron', 'run', 'test'],
  ]);
});

void test('dedicated groups forward shard to vitest; rest rejects a shard', () => {
  assert.deepEqual(planCiTests({ scope: null, group: 'components', shard: '2/2' }), [
    ['--filter', '@lody/components', 'run', 'test', '--maxWorkers=4', '--shard=2/2'],
  ]);
  assert.deepEqual(planCiTests({ scope: null, group: 'cli', shard: '1/2' }), [
    ['--filter', 'lody', 'run', 'test', '--maxWorkers=4', '--shard=1/2'],
  ]);
  assert.throws(() => planCiTests({ scope: null, group: 'rest', shard: '1/2' }), /Invalid shard/);
  assert.throws(
    () => planCiTests({ scope: null, group: 'components', shard: '0/2' }),
    /Invalid shard/
  );
  assert.throws(() => planCiTests({ scope: null, group: 'cli', shard: '0/2' }), /Invalid shard/);
});

void test('affected scope runs only the groups that own a listed package', () => {
  const scope = affected(['lody', '@lody/electron']);
  assert.deepEqual(planCiTests({ scope, group: 'components', shard: '1/2' }), []);
  assert.deepEqual(planCiTests({ scope, group: 'cli', shard: '1/2' }), [
    ['--filter', 'lody', 'run', 'test', '--maxWorkers=4', '--shard=1/2'],
  ]);
  assert.deepEqual(planCiTests({ scope, group: 'rest' }), [
    ['--filter', '@lody/electron', 'run', 'test'],
  ]);
});

void test('affected rest group filters to its own listed packages via single-boot projects and recursive fallback', () => {
  const plan = planCiTests({
    scope: affected(['@lody/shared', '@loro-dev/ignore', '@lody/site-docs', 'lody']),
    group: 'rest',
  });
  assert.deepEqual(plan[0], [
    'test:rest',
    '--maxWorkers=4',
    '--project=shared:*',
    '--project=ignore:*',
  ]);
  assert.ok(plan[1].includes('@lody/site-docs'));
  assert.ok(!plan[1].includes('lody'));
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

void test('test group planning boots in a fresh checkout before dependency installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'lody-ci-plan-'));
  try {
    mkdirSync(join(root, '.github/scripts'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    copyFileSync(
      new URL('./run-ci-tests.mjs', import.meta.url),
      join(root, '.github/scripts/run-ci-tests.mjs')
    );
    copyFileSync(
      new URL('../../scripts/vitest-rest.config.mjs', import.meta.url),
      join(root, 'scripts/vitest-rest.config.mjs')
    );
    const output = execFileSync(
      process.execPath,
      ['.github/scripts/run-ci-tests.mjs', '--full', '--group', 'rest', '--plan'],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(output.trim(), 'run=true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
