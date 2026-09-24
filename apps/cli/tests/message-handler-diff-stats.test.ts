import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, WorkspaceId } from '@lody/shared';

import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { ISession } from '../src/session/session-manager';
import { TurnPostProcessingService } from '../src/session/turn-post-processing-service';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

describe('TurnPostProcessingService diff stats base branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses provided base branch when computing git diff stats', async () => {
    const logger = createSilentLogger();
    const sessionId = 's-1' as SessionId;

    const upsertDocMeta = vi.fn(async () => {});
    const applyHistoryAction = vi.fn(async () => ({ status: 'accepted', receipt: {} }));
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({
        parentSessionId: 'parent-session-1' as SessionId,
      })),
      sessionData: { commands: { applyHistoryAction } },
    };

    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      registerMachine: vi.fn(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
        upsertDocMeta,
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
    };

    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      const key = args.join(' ');

      if (key === 'rev-parse --is-inside-work-tree') return 'true\n';

      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2] === 'origin/release/v1^{commit}') return 'deadbeef\n';
        throw new Error(`Unknown revision: ${args[2] ?? ''}`);
      }

      if (key === 'merge-base origin/release/v1 HEAD') return 'abc123\n';
      if (key === 'diff --numstat --no-renames abc123 HEAD') return '5\t1\ta.ts\n';
      if (key === 'diff --numstat --no-renames base456') return '2\t0\tb.ts\n';
      if (key === 'ls-files --others --exclude-standard -z') return '';

      if (key === 'status --porcelain') return '';
      if (key === 'rev-list @{upstream}..HEAD --count') return '0\n';

      throw new Error(`Unexpected git args: ${key}`);
    });

    const session = {
      getWorkdir: () => '/tmp',
      exec,
    };

    const service = new TurnPostProcessingService({
      logger,
      workspaceDocument: workspaceDocument as unknown as LoroDocumentManager,
      token: 't',
      workspaceId: 'ws-1' as WorkspaceId,
      preferredBaseBranch: 'main',
      authBaseUrl: null,
      runAutoPrompt: vi.fn(async () => ({ turnId: 'auto-turn', baseCommitHash: null })),
    });

    const fileDiff = await service.updateSessionDiffStats(
      sessionId,
      session as unknown as ISession,
      {
        turnId: 'turn-1',
        baseCommitHash: 'base456',
        preferredBaseBranch: 'release/v1',
      }
    );

    expect(fileDiff).toEqual([{ filePath: 'b.ts', add: 2, del: 0 }]);
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['merge-base', 'origin/release/v1', 'HEAD'],
      '/tmp',
      false
    );
    expect(exec).not.toHaveBeenCalledWith('git', ['merge-base', 'main', 'HEAD'], '/tmp', false);
    expect(applyHistoryAction).toHaveBeenCalledWith({
      kind: 'assistant-file-diff',
      change: { kind: 'set', value: [{ filePath: 'b.ts', add: 2, del: 0 }] },
      turnId: 'turn-1',
    });
    expect(upsertDocMeta).toHaveBeenCalledWith(
      'session-parent-session-1',
      expect.objectContaining({
        diffStats: expect.objectContaining({
          allChange: { add: 5, del: 1 },
        }),
        workspaceDirty: false,
      })
    );
  });
});
