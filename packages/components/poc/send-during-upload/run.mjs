import { spawnSync } from 'node:child_process';
import { runAblations } from './ablations.mjs';
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../../../..');
const patch = join(directory, 'prototype.patch');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--ablate')) throw new Error('Usage: node run.mjs [--ablate]');

function run(command, args, cwd = repository) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.signal ?? result.status})`);
  }
}

// Reuse installed dependencies without running install hooks or changing locks.
const dependencyPaths = ['node_modules'];
for (const group of ['apps', 'packages']) {
  for (const entry of readdirSync(join(repository, group), { withFileTypes: true })) {
    const relative = join(group, entry.name, 'node_modules');
    if (entry.isDirectory() && existsSync(join(repository, relative))) {
      dependencyPaths.push(relative);
    }
  }
}
for (const relative of ['node_modules', 'packages/components/node_modules']) {
  if (!existsSync(join(repository, relative))) {
    throw new Error(`Missing installed dependencies: ${relative}. See README.md.`);
  }
}

const temporary = mkdtempSync(join(tmpdir(), 'lody-upload-poc-'));
const worktree = join(temporary, 'source');
let registered = false;
try {
  run('git', ['worktree', 'add', '--detach', worktree, 'HEAD']);
  registered = true;
  for (const relative of dependencyPaths) {
    const target = join(worktree, relative);
    if (existsSync(dirname(target)) && !existsSync(target)) {
      symlinkSync(join(repository, relative), target, 'dir');
    }
  }
  run('git', ['apply', '--check', patch], worktree);
  run('git', ['apply', patch], worktree);
  run(
    'pnpm',
    [
      '--filter',
      '@lody/components',
      'test',
      'tests/session-chat-input-submission.test.tsx',
      'tests/session-message-submit-route.test.ts',
    ],
    worktree
  );
  run('pnpm', ['--filter', '@lody/components', 'typecheck'], worktree);
  console.log('Isolated upload POC: tests and component typecheck passed.');
  if (args.includes('--ablate')) runAblations(worktree, temporary);
} finally {
  // Only remove the temporary worktree created by this invocation.
  if (registered) run('git', ['worktree', 'remove', '--force', worktree]);
  rmSync(temporary, { recursive: true, force: true });
}
