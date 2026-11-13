import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { CodeCollabV2Service } from '../lib/code-collab/code-collab-v2-service';
import { WorkspaceGitService } from './workspace-git-service';
const execFileAsync = promisify(execFile);
import { describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, ProjectRef, SessionId, SessionMeta, WorkspaceId } from '@lody/shared';

import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type { ISession } from './session-manager';
import { TurnPostProcessingService } from './turn-post-processing-service';

const sessionId = 'session-1' as SessionId;
const parentSessionId = 'parent-session-1' as SessionId;
const workspaceId = 'workspace-1' as WorkspaceId;
const githubProject: ProjectRef = {
  kind: 'github',
  repoFullName: 'owner/repo',
  branch: 'main',
};
const localProject: ProjectRef = {
  kind: 'local',
  localProjectId: 'local-project-1' as LocalProjectId,
  githubRepoFullName: 'owner/repo',
  branch: 'main',
};

const pullRequest: NonNullable<SessionMeta['pullRequests']>[number] = {
  url: 'https://github.com/owner/repo/pull/1',
  number: 1,
  status: 'open',
  repository: 'owner/repo',
  branch: 'feature',
  reportedAt: '2026-04-22T00:00:00.000Z',
};

const createLogger = () =>
  ({
    debug: vi.fn(),
    trace: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }) as unknown as Logger;

const createSessionDoc = () =>
  ({
    getMetaState: vi.fn(async () => ({
      pullRequests: [pullRequest],
    })),
  }) as unknown as SessionDocument;

const createService = (options: { logger: Logger; workspaceDocument?: LoroDocumentManager }) =>
  new TurnPostProcessingService({
    logger: options.logger,
    workspaceDocument: options.workspaceDocument ?? ({} as unknown as LoroDocumentManager),
    workspaceId,
    preferredBaseBranch: 'main',
    prAssociation: null,
  });

