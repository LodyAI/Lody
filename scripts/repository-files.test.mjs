import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listRepositoryFiles } from './repository-files.mjs';

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

test('files inside the checked-out iOS submodule are listed with their parent path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'repository-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  writeFileSync(join(root, 'README.md'), '# root\n');
  const ios = join(root, 'apps/mobile/ios');
  mkdirSync(join(ios, 'packages/cloud-runtime'), { recursive: true });
  git(ios, 'init', '-q');
  writeFileSync(join(ios, 'packages/cloud-runtime/index.ts'), 'export {};\n');
  git(ios, 'add', '.');
  git(ios, 'commit', '-qm', 'ios');
  writeFileSync(join(ios, 'draft.md'), 'untracked\n');
  git(root, 'add', 'README.md', 'apps/mobile/ios');

  const files = listRepositoryFiles(root);

  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('apps/mobile/ios/packages/cloud-runtime/index.ts'));
  assert.ok(files.includes('apps/mobile/ios/draft.md'));
  assert.ok(!files.includes('apps/mobile/ios'));
});

test('an uninitialized iOS submodule contributes no files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'repository-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  writeFileSync(join(root, 'README.md'), '# root\n');
  git(root, 'add', 'README.md');

  assert.deepEqual(listRepositoryFiles(root), ['README.md']);
});
