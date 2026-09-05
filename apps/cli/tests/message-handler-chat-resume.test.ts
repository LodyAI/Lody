import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageHandler } from '../src/lib/message-handler';
import type { Logger } from '../src/utils/logger';
import {
  SessionStatusFactory,
  type ACPSessionId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { SessionManager } from '../src/session/session-manager';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import { createTestCloudPort } from './test-cloud-port';

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

describe('MessageHandler chat resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores missing session for chat using stored ACP session id', async () => {
    const logger = createSilentLogger();

    const meta = {
      repoFullName: 'owner/repo',
      acpSessionId: 'acp-1' as ACPSessionId,
      branchName: 'feat/resume-archived-worktree',
      isArchived: false,
    };

    let history: unknown[] = [];
    const sessionDoc = {
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getStatus: vi.fn(async () => SessionStatusFactory.idle()),
      setLastMessageAt: vi.fn(async () => {}),
      popMessageQueue: vi.fn(async () => null),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      waitUntilSynced: vi.fn(async () => {}),
    };

    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      registerMachine: vi.fn(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      isTransportConnected: vi.fn(() => true),
      publishSessionPresence: vi.fn(),
      clearSessionPresence: vi.fn(),
    };

    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => ({})),
      setSessionMode: vi.fn(async () => {}),
      unstable_setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => undefined),
      getConfigOptions: vi.fn(() => []),
      currentModel: undefined,
    };

    const restoredSession = {
      sessionId: 's-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient: agentClient as unknown,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-1'),
    };

    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async (config, agentStart) => {
        expect(config.sessionId).toBe('s-1');
        expect(config.resume).toBe(true);
        expect(config.githubRepo).toBe('owner/repo');
        expect(config.restoreBranchName).toBe('feat/resume-archived-worktree');
        expect(agentStart?.resumeSessionId).toBe('acp-1');
        return restoredSession as unknown;
      }),
      finishSession: vi.fn(),
      cleanUp: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      hasSession: vi.fn(),
      initialize: vi.fn(),
      releaseGitHubRepoOwner: vi.fn(),
      refreshGitHubCredentialContext: vi.fn(async () => {}),
    };

    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId: 'ws-1' as WorkspaceId,
        userId: 'u-1',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort(),
      }
    );

    const host = handler as unknown as {
      handleSessionChat(message: {
        sessionId: SessionId;
        machineId: string;
        workspaceId: WorkspaceId;
        project?: { kind: 'github'; repoFullName: string; branch: string };
        acpSessionConfig: { prompt: string; cliType: 'builtin'; agentType: 'codex' };
        userTurnId: string;
        userId: string;
        userName: string;
        userEmail: string;
      }): Promise<void>;
    };

    await host.handleSessionChat({
      sessionId: 's-1' as SessionId,
      machineId: 'm-1',
      workspaceId: 'ws-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-1',
      userId: 'u-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    });

    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing('resuming')
    );
    expect(sessionDoc.setBaseBranch).toHaveBeenCalledWith('main');
    expect(agentClient.prompt).toHaveBeenCalledWith('acp-1', [{ type: 'text', text: 'hi' }], {
      signal: expect.any(AbortSignal),
    });
  });
});