describe('TurnPostProcessingService', () => {
  it('detects a PR for a GitHub-capable direct local project', async () => {
    const logger = createLogger();
    const service = createService({ logger });
    const exec = vi.fn(async () =>
      JSON.stringify([
        {
          number: 42,
          url: 'https://github.com/owner/repo/pull/42',
          state: 'OPEN',
          isDraft: false,
          headRefName: 'feature/local',
          baseRefName: 'main',
        },
      ])
    );
    const session = {
      getWorkdir: () => '/repo',
      exec,
    } as unknown as ISession;

    const detected = await service.detectAndAssociatePR({
      sessionId,
      session,
      sessionDoc: createSessionDoc(),
      project: localProject,
      branchName: 'feature/local',
    });

    expect(detected?.prNumber).toBe(42);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('still detects a PR for a local-project worktree', async () => {
    const logger = createLogger();
    const service = createService({ logger });
    const exec = vi.fn(async () =>
      JSON.stringify([
        {
          number: 42,
          url: 'https://github.com/owner/repo/pull/42',
          state: 'OPEN',
          isDraft: false,
          headRefName: 'feature/worktree',
          baseRefName: 'main',
        },
      ])
    );
    const session = {
      getWorkdir: () => '/repo',
      exec,
    } as unknown as ISession;

    const detected = await service.detectAndAssociatePR({
      sessionId,
      session,
      sessionDoc: createSessionDoc(),
      project: { ...localProject, useWorktree: true },
      branchName: 'feature/worktree',
    });

    expect(detected?.prNumber).toBe(42);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('publishes a child session\u2019s dirty worktree onto the owning parent meta', async () => {
    // A Side Chat / child Tab shares the parent's checkout, so the Info Bar's
    // Commit & Push decision has to read one dirty flag. Writing it to the child
    // would leave the parent (the session the user is looking at) claiming clean.
    const logger = createLogger();
    const setLatestAssistantHistoryFileDiff = vi.fn();
    const childSessionDoc = {
      getMetaState: vi.fn(async () => ({
        parentSessionId,
      })),
      setLatestAssistantHistoryFileDiff,
    } as unknown as SessionDocument;
    const parentSessionDoc = {
      getMetaState: vi.fn(async () => ({
        pullRequests: [pullRequest],
      })),
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async (id: SessionId) => {
        if (id === parentSessionId) {
          return parentSessionDoc;
        }
        return childSessionDoc;
      }),
      repo: {
        upsertDocMeta,
      },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'status --porcelain') return ' M src/app.ts\n';
        if (key === 'rev-parse --verify origin/main^{commit}') return 'origin-main\n';
        if (key === 'merge-base origin/main HEAD') return 'merge-base\n';
        if (key === 'diff --numstat --no-renames merge-base HEAD') return '2\t1\tsrc/app.ts\n';
        if (key === 'ls-files --others --exclude-standard -z') return '';
        if (key === 'rev-list @{u}..HEAD --count') return '0\n';
        throw new Error(`Unexpected git args: ${key}`);
      }),
    } as unknown as ISession;

    await service.recordGitTurnDiffs(sessionId, session, {
      turnId: 'assistant-turn-1',
      skipHistoryFileDiff: true,
    });

    expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledWith(parentSessionId);
    expect(upsertDocMeta).toHaveBeenCalledWith(
      'session-parent-session-1',
      expect.objectContaining({ workspaceDirty: true })
    );
  });

  it('publishes the git-state flags without diff stats when a cancelled turn skips them', async () => {
    // A cancelled turn bails out of finalization before diff stats run, but the
    // agent's edits are still on disk. Both flags must still reach the owner
    // meta, and the patch must not invent diffStats.
    const logger = createLogger();
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ project: githubProject })),
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      repo: { upsertDocMeta },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(' ');
      if (key === 'status --porcelain') return ' M src/app.ts\n';
      if (key === 'rev-list @{u}..HEAD --count') return '0\n';
      throw new Error(`Unexpected git args: ${key}`);
    });
    const session = { getWorkdir: () => '/repo', exec } as unknown as ISession;

    await service.syncWorkspaceGitState(sessionId, session);

    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-1', {
      workspaceDirty: true,
      workspaceUnpushed: false,
    });
  });

  it('reports a clean tree that still holds unpushed commits', async () => {
    // The regression guard: `git status` goes clean the moment the agent commits,
    // so a commit whose push failed would otherwise publish an all-clear and let
    // the Info Bar offer Merge against a PR head that is a commit behind.
    const logger = createLogger();
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ project: githubProject })),
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      repo: { upsertDocMeta },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'status --porcelain') return '';
        if (key === 'rev-list @{u}..HEAD --count') return '2\n';
        throw new Error(`Unexpected git args: ${key}`);
      }),
    } as unknown as ISession;

    await service.syncWorkspaceGitState(sessionId, session);

    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-1', {
      workspaceDirty: false,
      workspaceUnpushed: true,
    });
  });

  it('keeps the two probes independent when only one is inconclusive', async () => {
    // No upstream configured makes `@{u}` throw. That must not suppress the
    // dirty answer, and must not publish a stale `workspaceUnpushed: false`.
    const logger = createLogger();
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ project: githubProject })),
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      repo: { upsertDocMeta },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'status --porcelain') return ' M src/app.ts\n';
        throw new Error('fatal: no upstream configured for branch');
      }),
    } as unknown as ISession;

    await service.syncWorkspaceGitState(sessionId, session);

    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-1', { workspaceDirty: true });
  });

  it('inherits the owner project when a child tab carries no ProjectRef', async () => {
    // Cancellation reaches syncWorkspaceGitState from call sites that pass no
    // project, so the gate reads meta. A child Tab shares the owner's checkout
    // and may not repeat the binding — falling back to the owner keeps Side
    // Chats from silently losing the dirty signal.
    const logger = createLogger();
    const childSessionDoc = {
      getMetaState: vi.fn(async () => ({ parentSessionId })),
    } as unknown as SessionDocument;
    const parentSessionDoc = {
      getMetaState: vi.fn(async () => ({ project: githubProject })),
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async (id: SessionId) =>
        id === parentSessionId ? parentSessionDoc : childSessionDoc
      ),
      repo: { upsertDocMeta },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'status --porcelain') return ' M src/app.ts\n';
        if (key === 'rev-list @{u}..HEAD --count') return '0\n';
        throw new Error(`Unexpected git args: ${key}`);
      }),
    } as unknown as ISession;

    await service.syncWorkspaceGitState(sessionId, session);

    expect(upsertDocMeta).toHaveBeenCalledWith('session-parent-session-1', {
      workspaceDirty: true,
      workspaceUnpushed: false,
    });
  });

  it('refreshes a GitHub-capable local project in its original directory', async () => {
    // A local ProjectRef resolves its repo from `githubRepoFullName`, not
    // `repoFullName`. `useWorktree` is deliberately NOT part of the gate: unlike
    // the removed auto-commit, this probe is read-only, so it is safe in the
    // project's shared directory — and the Info Bar offers Commit & Push there.
    const logger = createLogger();
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ project: { ...localProject, useWorktree: false } })),
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      repo: { upsertDocMeta },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'status --porcelain') return ' M src/app.ts\n';
        if (key === 'rev-list @{u}..HEAD --count') return '0\n';
        throw new Error(`Unexpected git args: ${key}`);
      }),
    } as unknown as ISession;

    await service.syncWorkspaceGitState(sessionId, session);

    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-1', {
      workspaceDirty: true,
      workspaceUnpushed: false,
    });
  });

  it('skips the dirty probe for a session with no GitHub repository', async () => {
    // Nothing can act on the flag without a repo, and the probe costs a process
    // spawn on every cancelled turn of every plain local session.
    const logger = createLogger();
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({
        project: { kind: 'local', localProjectId: 'local-project-1' as LocalProjectId },
      })),
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      repo: { upsertDocMeta },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const exec = vi.fn();
    const session = { getWorkdir: () => '/repo', exec } as unknown as ISession;

    await service.syncWorkspaceGitState(sessionId, session);

    expect(exec).not.toHaveBeenCalled();
    expect(upsertDocMeta).not.toHaveBeenCalled();
  });

  it('leaves the durable workspaceDirty alone when the cancelled-turn probe fails', async () => {
    const logger = createLogger();
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ project: githubProject, workspaceDirty: true })),
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      repo: { upsertDocMeta },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async () => {
        throw new Error('spawn git ENOMEM');
      }),
    } as unknown as ISession;

    await service.syncWorkspaceGitState(sessionId, session);

    expect(upsertDocMeta).not.toHaveBeenCalled();
  });

  it('preserves complete workspace totals through Git finalization, commit and net cancellation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lody-workspace-stat-'));
    const git = async (...args: string[]) =>
      (
        await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root })
      ).stdout.trim();
    let meta: Partial<SessionMeta> = { project: githubProject };
    const workspaceDocument = {
      getOrCreateSessionDoc: async () => ({ getMetaState: async () => meta }),
      repo: {
        getDocMeta: async () => ({ meta }),
        upsertDocMeta: async (_room: string, patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
        },
      },
    } as unknown as LoroDocumentManager;
    const logger = createLogger();
    const workspace = new WorkspaceGitService({ logger, workspaceDocument });
    const files = new CodeCollabV2Service({
      resolveWorkspace: async () => ({
        ok: true,
        ownerSessionId: sessionId,
        workspaceRoot: root,
        allChangesBaseBranch: 'main',
      }),
      publishFileIndex: async (state) => {
        if (state.persistAllChangesDiffStats) await workspace.publishDiffStats(state);
      },
    });
    try {
      await git('-c', 'init.defaultBranch=main', 'init');
      await git('config', 'user.email', 'synthetic@example.invalid');
      await git('config', 'user.name', 'Synthetic Test');
      await writeFile(path.join(root, 'app.txt'), 'base\n');
      await git('add', '.');
      await git('commit', '-m', 'baseline');
      const baseline = await git('rev-parse', 'HEAD');
      await git('update-ref', 'refs/remotes/origin/main', baseline);
      await git('checkout', '-b', 'feature');
      await writeFile(path.join(root, 'committed.txt'), 'committed\n');
      await git('add', '.');
      await git('commit', '-m', 'branch work');
      await writeFile(path.join(root, 'app.txt'), 'edited\n');
      await writeFile(path.join(root, 'new.txt'), 'untracked\n');
      await files.initDirectory({ sessionId, path: '.' });
      const expected = { allChange: { add: 3, del: 1, files: 3 } };
      expect(meta.diffStats).toEqual(expected);
      const post = createService({ logger, workspaceDocument });
      const session = {
        getWorkdir: () => root,
        exec: async (_command: string, args: string[]) => git(...args),
      } as unknown as ISession;
      await post.recordGitTurnDiffs(sessionId, session, {
        turnId: 'turn',
        baseCommitHash: baseline,
        skipHistoryFileDiff: true,
      });
      expect(meta).toMatchObject({ diffStats: expected, workspaceDirty: true });
      await files.refreshSharedStateAfterTurn({ sessionId });
      expect(meta.diffStats).toEqual(expected);
      await post.recordGitTurnDiffs(
        sessionId,
        {
          getWorkdir: () => root,
          exec: async () => {
            throw new Error('synthetic git failure');
          },
        } as unknown as ISession,
        { turnId: 'failed-probe', skipHistoryFileDiff: true }
      );
      expect(meta).toMatchObject({ diffStats: expected, workspaceDirty: true });
      await git('add', '.');
      await git('commit', '-m', 'save the remaining work');
      await post.recordGitTurnDiffs(sessionId, session, {
        turnId: 'committed',
        skipHistoryFileDiff: true,
      });
      await files.refreshSharedStateAfterTurn({ sessionId });
      expect(meta).toMatchObject({ diffStats: expected, workspaceDirty: false });
      meta = { ...meta, diffStats: { allChange: { add: 0, del: 0 } } };
      await files.refreshSharedStateAfterTurn({ sessionId });
      expect(meta.diffStats).toEqual(expected);
      await writeFile(path.join(root, 'app.txt'), 'base\n');
      await rm(path.join(root, 'committed.txt'));
      await rm(path.join(root, 'new.txt'));
      await files.refreshSharedStateAfterTurn({ sessionId });
      expect(meta.diffStats).toEqual({ allChange: { add: 0, del: 0, files: 0 } });
      expect(await git('diff', '--numstat', baseline)).toBe('');
      await writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]));
      await files.refreshSharedStateAfterTurn({ sessionId });
      expect(meta.diffStats).toEqual({ allChange: { add: 0, del: 0, files: 1 } });
      expect(await files.openAllChangesDiff({ sessionId })).toMatchObject({
        status: 'ok',
        entries: [{ status: 'ok', path: 'image.bin', newSnapshot: { kind: 'binary' } }],
      });
      await writeFile(path.join(root, 'empty.txt'), '');
      await files.refreshSharedStateAfterTurn({ sessionId });
      expect(meta.diffStats).toEqual({ allChange: { add: 0, del: 0, files: 2 } });
      await writeFile(path.join(root, 'app.txt'), 'mixed text\n');
      await files.refreshSharedStateAfterTurn({ sessionId });
      expect(meta.diffStats).toEqual({ allChange: { add: 1, del: 1, files: 3 } });
      await rm(path.join(root, 'image.bin'));
      await rm(path.join(root, 'empty.txt'));
      await writeFile(path.join(root, 'app.txt'), 'base\n');
      await files.refreshSharedStateAfterTurn({ sessionId });
      expect(meta.diffStats).toEqual({ allChange: { add: 0, del: 0, files: 0 } });
    } finally {
      files.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
