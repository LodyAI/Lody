import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// apps/mobile/ios is a submodule, so git ls-files stops at its gitlink. Public-repository
// checks still cover it whenever it is checked out, as they did when it lived in this tree.
export const checkedSubmodules = ['apps/mobile/ios'];

function listFiles(cwd, args) {
  return execFileSync('git', ['ls-files', ...args, '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

export function listRepositoryFiles(root, args = ['--cached', '--others', '--exclude-standard']) {
  const files = listFiles(root, args).filter((file) => !checkedSubmodules.includes(file));
  for (const submodule of checkedSubmodules) {
    if (!existsSync(path.join(root, submodule, '.git'))) continue;
    files.push(
      ...listFiles(path.join(root, submodule), args).map((file) => `${submodule}/${file}`)
    );
  }
  return files;
}
