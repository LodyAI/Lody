import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RepoId, type SessionId, type SessionMeta, SessionStatusFactory } from '@lody/shared';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';

import {
  WorktreeGarbageCollector,
  type WorktreeGcDeps,
  type WorktreeOwnerState,
} from '../src/session/worktree/worktree-gc';
import { getWorktreeManager } from '../src/session/worktree/worktree-manager';
import type { Logger } from '../src/utils/logger';
import {
  createLocalRepo,
  createRemoteRepo,
  gitCommit,
  runGit,
  toFileUrl,
} from './worktree-manager-test-helpers';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const sessionMeta = (id: SessionId, patch: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id,
    machineId: 'machine-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'codex',
    agentType: 'codex',
    status: SessionStatusFactory.idle(),
    ...patch,
  }) as SessionMeta;

describe('WorktreeGarbageCollector', () => {
  let testDir: string;
  let reposDir: string;
  let originalDataDir: string | undefined;
  let originalLocksDir: string | undefined;

  beforeEach(() => {
    // Match WorktreeManager's canonical paths (macOS aliases /var to /private/var).
    testDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lody-worktree-gc-')));
    originalDataDir = process.env.LODY_DATA_DIR;
    originalLocksDir = process.env.LODY_LOCKS_DIR;
    process.env.LODY_DATA_DIR = path.join(testDir, 'data');
    process.env.LODY_LOCKS_DIR = path.join(testDir, 'locks');
    reposDir = path.join(testDir, 'data', 'repos');
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = originalDataDir;
    if (originalLocksDir === undefined) delete process.env.LODY_LOCKS_DIR;
    else process.env.LODY_LOCKS_DIR = originalLocksDir;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const createLocalWorktree = async (sessionId: SessionId) => {
    const rootPath = createLocalRepo(path.join(testDir, sessionId));
    const manager = getWorktreeManager({
      repoId: deriveRepoIdFromLocalProjectPath(rootPath),
      source: { kind: 'local-shared', originalRootPath: rootPath },
      logger: createSilentLogger(),
    });
    const worktree = await manager.createWorktree(sessionId);
    return { rootPath, worktree, manager };
  };

  const createGitHubWorktree = async (sessionId: SessionId) => {
    const { remoteBareDir } = createRemoteRepo(path.join(testDir, sessionId), 'main');
    const manager = getWorktreeManager({
      repoId: `gh-${sessionId}` as RepoId,
      repoUrl: toFileUrl(remoteBareDir),
      logger: createSilentLogger(),
    });
    const worktree = await manager.createWorktree(sessionId);
    return { worktree, manager, bareGitDir: path.join(reposDir, `gh-${sessionId}`, 'bare.git') };
  };

  const createGc = (
    states: Record<string, WorktreeOwnerState>,
    overrides: Partial<WorktreeGcDeps> = {}
  ) => {
    const runCleanupScript = vi.fn(async () => {});
    const recordArchivedBranch = vi.fn(async () => {});
    const gc = new WorktreeGarbageCollector({
      reposDir,
      logger: createSilentLogger(),
      hasCompleteMetadata: () => true,
      readOwnerState: async (sessionId) => states[sessionId] ?? { kind: 'unknown' },
      isRuntimeActive: () => false,
      runCleanupScript,
      recordArchivedBranch,
      ...overrides,
    });
    return { gc, runCleanupScript, recordArchivedBranch };
  };

  it.each(['local', 'github'] as const)(
    'backs up and restores non-ignored work in a %s worktree without preserving ignored files',
    async (kind) => {
      const sessionId = `gc-retention-${kind}` as SessionId;
      const fixture =
        kind === 'local'
          ? await createLocalWorktree(sessionId)
          : await createGitHubWorktree(sessionId);
      const { worktree, manager } = fixture;
      const repoPath = 'rootPath' in fixture ? fixture.rootPath : fixture.bareGitDir;
      fs.writeFileSync(path.join(worktree.hostPath, '.gitignore'), '.env\nbuild/\n', 'utf8');
      fs.writeFileSync(path.join(worktree.hostPath, 'deleted.txt'), 'remove later\n', 'utf8');
      gitCommit(worktree.hostPath, 'prepare retention fixture');
      const previousHead = runGit(repoPath, ['rev-parse', worktree.branch]);
      fs.writeFileSync(path.join(worktree.hostPath, 'README.md'), '# edited\n', 'utf8');
      fs.rmSync(path.join(worktree.hostPath, 'deleted.txt'));
      fs.writeFileSync(path.join(worktree.hostPath, 'pending.txt'), 'untracked work\n', 'utf8');
      fs.writeFileSync(path.join(worktree.hostPath, '.env'), 'SYNTHETIC_FIXTURE=1\n', 'utf8');
      fs.mkdirSync(path.join(worktree.hostPath, 'build'));
      fs.writeFileSync(path.join(worktree.hostPath, 'build', 'output.txt'), 'generated\n', 'utf8');
      const states: Record<string, WorktreeOwnerState> = {
        [sessionId]: {
          kind: 'archived',
          meta: sessionMeta(sessionId, { isArchived: true, branchName: worktree.branch }),
        },
      };
      const { gc } = createGc(states);

      expect((await gc.sweep()).removed).toEqual([sessionId]);
      expect(fs.existsSync(worktree.hostPath)).toBe(false);
      const backupHead = runGit(repoPath, ['rev-parse', worktree.branch]);
      expect(backupHead).not.toBe(previousHead);
      expect(runGit(repoPath, ['show', `${worktree.branch}:README.md`])).toBe('# edited');
      expect(runGit(repoPath, ['show', `${worktree.branch}:pending.txt`])).toBe('untracked work');
      const files = runGit(repoPath, ['ls-tree', '-r', '--name-only', worktree.branch]).split('\n');
      expect(files).not.toContain('deleted.txt');
      expect(files).not.toContain('.env');
      expect(files).not.toContain('build/output.txt');

      states[sessionId] = { kind: 'active' };
      const restored = await manager.createWorktree(sessionId, undefined, worktree.branch);
      expect(restored.branch).toBe(worktree.branch);
      expect(fs.readFileSync(path.join(restored.hostPath, 'README.md'), 'utf8')).toBe('# edited\n');
      expect(fs.readFileSync(path.join(restored.hostPath, 'pending.txt'), 'utf8')).toBe(
        'untracked work\n'
      );
      expect(fs.existsSync(path.join(restored.hostPath, 'deleted.txt'))).toBe(false);
      expect(fs.existsSync(path.join(restored.hostPath, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(restored.hostPath, 'build'))).toBe(false);
      expect((await gc.sweep()).removed).toEqual([]);
      if ('rootPath' in fixture) {
        expect(fs.readFileSync(path.join(fixture.rootPath, 'README.md'), 'utf8')).toBe('# local\n');
      }

      // A deleted owner still gets directory cleanup without deleting its backup branch.
      states[sessionId] = { kind: 'deleted', meta: undefined };
      expect((await gc.sweep()).removed).toEqual([sessionId]);
      expect(fs.existsSync(restored.hostPath)).toBe(false);
      expect(runGit(repoPath, ['rev-parse', worktree.branch])).toBe(backupHead);
    }
  );

  it('preserves pending files when the archive backup commit fails', async () => {
    const sessionId = 'gc-backup-fails' as SessionId;
    const { rootPath, worktree } = await createLocalWorktree(sessionId);
    const originalHead = runGit(rootPath, ['rev-parse', worktree.branch]);
    const hooksDir = path.join(testDir, 'reject-commit-hooks');
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    runGit(rootPath, ['config', 'core.hooksPath', hooksDir]);
    fs.writeFileSync(path.join(worktree.hostPath, 'pending.txt'), 'only copy\n', 'utf8');
    const { gc } = createGc({
      [sessionId]: { kind: 'archived', meta: sessionMeta(sessionId, { isArchived: true }) },
    });

    const result = await gc.sweep();

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([sessionId]);
    expect(fs.readFileSync(path.join(worktree.hostPath, 'pending.txt'), 'utf8')).toBe(
      'only copy\n'
    );
    expect(runGit(rootPath, ['rev-parse', worktree.branch])).toBe(originalHead);
  });

  it('backs up the state left by the cleanup script even when that script fails', async () => {
    const sessionId = 'gc-script-before-backup' as SessionId;
    const { rootPath, worktree } = await createLocalWorktree(sessionId);
    fs.writeFileSync(path.join(worktree.hostPath, 'pending.txt'), 'before cleanup\n', 'utf8');
    const { gc } = createGc(
      { [sessionId]: { kind: 'archived', meta: sessionMeta(sessionId, { isArchived: true }) } },
      {
        runCleanupScript: async ({ worktreePath }) => {
          fs.rmSync(path.join(worktreePath, 'pending.txt'));
          fs.writeFileSync(path.join(worktreePath, 'README.md'), '# after cleanup\n', 'utf8');
          throw new Error('synthetic cleanup failure');
        },
      }
    );

    expect((await gc.sweep()).removed).toEqual([sessionId]);
    expect(fs.existsSync(worktree.hostPath)).toBe(false);
    expect(runGit(rootPath, ['show', `${worktree.branch}:README.md`])).toBe('# after cleanup');
    expect(
      runGit(rootPath, ['ls-tree', '-r', '--name-only', worktree.branch]).split('\n')
    ).not.toContain('pending.txt');
  });

  it('leaves active and unknown worktrees alone', async () => {
    const activeId = 'gc-active' as SessionId;
    const unknownId = 'gc-unknown' as SessionId;
    const active = await createLocalWorktree(activeId);
    const unknown = await createLocalWorktree(unknownId);
    const { gc, runCleanupScript } = createGc({ [activeId]: { kind: 'active' } });

    const result = await gc.sweep();

    expect(result.scanned).toBe(2);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(active.worktree.hostPath)).toBe(true);
    expect(fs.existsSync(unknown.worktree.hostPath)).toBe(true);
    expect(runCleanupScript).not.toHaveBeenCalled();
  });

  it('does nothing until workspace metadata is complete', async () => {
    const sessionId = 'gc-before-sync' as SessionId;
    const { worktree } = await createLocalWorktree(sessionId);
    let complete = false;
    const { gc } = createGc(
      { [sessionId]: { kind: 'deleted', meta: undefined } },
      { hasCompleteMetadata: () => complete }
    );

    expect((await gc.sweep()).scanned).toBe(0);
    expect(fs.existsSync(worktree.hostPath)).toBe(true);

    complete = true;
    expect((await gc.sweep()).removed).toEqual([sessionId]);
    expect(fs.existsSync(worktree.hostPath)).toBe(false);
  });

  it('defers a worktree whose runtime is still being released', async () => {
    const sessionId = 'gc-runtime-active' as SessionId;
    const { worktree } = await createLocalWorktree(sessionId);
    let running = true;
    const { gc } = createGc(
      { [sessionId]: { kind: 'archived', meta: sessionMeta(sessionId, { isArchived: true }) } },
      { isRuntimeActive: () => running }
    );

    await gc.sweep();
    expect(fs.existsSync(worktree.hostPath)).toBe(true);

    running = false;
    await gc.sweep();
    expect(fs.existsSync(worktree.hostPath)).toBe(false);
  });

  it('preserves a worktree whose repository can no longer be resolved', async () => {
    const sessionId = 'gc-repo-gone' as SessionId;
    const { rootPath, worktree } = await createLocalWorktree(sessionId);
    fs.writeFileSync(path.join(worktree.hostPath, 'only-copy.txt'), 'keep me\n', 'utf8');
    fs.rmSync(rootPath, { recursive: true, force: true });
    const { gc, runCleanupScript } = createGc({
      [sessionId]: { kind: 'deleted', meta: undefined },
    });

    const result = await gc.sweep();

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([sessionId]);
    expect(fs.existsSync(path.join(worktree.hostPath, 'only-copy.txt'))).toBe(true);
    expect(runCleanupScript).not.toHaveBeenCalled();
  });

  it('archives a worktree of a project registered as a subdirectory of its repository', async () => {
    const sessionId = 'gc-nested-project' as SessionId;
    const repoRoot = createLocalRepo(path.join(testDir, sessionId));
    const projectRoot = path.join(repoRoot, 'packages', 'app');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export {};\n', 'utf8');
    runGit(repoRoot, ['add', '-A']);
    runGit(repoRoot, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'add package',
    ]);
    const manager = getWorktreeManager({
      repoId: deriveRepoIdFromLocalProjectPath(projectRoot),
      source: { kind: 'local-shared', originalRootPath: projectRoot },
      logger: createSilentLogger(),
    });
    const worktree = await manager.createWorktree(sessionId);
    fs.writeFileSync(path.join(worktree.hostPath, 'pending.txt'), 'unsaved\n', 'utf8');
    const { gc } = createGc({
      [sessionId]: { kind: 'archived', meta: sessionMeta(sessionId, { isArchived: true }) },
    });

    const result = await gc.sweep();

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktree.hostPath)).toBe(false);
    expect(runGit(repoRoot, ['show', `${worktree.branch}:pending.txt`])).toBe('unsaved');
  });

  it('records the branch git reports when it differs from session metadata', async () => {
    const sessionId = 'gc-renamed-branch' as SessionId;
    const { rootPath, worktree } = await createLocalWorktree(sessionId);
    const renamed = `${worktree.branch}-renamed`;
    runGit(worktree.hostPath, ['branch', '-m', renamed]);
    const { gc, recordArchivedBranch } = createGc({
      [sessionId]: {
        kind: 'archived',
        meta: sessionMeta(sessionId, { isArchived: true, branchName: worktree.branch }),
      },
    });

    await gc.sweep();

    expect(recordArchivedBranch).toHaveBeenCalledWith(sessionId, renamed);
    expect(runGit(rootPath, ['branch', '--list', renamed])).toContain(renamed);
  });

  it('retries a failed removal only after its backoff has elapsed', async () => {
    const sessionId = 'gc-retry' as SessionId;
    const { worktree } = await createLocalWorktree(sessionId);
    // A file where git expects the worktree's own `.git` link makes every git
    // operation in this worktree fail while the directory itself stays intact.
    fs.rmSync(path.join(worktree.hostPath, '.git'), { force: true });
    fs.mkdirSync(path.join(worktree.hostPath, '.git'));
    let nowMs = 1_000_000;
    const { gc } = createGc(
      { [sessionId]: { kind: 'archived', meta: sessionMeta(sessionId, { isArchived: true }) } },
      { now: () => nowMs, retryBaseDelayMs: 1_000, retryMaxDelayMs: 4_000 }
    );

    const first = await gc.sweep();
    expect(first.failed).toEqual([sessionId]);
    expect(fs.existsSync(worktree.hostPath)).toBe(true);

    nowMs += 500;
    const tooEarly = await gc.sweep();
    expect(tooEarly.failed).toEqual([]);
    expect(tooEarly.removed).toEqual([]);

    nowMs += 600;
    const retried = await gc.sweep();
    expect(retried.failed).toEqual([sessionId]);
  });

  it('coalesces overlapping schedule() calls into one follow-up sweep', async () => {
    const sessionId = 'gc-coalesce' as SessionId;
    const { worktree } = await createLocalWorktree(sessionId);
    let sweeps = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish: () => void = () => {};
    const removed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { gc } = createGc(
      {},
      {
        readOwnerState: async () => {
          sweeps += 1;
          await gate;
          return sweeps === 1
            ? { kind: 'active' }
            : { kind: 'archived', meta: sessionMeta(sessionId, { isArchived: true }) };
        },
        recordArchivedBranch: async () => finish(),
      }
    );

    const first = gc.schedule();
    const second = gc.schedule();
    const third = gc.schedule();
    expect(second).toBe(first);
    expect(third).toBe(first);
    release();
    await first;
    await removed;
    expect(sweeps).toBe(2);
    expect(fs.existsSync(worktree.hostPath)).toBe(false);
  });
});
