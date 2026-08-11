import { describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, ProjectRef, SessionId, SessionMeta, WorkspaceId } from '@lody/shared';

import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type { AutoPromptContext, AutoPromptResult } from './auto-prompt-runner';
import type { ISession } from './session-manager';
import { TurnPostProcessingService } from './turn-post-processing-service';

const sessionId = 'session-1' as SessionId;
const parentSessionId = 'parent-session-1' as SessionId;
const workspaceId = 'workspace-1' as WorkspaceId;
const project: ProjectRef = {
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

const createService = (options: {
  logger: Logger;
  runAutoPrompt?: (ctx: AutoPromptContext) => Promise<AutoPromptResult>;
  workspaceDocument?: LoroDocumentManager;
}) =>
  new TurnPostProcessingService({
    logger: options.logger,
    workspaceDocument: options.workspaceDocument ?? ({} as unknown as LoroDocumentManager),
    workspaceId,
    preferredBaseBranch: 'main',
    prAssociation: null,
    runAutoPrompt:
      options.runAutoPrompt ??
      (async (_ctx: AutoPromptContext) => ({
        turnId: 'auto-turn',
        baseCommitHash: 'base',
      })),
  });

describe('TurnPostProcessingService', () => {
  it('does not detect or associate a PR for a direct local project', async () => {
    const logger = createLogger();
    const service = createService({ logger });
    const exec = vi.fn();
    const session = {
      getWorkdir: () => '/repo',
      exec,
    } as unknown as ISession;

    const detected = await service.detectAndAssociatePR({
      sessionId,
      session,
      sessionDoc: createSessionDoc(),
      project: localProject,
      branchName: 'main',
    });

    expect(detected).toBeNull();
    expect(exec).not.toHaveBeenCalled();
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

  it('does not auto-commit a local project running in its original directory', async () => {
    const logger = createLogger();
    const runAutoPrompt = vi.fn(async (_ctx: AutoPromptContext): Promise<AutoPromptResult> => {
      return {
        turnId: 'auto-turn',
        baseCommitHash: 'base',
      };
    });
    const service = createService({ logger, runAutoPrompt });
    const sessionDoc = createSessionDoc();
    const exec = vi.fn();
    const session = {
      getWorkdir: () => '/repo',
      exec,
    } as unknown as ISession;

    await service.autoCommitAndPushForPR({
      sessionId,
      session,
      sessionDoc,
      project: localProject,
    });

    expect(sessionDoc.getMetaState).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(runAutoPrompt).not.toHaveBeenCalled();
  });

  it('skips forced commit checks when the turn is already cancelled', async () => {
    const logger = createLogger();
    const runAutoPrompt = vi.fn(async (_ctx: AutoPromptContext): Promise<AutoPromptResult> => {
      return {
        turnId: 'auto-turn',
        baseCommitHash: 'base',
      };
    });
    const service = createService({ logger, runAutoPrompt });
    const exec = vi.fn();
    const session = {
      getWorkdir: () => '/repo',
      exec,
    } as unknown as ISession;

    await service.autoCommitAndPushForPR({
      sessionId,
      session,
      sessionDoc: createSessionDoc(),
      project,
      isTurnCancelled: () => true,
    });

    expect(exec).not.toHaveBeenCalled();
    expect(runAutoPrompt).not.toHaveBeenCalled();
  });

  it('does not continue to push checks after an aborted commit prompt', async () => {
    const logger = createLogger();
    let cancelled = false;
    const runAutoPrompt = vi.fn(async (_ctx: AutoPromptContext): Promise<AutoPromptResult> => {
      cancelled = true;
      throw new Error('Auto prompt aborted');
    });
    const service = createService({ logger, runAutoPrompt });
    const gitCommands: string[] = [];
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        gitCommands.push(key);
        if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
        if (key === 'status --porcelain') return ' M src/app.ts\n';
        throw new Error(`Unexpected git args: ${key}`);
      }),
    } as unknown as ISession;

    await service.autoCommitAndPushForPR({
      sessionId,
      session,
      sessionDoc: createSessionDoc(),
      project: { ...localProject, useWorktree: true },
      isTurnCancelled: () => cancelled,
    });

    expect(runAutoPrompt).toHaveBeenCalledTimes(1);
    // isWorkspaceDirty no longer runs a separate --is-inside-work-tree pre-probe;
    // `git status --porcelain` is the single command.
    expect(gitCommands).toEqual(['status --porcelain']);
    expect(logger.error).not.toHaveBeenCalled();
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

  it('prompts child sessions to commit when the parent session has an associated PR', async () => {
    const logger = createLogger();
    const runAutoPrompt = vi.fn(async (_ctx: AutoPromptContext): Promise<AutoPromptResult> => {
      return {
        turnId: 'auto-turn',
        baseCommitHash: 'base',
      };
    });
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
    const service = createService({ logger, runAutoPrompt, workspaceDocument });
    let statusCalls = 0;
    const session = {
      getWorkdir: () => '/repo',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
        if (key === 'status --porcelain') {
          statusCalls += 1;
          return statusCalls === 1 ? ' M src/app.ts\n' : '';
        }
        if (key === 'rev-parse --verify origin/main^{commit}') return 'origin-main\n';
        if (key === 'merge-base origin/main HEAD') return 'merge-base\n';
        if (key === 'diff --numstat --no-renames merge-base HEAD') return '';
        if (key === 'diff --numstat --no-renames base') return '';
        if (key === 'ls-files --others --exclude-standard -z') return '';
        if (key === 'rev-list @{u}..HEAD --count') return '0\n';
        throw new Error(`Unexpected git args: ${key}`);
      }),
    } as unknown as ISession;

    await service.autoCommitAndPushForPR({
      sessionId,
      session,
      sessionDoc: childSessionDoc,
      project,
    });

    expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledWith(parentSessionId);
    expect(runAutoPrompt).toHaveBeenCalledTimes(1);
    expect(runAutoPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        session,
        sessionDoc: childSessionDoc,
        promptText: expect.stringContaining('uncommitted changes'),
      })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith(
      'session-parent-session-1',
      expect.objectContaining({ workspaceDirty: false })
    );
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
