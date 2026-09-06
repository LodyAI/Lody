import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { RepoId, SessionId } from '@lody/shared';
import { WorktreeManager } from '../src/session/worktree/worktree-manager';
import {
  createLocalRepo,
  createRemoteRepo,
  gitCommit,
  runGit,
  toFileUrl,
  useWorktreeManagerTestFixture,
} from './worktree-manager-test-helpers';

describe('WorktreeManager', () => {
  let testDir: string;
  let repoId: RepoId;
  let manager: WorktreeManager;

  useWorktreeManagerTestFixture((fixture) => {
    ({ testDir, repoId, manager } = fixture);
  });

  describe('removeWorktree', () => {
    it('should remove an existing worktree', async () => {
      await manager.ensureRepo();

      const sessionId = 'remove01-session-remove' as SessionId;
      const info = await manager.createWorktree(sessionId);

      expect(fs.existsSync(info.hostPath)).toBe(true);

      await manager.removeWorktree(sessionId, true);

      expect(fs.existsSync(info.hostPath)).toBe(false);
    });

    it('should remove a worktree when the worktrees root resolves through a symlink', async () => {
      const realRoot = path.join(testDir, 'real-root');
      const linkRoot = path.join(testDir, 'link-root');
      fs.mkdirSync(realRoot, { recursive: true });
      try {
        fs.symlinkSync(realRoot, linkRoot, 'dir');
      } catch {
        return;
      }
      const linkedRepoDir = path.join(linkRoot, repoId);
      const linkedWorktreesDir = path.join(linkedRepoDir, 'worktrees');

      // @ts-expect-error - accessing private property for testing
      manager.baseDir = linkRoot;
      // @ts-expect-error - accessing private property for testing
      manager.repoDir = linkedRepoDir;
      // @ts-expect-error - accessing private property for testing
      manager.bareGitDir = path.join(linkedRepoDir, 'bare.git');
      // @ts-expect-error - accessing private property for testing
      manager.worktreesDir = linkedWorktreesDir;
      // @ts-expect-error - accessing private property for testing
      manager.cacheDir = path.join(linkedRepoDir, 'cache');

      await manager.ensureRepo();

      const sessionId = 'symlink1-session-remove' as SessionId;
      const info = await manager.createWorktree(sessionId);

      expect(info.hostPath).toBe(path.join(fs.realpathSync.native(linkedWorktreesDir), sessionId));

      await manager.removeWorktree(sessionId, true);

      expect(fs.existsSync(info.hostPath)).toBe(false);
    });

    it('should succeed for non-existent worktree', async () => {
      await manager.ensureRepo();

      await manager.removeWorktree('nonexistent' as SessionId, true);
    });

    it('should fail for dirty worktree without force', async () => {
      await manager.ensureRepo();

      const sessionId = 'dirty001-session-dirty' as SessionId;
      const info = await manager.createWorktree(sessionId);

      fs.writeFileSync(path.join(info.hostPath, 'dirty.txt'), 'dirty content');

      await expect(manager.removeWorktree(sessionId, false)).rejects.toThrow(/uncommitted changes/);

      await manager.removeWorktree(sessionId, true);
      expect(fs.existsSync(info.hostPath)).toBe(false);
    });

    it('should delete a preserved renamed branch after the worktree was already archived', async () => {
      await manager.ensureRepo();

      const sessionId = 'delete001-session-archived' as SessionId;
      const info = await manager.createWorktree(sessionId);
      fs.writeFileSync(path.join(info.hostPath, 'notes.txt'), 'backup\n', 'utf8');

      const renamedBranch = 'feat/archive-delete-test';
      await manager.renameBranch(sessionId, renamedBranch);
      await manager.archiveWorktree(sessionId);

      await manager.removeWorktree(sessionId, true, renamedBranch);

      // @ts-expect-error - accessing private property for testing
      await expect(
        manager.runGit(['show-ref', '--verify', `refs/heads/${renamedBranch}`], manager.bareGitDir)
      ).rejects.toThrow();
    });

    it('should preserve a legacy reused non-default base branch when removing the worktree', async () => {
      const { sourceDir, remoteBareDir } = createRemoteRepo(testDir, 'main');
      manager.updateRepoUrl(toFileUrl(remoteBareDir));

      runGit(sourceDir, ['checkout', '-b', 'feature/preserve-on-delete']);
      fs.writeFileSync(path.join(sourceDir, 'preserve.txt'), 'preserve\n', 'utf8');
      gitCommit(sourceDir, 'preserve');
      runGit(sourceDir, ['push', '-u', 'origin', 'feature/preserve-on-delete']);
      runGit(sourceDir, ['checkout', 'main']);

      const sessionId = 'preserve1-session-base-branch' as SessionId;
      await manager.ensureRepo();
      // Model a worktree created by an older Lody version, which attached the
      // session directly to the selected non-default base branch.
      const worktreePath = manager.getWorktreeHostPath(sessionId);
      // @ts-expect-error - accessing private property for testing
      runGit(manager.bareGitDir, ['worktree', 'add', worktreePath, 'feature/preserve-on-delete']);

      await manager.removeWorktree(sessionId, true, 'feature/preserve-on-delete', {
        baseBranchName: 'feature/preserve-on-delete',
      });

      expect(fs.existsSync(worktreePath)).toBe(false);
      // @ts-expect-error - accessing private property for testing
      await expect(
        manager.runGit(
          ['show-ref', '--verify', 'refs/heads/feature/preserve-on-delete'],
          manager.bareGitDir
        )
      ).resolves.toBeTruthy();
    });

    it('should keep dirty shared-local worktrees unless force is requested', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({
        kind: 'local-shared',
        originalRootPath: sourceDir,
      });

      const sessionId = 'local002-session-dirty' as SessionId;
      const info = await manager.createWorktree(sessionId);
      fs.writeFileSync(path.join(info.hostPath, 'dirty.txt'), 'dirty\n', 'utf8');

      await expect(manager.removeWorktree(sessionId, false, info.branch)).rejects.toThrow(
        /uncommitted changes/
      );
      expect(fs.existsSync(info.hostPath)).toBe(true);

      await manager.removeWorktree(sessionId, true, info.branch);
      expect(fs.existsSync(info.hostPath)).toBe(false);
    });

    it('should preserve non-lody branches for shared-local worktrees', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({
        kind: 'local-shared',
        originalRootPath: sourceDir,
      });

      const sessionId = 'local003-session-user-branch' as SessionId;
      const info = await manager.createWorktree(sessionId);
      const userBranch = 'feature/user-owned';
      await manager.renameBranch(sessionId, userBranch);

      await manager.removeWorktree(sessionId, true, userBranch);

      expect(fs.existsSync(info.hostPath)).toBe(false);
      expect(runGit(sourceDir, ['show-ref', '--verify', `refs/heads/${userBranch}`])).toBeTruthy();
    });
  });

  describe('archiveWorktree', () => {
    it('should commit non-ignored changes, remove the worktree, and restore from a renamed branch', async () => {
      await manager.ensureRepo();

      const sessionId = 'archive01-session-restore' as SessionId;
      const info = await manager.createWorktree(sessionId);
      runGit(info.hostPath, ['config', 'core.autocrlf', 'false']);

      fs.writeFileSync(path.join(info.hostPath, '.gitignore'), 'dist/\n', 'utf8');
      gitCommit(info.hostPath, 'add ignore rules');

      const renamedBranch = 'feat/archive-backup-restore';
      await manager.renameBranch(sessionId, renamedBranch);

      fs.writeFileSync(path.join(info.hostPath, 'README.md'), '# archived\n', 'utf8');
      fs.writeFileSync(path.join(info.hostPath, 'notes.txt'), 'keep me\n', 'utf8');
      fs.mkdirSync(path.join(info.hostPath, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(info.hostPath, 'dist', 'bundle.js'), 'ignore me\n', 'utf8');

      const archiveResult = await manager.archiveWorktree(sessionId);

      expect(archiveResult.backupCommitCreated).toBe(true);
      expect(archiveResult.branchName).toBe(renamedBranch);
      expect(fs.existsSync(info.hostPath)).toBe(false);

      // @ts-expect-error - accessing private property for testing
      const archiveCommitMessage = await manager.runGit(
        ['log', '-1', '--pretty=%s', renamedBranch],
        manager.bareGitDir
      );
      expect(archiveCommitMessage).toBe(
        `chore: archive backup for session ${sessionId.slice(0, 8)}`
      );

      const restored = await manager.createWorktree(sessionId, undefined, renamedBranch);
      expect(restored.branch).toBe(renamedBranch);
      expect(fs.readFileSync(path.join(restored.hostPath, 'README.md'), 'utf8')).toBe(
        '# archived\n'
      );
      expect(fs.readFileSync(path.join(restored.hostPath, 'notes.txt'), 'utf8')).toBe('keep me\n');
      expect(fs.existsSync(path.join(restored.hostPath, 'dist', 'bundle.js'))).toBe(false);
    });
  });
});
