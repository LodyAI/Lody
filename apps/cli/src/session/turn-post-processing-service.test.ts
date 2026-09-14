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

  it('syncs branch names to the parent session for child sessions', async () => {
    const logger = createLogger();
    const childSetBranchName = vi.fn();
    const parentSetBranchName = vi.fn();
    const childSessionDoc = {
      getMetaState: vi.fn(async () => ({
        parentSessionId,
      })),
      setBranchName: childSetBranchName,
    } as unknown as SessionDocument;
    const parentSessionDoc = {
      getMetaState: vi.fn(async () => ({
        branchName: 'old-branch',
      })),
      setBranchName: parentSetBranchName,
    } as unknown as SessionDocument;
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async (id: SessionId) => {
        if (id === parentSessionId) {
          return parentSessionDoc;
        }
        return childSessionDoc;
      }),
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        if (args.join(' ') === 'branch --show-current') return 'feature/fix\n';
        throw new Error(`Unexpected git args: ${args.join(' ')}`);
      }),
    } as unknown as ISession;

    const branchName = await service.syncSessionBranchName(sessionId, session);

    expect(branchName).toBe('feature/fix');
    expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledWith(parentSessionId);
    expect(parentSetBranchName).toHaveBeenCalledWith('feature/fix');
    expect(childSetBranchName).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
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

    await service.updateSessionDiffStats(sessionId, session, {
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

  it('can skip history fileDiff while still updating session diff stats', async () => {
    const logger = createLogger();
    const setLatestAssistantHistoryFileDiff = vi.fn();
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({})),
      setLatestAssistantHistoryFileDiff,
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      repo: {
        upsertDocMeta,
      },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
        if (key === 'rev-parse --verify origin/main^{commit}') return 'origin-main\n';
        if (key === 'merge-base origin/main HEAD') return 'merge-base\n';
        if (key === 'diff --numstat --no-renames merge-base HEAD') return '2\t1\tsrc/app.ts\n';
        if (key === 'diff --numstat --no-renames turn-base') return '99\t88\twrong.ts\n';
        if (key === 'ls-files --others --exclude-standard -z') return '';
        if (key === 'status --porcelain') return ' M src/app.ts\n';
        if (key === 'rev-list @{u}..HEAD --count') return '0\n';
        throw new Error(`Unexpected git args: ${key}`);
      }),
    } as unknown as ISession;

    const fileDiff = await service.updateSessionDiffStats(sessionId, session, {
      turnId: 'assistant-turn-1',
      baseCommitHash: 'turn-base',
      skipHistoryFileDiff: true,
    });

    expect(fileDiff).toEqual([{ filePath: 'wrong.ts', add: 99, del: 88 }]);
    expect(setLatestAssistantHistoryFileDiff).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith(
      'session-session-1',
      expect.objectContaining({
        diffStats: { allChange: { add: 2, del: 1 } },
        workspaceDirty: true,
      })
    );
  });

  it('does not overwrite workspaceDirty when the dirty probe is indeterminate', async () => {
    const logger = createLogger();
    const setLatestAssistantHistoryFileDiff = vi.fn();
    const sessionDoc = {
      // The durable meta already records the session as dirty.
      getMetaState: vi.fn(async () => ({ workspaceDirty: true })),
      setLatestAssistantHistoryFileDiff,
    } as unknown as SessionDocument;
    const upsertDocMeta = vi.fn(async () => {});
    const workspaceDocument = {
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      repo: {
        upsertDocMeta,
      },
    } as unknown as LoroDocumentManager;
    const service = createService({ logger, workspaceDocument });
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
        if (key === 'rev-parse --verify origin/main^{commit}') return 'origin-main\n';
        if (key === 'merge-base origin/main HEAD') return 'merge-base\n';
        if (key === 'diff --numstat --no-renames merge-base HEAD') return '2\t1\tsrc/app.ts\n';
        // The dirty probe fails transiently (e.g. spawn failure under load).
        if (key === 'status --porcelain') throw new Error('spawn git ENOMEM');
        throw new Error(`Unexpected git args: ${key}`);
      }),
    } as unknown as ISession;

    await service.updateSessionDiffStats(sessionId, session, {
      turnId: 'assistant-turn-1',
      skipHistoryFileDiff: true,
    });

    expect(upsertDocMeta).toHaveBeenCalledTimes(1);
    const [, metaPatch] = upsertDocMeta.mock.calls[0] as [unknown, Partial<SessionMeta>];
    // diffStats still updates, but workspaceDirty is left untouched so a transient
    // failure cannot clobber the durable dirty=true into a stale false.
    expect(metaPatch).toEqual({ diffStats: { allChange: { add: 2, del: 1 } } });
    expect('workspaceDirty' in metaPatch).toBe(false);
  });
});
