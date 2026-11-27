import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STATUS_VIEW_SETTLE_INACTIVITY_MS,
  type RepoId,
  type SessionId,
  type SessionMeta,
  SessionStatusFactory,
} from '@lody/shared';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';

import {
  cleanWorktreeArtifacts,
  DEFAULT_ARTIFACT_DIR_NAMES,
  hasWorktreeArtifactsCleaned,
} from '../src/session/worktree/worktree-artifact-cleaner';
import {
  resolveSettledSinceMs,
  SETTLED_ARTIFACT_CLEANUP_GRACE_MS,
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
  let chatsDir: string;
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
    chatsDir = path.join(testDir, 'data', 'chats');
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    const gc = new WorktreeGarbageCollector({
      reposDir,
      chatsDir,
      logger: createSilentLogger(),
      hasCompleteMetadata: () => true,
      readOwnerState: async (sessionId) => states[sessionId] ?? { kind: 'unknown' },
      isRuntimeActive: () => false,
      runCleanupScript: async () => {},
      recordArchivedBranch: async () => {},
      ...overrides,
    });
    return { gc };
  };

  const createChatWorkdir = (sessionId: string, content?: string) => {
    const workdir = path.join(chatsDir, sessionId);
    fs.mkdirSync(workdir, { recursive: true });
    if (content !== undefined) fs.writeFileSync(path.join(workdir, 'artifact.txt'), content);
    return workdir;
  };

  it('removes deleted chat workdirs recursively without running worktree hooks', async () => {
    const sessionId = 'gc-chat-deleted' as SessionId;
    const workdir = createChatWorkdir(sessionId, 'generated file');
    fs.mkdirSync(path.join(workdir, 'nested'));
    fs.writeFileSync(path.join(workdir, 'nested', 'output.txt'), 'nested output');
    const hookMarker = path.join(testDir, 'worktree-hook-ran');
    const { gc } = createGc(
      { [sessionId]: { kind: 'deleted', meta: undefined } },
      {
        runCleanupScript: async () => fs.writeFileSync(hookMarker, 'cleanup'),
        recordArchivedBranch: async () => fs.writeFileSync(hookMarker, 'branch'),
      }
    );

    expect(await gc.sweep()).toEqual({
      scanned: 1,
      removed: [sessionId],
      artifactsCleaned: [],
      failed: [],
    });
    expect(fs.existsSync(workdir)).toBe(false);
    expect(fs.existsSync(hookMarker)).toBe(false);
  });

  it('removes only empty archived chat workdirs and later deletes retained files', async () => {
    const emptyId = 'gc-chat-empty' as SessionId;
    const fullId = 'gc-chat-full' as SessionId;
    const empty = createChatWorkdir(emptyId);
    const full = createChatWorkdir(fullId, 'keep until deletion');
    const states: Record<string, WorktreeOwnerState> = {
      [emptyId]: { kind: 'archived', meta: sessionMeta(emptyId, { isArchived: true }) },
      [fullId]: { kind: 'archived', meta: sessionMeta(fullId, { isArchived: true }) },
    };
    const warnings: string[] = [];
    const { gc } = createGc(states, {
      logger: { ...createSilentLogger(), warn: (message) => warnings.push(message) },
      runCleanupScript: async () => fs.writeFileSync(path.join(full, 'hook-ran'), ''),
      recordArchivedBranch: async () => fs.writeFileSync(path.join(full, 'hook-ran'), ''),
    });

    expect(await gc.sweep()).toEqual({
      scanned: 2,
      removed: [emptyId],
      artifactsCleaned: [],
      failed: [],
    });
    expect(fs.existsSync(empty)).toBe(false);
    expect(fs.readdirSync(full)).toEqual(['artifact.txt']);
    expect(fs.readFileSync(path.join(full, 'artifact.txt'), 'utf8')).toBe('keep until deletion');
    expect(warnings).toEqual([]);

    const rmdir = fs.promises.rmdir;
    vi.spyOn(fs.promises, 'rmdir').mockImplementation(async (target, options) => {
      if (target === full)
        throw Object.assign(new Error('directory not empty'), { code: 'EEXIST' });
      return rmdir(target, options);
    });
    expect(await gc.sweep()).toEqual({
      scanned: 1,
      removed: [],
      artifactsCleaned: [],
      failed: [],
    });
    expect(fs.readFileSync(path.join(full, 'artifact.txt'), 'utf8')).toBe('keep until deletion');
    expect(warnings).toEqual([]);

    // Neither nonempty-directory error backs off: deletion takes effect immediately.
    states[fullId] = { kind: 'deleted', meta: undefined };
    expect((await gc.sweep()).removed).toEqual([fullId]);
    expect(fs.existsSync(full)).toBe(false);
  });

  it('leaves active and unknown chat workdirs alone', async () => {
    const activeId = 'gc-chat-active' as SessionId;
    const unknownId = 'gc-chat-unknown' as SessionId;
    const active = createChatWorkdir(activeId);
    const unknown = createChatWorkdir(unknownId);
    const { gc } = createGc({ [activeId]: { kind: 'active' } });

    expect(await gc.sweep()).toEqual({
      scanned: 2,
      removed: [],
      artifactsCleaned: [],
      failed: [],
    });
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);
  });

  it('waits for complete metadata and runtime release before removing chat workdirs', async () => {
    const sessionId = 'gc-chat-deferred' as SessionId;
    const workdir = createChatWorkdir(sessionId, 'pending files');
    let complete = false;
    let running = true;
    const { gc } = createGc(
      { [sessionId]: { kind: 'deleted', meta: undefined } },
      { hasCompleteMetadata: () => complete, isRuntimeActive: () => running }
    );

    expect((await gc.sweep()).scanned).toBe(0);
    expect(fs.existsSync(workdir)).toBe(true);
    complete = true;
    expect(await gc.sweep()).toEqual({
      scanned: 1,
      removed: [],
      artifactsCleaned: [],
      failed: [],
    });
    expect(fs.existsSync(workdir)).toBe(true);
    running = false;
    expect((await gc.sweep()).removed).toEqual([sessionId]);
    expect(fs.existsSync(workdir)).toBe(false);
  });

  it('silently accepts a missing chats root and still cleans worktrees', async () => {
    const sessionId = 'gc-no-chats-root' as SessionId;
    const { worktree } = await createLocalWorktree(sessionId);
    const warnings: string[] = [];
    const { gc } = createGc(
      { [sessionId]: { kind: 'deleted', meta: undefined } },
      { logger: { ...createSilentLogger(), warn: (message) => warnings.push(message) } }
    );

    expect(fs.existsSync(chatsDir)).toBe(false);
    expect(await gc.sweep()).toEqual({
      scanned: 1,
      removed: [sessionId],
      artifactsCleaned: [],
      failed: [],
    });
    expect(fs.existsSync(worktree.hostPath)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it.each(['deleted', 'archived', 'owner-read'] as const)(
    'isolates a chat %s failure and retries after backoff while worktrees are cleaned',
    async (failure) => {
      const sessionId = 'gc-chat-retry' as SessionId;
      const workdir = createChatWorkdir(sessionId, failure === 'archived' ? undefined : 'keep');
      const worktreeId = 'gc-independent-worktree' as SessionId;
      const { worktree } = await createLocalWorktree(worktreeId);
      const states: Record<string, WorktreeOwnerState> = {
        [sessionId]:
          failure === 'archived'
            ? { kind: 'archived', meta: sessionMeta(sessionId, { isArchived: true }) }
            : { kind: 'deleted', meta: undefined },
        [worktreeId]: { kind: 'deleted', meta: undefined },
      };
      let nowMs = 1_000_000;
      let failing = true;
      const error = Object.assign(new Error('synthetic busy directory'), { code: 'EBUSY' });
      const remove = fs.promises.rm;
      const rmdir = fs.promises.rmdir;
      vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
        if (failing && target === workdir && failure === 'deleted') throw error;
        return remove(target, options);
      });
      vi.spyOn(fs.promises, 'rmdir').mockImplementation(async (target, options) => {
        if (failing && target === workdir && failure === 'archived') throw error;
        return rmdir(target, options);
      });
      const { gc } = createGc(states, {
        now: () => nowMs,
        retryBaseDelayMs: 1_000,
        readOwnerState: async (id) => {
          if (failing && id === sessionId && failure === 'owner-read') throw error;
          return states[id] ?? { kind: 'unknown' };
        },
      });

      expect(await gc.sweep()).toEqual({
        scanned: 2,
        removed: [worktreeId],
        artifactsCleaned: [],
        failed: [sessionId],
      });
      expect(fs.existsSync(worktree.hostPath)).toBe(false);
      expect(fs.existsSync(workdir)).toBe(true);
      failing = false;
      nowMs += 999;
      expect(await gc.sweep()).toEqual({
        scanned: 1,
        removed: [],
        artifactsCleaned: [],
        failed: [],
      });
      expect(fs.existsSync(workdir)).toBe(true);
      nowMs += 1;
      expect((await gc.sweep()).removed).toEqual([sessionId]);
      expect(fs.existsSync(workdir)).toBe(false);
    }
  );

  it('backs off an unreadable chats root without blocking worktree cleanup', async () => {
    const sessionId = 'gc-chat-root-retry' as SessionId;
    const { worktree } = await createLocalWorktree(sessionId);
    fs.mkdirSync(path.dirname(chatsDir), { recursive: true });
    fs.writeFileSync(chatsDir, 'not a directory');
    let nowMs = 1_000_000;
    const { gc } = createGc(
      { [sessionId]: { kind: 'deleted', meta: undefined } },
      { now: () => nowMs, retryBaseDelayMs: 1_000 }
    );

    expect((await gc.sweep()).removed).toEqual([sessionId]);
    expect(fs.existsSync(worktree.hostPath)).toBe(false);
    fs.rmSync(chatsDir);
    const workdir = createChatWorkdir(sessionId, 'retry root read');
    expect((await gc.sweep()).scanned).toBe(0);
    expect(fs.existsSync(workdir)).toBe(true);
    nowMs += 1_000;
    expect((await gc.sweep()).removed).toEqual([sessionId]);
    expect(fs.existsSync(workdir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'skips symlinks, files and unsafe chat directory names',
    async () => {
      const sessionId = 'gc-chat-link' as SessionId;
      const target = path.join(testDir, 'external');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'keep.txt'), 'outside chats');
      const unsafe = createChatWorkdir('unsafe.name', 'keep unsafe');
      fs.symlinkSync(target, path.join(chatsDir, sessionId), 'dir');
      fs.writeFileSync(path.join(chatsDir, 'regular-file'), 'keep file');
      const { gc } = createGc(
        {},
        {
          readOwnerState: async () => ({ kind: 'deleted', meta: undefined }),
        }
      );

      expect(await gc.sweep()).toEqual({
        scanned: 0,
        removed: [],
        artifactsCleaned: [],
        failed: [],
      });
      expect(fs.lstatSync(path.join(chatsDir, sessionId)).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('outside chats');
      expect(fs.readFileSync(path.join(unsafe, 'artifact.txt'), 'utf8')).toBe('keep unsafe');
      expect(fs.readFileSync(path.join(chatsDir, 'regular-file'), 'utf8')).toBe('keep file');
    }
  );

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
    const { gc } = createGc({ [activeId]: { kind: 'active' } });

    const result = await gc.sweep();

    expect(result.scanned).toBe(2);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(active.worktree.hostPath)).toBe(true);
    expect(fs.existsSync(unknown.worktree.hostPath)).toBe(true);
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
    const { gc } = createGc({
      [sessionId]: { kind: 'deleted', meta: undefined },
    });

    const result = await gc.sweep();

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([sessionId]);
    expect(fs.existsSync(path.join(worktree.hostPath, 'only-copy.txt'))).toBe(true);
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
    const meta = sessionMeta(sessionId, { isArchived: true, branchName: worktree.branch });
    const { gc } = createGc(
      {
        [sessionId]: {
          kind: 'archived',
          meta,
        },
      },
      {
        recordArchivedBranch: async (_, branchName) => {
          meta.branchName = branchName;
        },
      }
    );

    await gc.sweep();

    expect(meta.branchName).toBe(renamed);
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

  describe('settled worktree code artifact cleanup', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it('resolves settled timestamps consistently with statusViewTier rules', () => {
      const nowMs = 1_800_000_000_000;
      const explicitAt = nowMs - 2 * DAY_MS;

      expect(
        resolveSettledSinceMs(
          sessionMeta('s1' as SessionId, {
            lastMessageAt: explicitAt - 1_000,
            settledAt: explicitAt,
          }),
          nowMs
        )
      ).toBe(explicitAt);

      // Newer message reopens a settled session.
      expect(
        resolveSettledSinceMs(
          sessionMeta('s1' as SessionId, {
            lastMessageAt: explicitAt + 1_000,
            settledAt: explicitAt,
          }),
          nowMs
        )
      ).toBeNull();

      // Inactive for >= 7 days auto-settles at lastMessageAt + 7d.
      const inactiveAt = nowMs - STATUS_VIEW_SETTLE_INACTIVITY_MS - DAY_MS;
      expect(
        resolveSettledSinceMs(sessionMeta('s2' as SessionId, { lastMessageAt: inactiveAt }), nowMs)
      ).toBe(inactiveAt + STATUS_VIEW_SETTLE_INACTIVITY_MS);

      // Focus restore overrides 7-day auto-settle for 7 days.
      expect(
        resolveSettledSinceMs(
          sessionMeta('s2' as SessionId, {
            lastMessageAt: inactiveAt,
            focusRestoredAt: nowMs - DAY_MS,
          }),
          nowMs
        )
      ).toBeNull();

      // Pinned, snoozed, child Tabs, archived, running, and permission-waiting are never settled.
      expect(
        resolveSettledSinceMs(
          sessionMeta('s3' as SessionId, { settledAt: explicitAt, isPinned: true }),
          nowMs
        )
      ).toBeNull();
      expect(
        resolveSettledSinceMs(
          sessionMeta('s3' as SessionId, { settledAt: explicitAt, snoozedUntil: nowMs + 60_000 }),
          nowMs
        )
      ).toBeNull();
      expect(
        resolveSettledSinceMs(
          sessionMeta('s3' as SessionId, {
            settledAt: explicitAt,
            parentSessionId: 'root' as SessionId,
          }),
          nowMs
        )
      ).toBeNull();
      expect(
        resolveSettledSinceMs(
          sessionMeta('s3' as SessionId, { settledAt: explicitAt, isArchived: true }),
          nowMs
        )
      ).toBeNull();
      expect(
        resolveSettledSinceMs(
          sessionMeta('s3' as SessionId, {
            lastMessageAt: inactiveAt,
            status: SessionStatusFactory.running(),
          }),
          nowMs
        )
      ).toBeNull();
      expect(
        resolveSettledSinceMs(
          sessionMeta('s3' as SessionId, {
            settledAt: explicitAt,
            status: SessionStatusFactory.requestPermission('tool', 'approve'),
          }),
          nowMs
        )
      ).toBeNull();
    });

    it('deletes only gitignored built-in artifact dirs and preserves non-ignored, stateful, and symlinked dirs', async () => {
      const sessionId = 'gc-artifacts-safety' as SessionId;
      const { worktree } = await createLocalWorktree(sessionId);

      // Configure gitignore: ignore node_modules, dist, .terraform, tmp; do NOT ignore build/.
      fs.writeFileSync(
        path.join(worktree.hostPath, '.gitignore'),
        'node_modules/\ndist/\npackages/*/dist/\n.terraform/\ntmp/\n'
      );

      // Ignored artifact dirs (should be removed).
      fs.mkdirSync(path.join(worktree.hostPath, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(worktree.hostPath, 'node_modules', 'pkg', 'index.js'), 'x');
      fs.mkdirSync(path.join(worktree.hostPath, 'packages', 'web', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(worktree.hostPath, 'packages', 'web', 'dist', 'app.js'), 'x');

      // Matching dir name NOT ignored by git (must be preserved).
      fs.mkdirSync(path.join(worktree.hostPath, 'build'), { recursive: true });
      fs.writeFileSync(path.join(worktree.hostPath, 'build', 'keep.txt'), 'tracked-or-unignored');

      // Ignored stateful/user-managed dirs NOT in DEFAULT_ARTIFACT_DIR_NAMES (must be preserved).
      fs.mkdirSync(path.join(worktree.hostPath, '.terraform'), { recursive: true });
      fs.writeFileSync(path.join(worktree.hostPath, '.terraform', 'state.tfstate'), 'secret');
      fs.mkdirSync(path.join(worktree.hostPath, 'tmp'), { recursive: true });
      fs.writeFileSync(path.join(worktree.hostPath, 'tmp', 'notes.txt'), 'keep');
      expect(DEFAULT_ARTIFACT_DIR_NAMES.has('.terraform')).toBe(false);
      expect(DEFAULT_ARTIFACT_DIR_NAMES.has('tmp')).toBe(false);

      // Symlink named `dist` pointing outside the worktree (must not be deleted or followed).
      const externalTarget = path.join(testDir, 'external-dir');
      fs.mkdirSync(externalTarget, { recursive: true });
      fs.writeFileSync(path.join(externalTarget, 'important.txt'), 'do-not-delete');
      fs.symlinkSync(externalTarget, path.join(worktree.hostPath, 'dist'));

      // Uncommitted user source file (must be preserved).
      fs.writeFileSync(path.join(worktree.hostPath, 'uncommitted.ts'), 'export const a = 1;');

      const result = await cleanWorktreeArtifacts(worktree.hostPath);

      expect(result.errors).toEqual([]);
      expect(result.aborted).toBe(false);
      expect(result.deletedPaths.sort()).toEqual(
        [
          path.join(worktree.hostPath, 'node_modules'),
          path.join(worktree.hostPath, 'packages', 'web', 'dist'),
        ].sort()
      );
      expect(fs.existsSync(path.join(worktree.hostPath, 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(worktree.hostPath, 'packages', 'web', 'dist'))).toBe(false);
      expect(fs.existsSync(path.join(worktree.hostPath, 'build', 'keep.txt'))).toBe(true);
      expect(fs.existsSync(path.join(worktree.hostPath, '.terraform', 'state.tfstate'))).toBe(true);
      expect(fs.existsSync(path.join(worktree.hostPath, 'tmp', 'notes.txt'))).toBe(true);
      expect(fs.lstatSync(path.join(worktree.hostPath, 'dist')).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(externalTarget, 'important.txt'))).toBe(true);
      expect(fs.existsSync(path.join(worktree.hostPath, 'uncommitted.ts'))).toBe(true);
      expect(fs.existsSync(path.join(worktree.hostPath, '.git'))).toBe(true);
    });

    it('cleans nested git repos inside a multi-repo worktree without escaping the worktree root', async () => {
      const groupRoot = path.join(testDir, 'project-group-worktree');
      fs.mkdirSync(groupRoot, { recursive: true });
      const memberA = createLocalRepo(path.join(groupRoot, 'member-a'));
      fs.writeFileSync(path.join(memberA, '.gitignore'), 'target/\n');
      fs.mkdirSync(path.join(memberA, 'target', 'debug'), { recursive: true });
      fs.writeFileSync(path.join(memberA, 'target', 'debug', 'bin'), 'x');

      // Non-git sibling inside groupRoot: must be skipped because no `.git` owns it.
      fs.mkdirSync(path.join(groupRoot, 'non-git', 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(groupRoot, 'non-git', 'node_modules', 'keep.js'), 'x');

      const result = await cleanWorktreeArtifacts(groupRoot);
      expect(result.errors).toEqual([]);
      expect(result.deletedPaths).toEqual([path.join(memberA, 'target')]);
      expect(fs.existsSync(path.join(memberA, 'target'))).toBe(false);
      expect(fs.existsSync(path.join(groupRoot, 'non-git', 'node_modules', 'keep.js'))).toBe(true);
    });

    it('waits for the grace period, defers while runtime is active, caches clean state, and re-cleans after reactivation', async () => {
      const sessionId = 'gc-settled-lifecycle' as SessionId;
      const { worktree } = await createLocalWorktree(sessionId);
      fs.writeFileSync(path.join(worktree.hostPath, '.gitignore'), 'node_modules/\ndist/\n');
      const nodeModules = path.join(worktree.hostPath, 'node_modules');
      fs.mkdirSync(nodeModules, { recursive: true });
      fs.writeFileSync(path.join(nodeModules, 'a.js'), '1');

      const settledAt = 10_000_000;
      let nowMs = settledAt + SETTLED_ARTIFACT_CLEANUP_GRACE_MS - 1;
      let runtimeActive = false;
      let ownerState: WorktreeOwnerState = {
        kind: 'settled',
        meta: sessionMeta(sessionId, { settledAt }),
        settledSinceMs: settledAt,
      };
      let cleanCalls = 0;

      const { gc } = createGc(
        {},
        {
          now: () => nowMs,
          readOwnerState: async () => ownerState,
          isRuntimeActive: () => runtimeActive,
          cleanArtifacts: async (worktreePath, options) => {
            cleanCalls += 1;
            return cleanWorktreeArtifacts(worktreePath, options);
          },
        }
      );

      // Before 24h grace period: untouched.
      const tooSoon = await gc.sweep();
      expect(tooSoon.artifactsCleaned).toEqual([]);
      expect(cleanCalls).toBe(0);
      expect(fs.existsSync(nodeModules)).toBe(true);

      // Grace period elapsed, but runtime is active: deferred.
      nowMs = settledAt + SETTLED_ARTIFACT_CLEANUP_GRACE_MS;
      runtimeActive = true;
      const whileActive = await gc.sweep();
      expect(whileActive.artifactsCleaned).toEqual([]);
      expect(cleanCalls).toBe(0);
      expect(fs.existsSync(nodeModules)).toBe(true);

      // Runtime becomes idle: cleans artifacts while keeping the worktree.
      runtimeActive = false;
      const cleaned = await gc.sweep();
      expect(cleaned.artifactsCleaned).toEqual([sessionId]);
      expect(cleaned.removed).toEqual([]);
      expect(cleanCalls).toBe(1);
      expect(fs.existsSync(nodeModules)).toBe(false);
      expect(fs.existsSync(worktree.hostPath)).toBe(true);

      // Subsequent sweep for the same settled period does not rescan.
      const cached = await gc.sweep();
      expect(cached.artifactsCleaned).toEqual([]);
      expect(cleanCalls).toBe(1);

      // Session returns to active, creates new build output, and settles again later.
      ownerState = { kind: 'active' };
      await gc.sweep();
      const distDir = path.join(worktree.hostPath, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'bundle.js'), '2');

      const secondSettledAt = nowMs + 60_000;
      ownerState = {
        kind: 'settled',
        meta: sessionMeta(sessionId, { settledAt: secondSettledAt }),
        settledSinceMs: secondSettledAt,
      };
      nowMs = secondSettledAt + SETTLED_ARTIFACT_CLEANUP_GRACE_MS;

      const cleanedAgain = await gc.sweep();
      expect(cleanedAgain.artifactsCleaned).toEqual([sessionId]);
      expect(cleanCalls).toBe(2);
      expect(fs.existsSync(distDir)).toBe(false);
    });

    it('backs off and retries when settled artifact cleanup encounters git errors', async () => {
      const sessionId = 'gc-settled-retry' as SessionId;
      const { worktree } = await createLocalWorktree(sessionId);
      fs.mkdirSync(path.join(worktree.hostPath, 'node_modules'), { recursive: true });
      // Corrupt `.git` so `git check-ignore` fails.
      fs.rmSync(path.join(worktree.hostPath, '.git'), { force: true });
      fs.mkdirSync(path.join(worktree.hostPath, '.git'));

      const settledAt = 1_000_000;
      let nowMs = settledAt + SETTLED_ARTIFACT_CLEANUP_GRACE_MS;
      const { gc } = createGc(
        {
          [sessionId]: {
            kind: 'settled',
            meta: sessionMeta(sessionId, { settledAt }),
            settledSinceMs: settledAt,
          },
        },
        { now: () => nowMs, retryBaseDelayMs: 1_000, retryMaxDelayMs: 4_000 }
      );

      const first = await gc.sweep();
      expect(first.failed).toEqual([sessionId]);
      expect(first.artifactsCleaned).toEqual([]);
      expect(fs.existsSync(path.join(worktree.hostPath, 'node_modules'))).toBe(true);

      nowMs += 500;
      const tooEarly = await gc.sweep();
      expect(tooEarly.failed).toEqual([]);

      nowMs += 600;
      const retried = await gc.sweep();
      expect(retried.failed).toEqual([sessionId]);
    });

    it('excludes recovery/config dirs (.ipynb_checkpoints, .swiftpm, .vs) and never deletes across nested .git boundaries', async () => {
      expect(DEFAULT_ARTIFACT_DIR_NAMES.has('.ipynb_checkpoints')).toBe(false);
      expect(DEFAULT_ARTIFACT_DIR_NAMES.has('.swiftpm')).toBe(false);
      expect(DEFAULT_ARTIFACT_DIR_NAMES.has('.vs')).toBe(false);

      const sessionId = 'gc-nested-git-safety' as SessionId;
      const { worktree } = await createLocalWorktree(sessionId);
      fs.writeFileSync(
        path.join(worktree.hostPath, '.gitignore'),
        '.ipynb_checkpoints/\n.swiftpm/\n.vs/\ndist/\nbuild/\n'
      );

      // Recovery/user-state dirs must be preserved even when ignored.
      for (const dir of ['.ipynb_checkpoints', '.swiftpm', '.vs']) {
        fs.mkdirSync(path.join(worktree.hostPath, dir), { recursive: true });
        fs.writeFileSync(path.join(worktree.hostPath, dir, 'keep.json'), '{}');
      }

      // Case 1: `build/` is itself a nested independent Git repo whose own `target/` is ignored.
      const nestedAtCandidate = path.join(worktree.hostPath, 'build');
      fs.mkdirSync(nestedAtCandidate, { recursive: true });
      runGit(nestedAtCandidate, ['init']);
      fs.writeFileSync(path.join(nestedAtCandidate, '.gitignore'), 'target/\n');
      fs.mkdirSync(path.join(nestedAtCandidate, 'target'), { recursive: true });
      fs.writeFileSync(path.join(nestedAtCandidate, 'target', 'artifact.o'), 'x');
      fs.writeFileSync(path.join(nestedAtCandidate, 'staged.txt'), 'keep');
      runGit(nestedAtCandidate, ['add', 'staged.txt']);

      // Case 2: `dist/` is ignored by outer repo, and contains a nested independent Git repo deeper inside.
      const nestedInsideCandidate = createLocalRepo(path.join(worktree.hostPath, 'dist', 'sub'));
      fs.writeFileSync(path.join(nestedInsideCandidate, 'important.txt'), 'keep');
      runGit(nestedInsideCandidate, ['add', 'important.txt']);

      const result = await cleanWorktreeArtifacts(worktree.hostPath);
      expect(result.errors).toEqual([]);
      // Only the nested repo's own ignored `target/` is deleted; neither nested repo is removed.
      expect(result.deletedPaths).toEqual([path.join(nestedAtCandidate, 'target')]);
      expect(fs.existsSync(path.join(nestedAtCandidate, 'staged.txt'))).toBe(true);
      expect(fs.existsSync(path.join(nestedAtCandidate, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(nestedInsideCandidate, 'important.txt'))).toBe(true);
      expect(fs.existsSync(path.join(nestedInsideCandidate, '.git'))).toBe(true);
      for (const dir of ['.ipynb_checkpoints', '.swiftpm', '.vs']) {
        expect(fs.existsSync(path.join(worktree.hostPath, dir, 'keep.json'))).toBe(true);
      }
    });

    it('records an artifact-cleaned marker on cleanup, aborts if owner leaves settled mid-sweep, and honors grace after unpinning', async () => {
      const sessionId = 'gc-marker-and-unpin' as SessionId;
      const { worktree } = await createLocalWorktree(sessionId);
      fs.writeFileSync(path.join(worktree.hostPath, '.gitignore'), 'node_modules/\ndist/\n');
      fs.mkdirSync(path.join(worktree.hostPath, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(worktree.hostPath, 'node_modules', 'a.js'), '1');

      const oldSettledAt = 1_000_000;
      let nowMs = oldSettledAt + 10 * DAY_MS;
      // Initially pinned -> treated as active by readOwnerState.
      let ownerState: WorktreeOwnerState = { kind: 'active' };
      const { gc } = createGc({}, { now: () => nowMs, readOwnerState: async () => ownerState });

      // Observe as active (pinned) at `nowMs`.
      await gc.sweep();
      expect(hasWorktreeArtifactsCleaned(worktree.hostPath)).toBe(false);

      // Unpinned right after: even though `oldSettledAt` is 10d old, grace period starts from leaving active.
      ownerState = {
        kind: 'settled',
        meta: sessionMeta(sessionId, { settledAt: oldSettledAt }),
        settledSinceMs: oldSettledAt,
      };
      nowMs += SETTLED_ARTIFACT_CLEANUP_GRACE_MS - 1;
      expect((await gc.sweep()).artifactsCleaned).toEqual([]);
      expect(fs.existsSync(path.join(worktree.hostPath, 'node_modules'))).toBe(true);

      // Once 24h elapse after leaving active, cleanup runs and writes the setup marker.
      nowMs += 1;
      const cleaned = await gc.sweep();
      expect(cleaned.artifactsCleaned).toEqual([sessionId]);
      expect(fs.existsSync(path.join(worktree.hostPath, 'node_modules'))).toBe(false);
      expect(hasWorktreeArtifactsCleaned(worktree.hostPath)).toBe(true);
    });

    it('surfaces scan readdir errors instead of caching an incomplete cleanup as clean', async () => {
      const sessionId = 'gc-readdir-error' as SessionId;
      const { worktree } = await createLocalWorktree(sessionId);
      const unreadableDir = path.join(worktree.hostPath, 'sub');
      fs.mkdirSync(unreadableDir, { recursive: true });

      const readdir = fs.promises.readdir;
      vi.spyOn(fs.promises, 'readdir').mockImplementation((async (
        target: fs.PathLike,
        options?: unknown
      ) => {
        if (path.resolve(String(target)) === path.resolve(unreadableDir)) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return readdir(target, options as never);
      }) as typeof fs.promises.readdir);

      const settledAt = 1_000_000;
      const { gc } = createGc(
        {
          [sessionId]: {
            kind: 'settled',
            meta: sessionMeta(sessionId, { settledAt }),
            settledSinceMs: settledAt,
          },
        },
        { now: () => settledAt + SETTLED_ARTIFACT_CLEANUP_GRACE_MS }
      );

      const result = await gc.sweep();
      expect(result.failed).toEqual([sessionId]);
      expect(result.artifactsCleaned).toEqual([]);
    });
  });
});
