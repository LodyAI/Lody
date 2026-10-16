import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepoId, SessionId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { WorktreeManager } from './worktree-manager';
import { branchNameFromSessionTitle } from './worktree-title-branch';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('title-derived worktree branches', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('bounds the name and keeps unrepresentable titles on the ID branch', () => {
    expect(branchNameFromSessionTitle('Add system notifications', 'a8e6488f-0bd')).toBe(
      'lody/add-system-notifications-a8e6488f'
    );
    expect(branchNameFromSessionTitle('中文标题', 'a8e6488f-0bd')).toBeNull();
    expect(branchNameFromSessionTitle('x'.repeat(200), 'a8e6488f-0bd')?.length).toBeLessThanOrEqual(
      64
    );
  });

  it('renames an untouched local worktree once and preserves user or committed work', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lody-title-branch-'));
    roots.push(root);
    const source = path.join(root, 'source');
    git(root, 'init', '-b', 'main', source);
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(source, 'readme'), 'initial\n');
    git(source, 'add', 'readme');
    git(source, 'commit', '-m', 'initial');
    const previous = process.env.LODY_DATA_DIR;
    process.env.LODY_DATA_DIR = root;
    try {
      const logger = {
        debug() {},
        info() {},
        warn() {},
        error() {},
        success() {},
      } as unknown as Logger;
      const manager = new WorktreeManager({
        repoId: 'local-title-branch' as RepoId,
        source: { kind: 'local-shared', originalRootPath: source },
        logger,
      });
      await manager.ensureRepo();
      const sessionId = 'a8e6488f-0bd' as SessionId;
      const initial = await manager.createWorktree(sessionId, 'main');
      expect(initial.headSha).toBeTruthy();
      const branch = await manager.renameInitialBranchFromTitle({
        sessionId,
        title: 'Add system notifications',
        initialBranch: initial.branch,
        initialHead: initial.headSha!,
        hasPullRequest: false,
      });
      expect(branch).toBe('lody/add-system-notifications-a8e6488f');
      expect(git(initial.hostPath, 'branch', '--show-current')).toBe(branch);
      expect(
        await manager.renameInitialBranchFromTitle({
          sessionId,
          title: 'A later title',
          initialBranch: initial.branch,
          initialHead: initial.headSha!,
          hasPullRequest: false,
        })
      ).toBeNull();

      const second = 'b9e6488f-0bd' as SessionId;
      const worktree = await manager.createWorktree(second, 'main');
      writeFileSync(path.join(worktree.hostPath, 'new-file'), 'work\n');
      git(worktree.hostPath, 'add', 'new-file');
      git(worktree.hostPath, 'commit', '-m', 'work');
      expect(
        await manager.renameInitialBranchFromTitle({
          sessionId: second,
          title: 'Committed work',
          initialBranch: worktree.branch,
          initialHead: worktree.headSha!,
          hasPullRequest: false,
        })
      ).toBeNull();
      expect(git(worktree.hostPath, 'branch', '--show-current')).toBe(worktree.branch);

      const remote = path.join(root, 'remote.git');
      git(root, 'init', '--bare', remote);
      git(source, 'remote', 'add', 'origin', remote);
      const third = 'c9e6488f-0bd' as SessionId;
      const published = await manager.createWorktree(third, 'main');
      git(published.hostPath, 'push', 'origin', `HEAD:refs/heads/${published.branch}`);
      expect(
        await manager.renameInitialBranchFromTitle({
          sessionId: third,
          title: 'Published work',
          initialBranch: published.branch,
          initialHead: published.headSha!,
          hasPullRequest: false,
        })
      ).toBeNull();
      expect(git(published.hostPath, 'branch', '--show-current')).toBe(published.branch);

      const fourth = 'd9e6488f-0bd' as SessionId;
      const duplicate = await manager.createWorktree(fourth, 'main');
      git(source, 'branch', 'lody/duplicate-title-d9e6488f', 'main');
      expect(
        await manager.renameInitialBranchFromTitle({
          sessionId: fourth,
          title: 'Duplicate title',
          initialBranch: duplicate.branch,
          initialHead: duplicate.headSha!,
          hasPullRequest: false,
        })
      ).toBe('lody/duplicate-title-d9e6488f-2');
    } finally {
      if (previous === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previous;
    }
  });
});
