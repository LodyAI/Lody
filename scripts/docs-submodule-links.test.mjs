import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { documentStatus } from './docs/main.mjs';

function createRepository(markdown) {
  const root = mkdtempSync(join(tmpdir(), 'lody-docs-links-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  writeFileSync(join(root, 'README.md'), markdown);
  git('add', 'README.md');
  git('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},packages/adapter`);
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'init'
  );
  return root;
}

const brokenLinks = (status) =>
  status.errors.filter((error) => error.includes('broken local link'));

test('links into an uninitialized submodule become one actionable warning', async (t) => {
  const root = createRepository('[a](packages/adapter/src/a.ts) [b](packages/adapter/b.md)\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const status = await documentStatus(root);

  assert.deepEqual(brokenLinks(status), []);
  assert.ok(status.warnings.some((warning) => warning.startsWith('2 links into uninitialized')));
});

test('a broken link outside submodules stays an error', async (t) => {
  const root = createRepository('[gone](packages/missing/a.ts)\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const status = await documentStatus(root);

  assert.deepEqual(brokenLinks(status), ['README.md: broken local link packages/missing/a.ts']);
});

test('a broken link into a checked-out submodule stays an error', async (t) => {
  const root = createRepository('[gone](packages/adapter/missing.ts)\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/adapter'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: join(root, 'packages/adapter') });

  const status = await documentStatus(root);

  assert.deepEqual(brokenLinks(status), [
    'README.md: broken local link packages/adapter/missing.ts',
  ]);
});
