import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionStatusFactory,
  type ACPSessionId,
  type ModelInfo,
  type SessionHistoryInput,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { MessageHandler } from '../src/lib/message-handler';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
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

function createTestHarness(overrides: { sessionDoc?: Record<string, unknown> }) {
  const sessionId = 's-1' as SessionId;
  const acpSessionId = 'acp-1' as ACPSessionId;

  const sessionDoc = {
    getMetaState: vi.fn(async () => ({
      isArchived: false,
      project: {
        kind: 'local',
        localProjectId: 'local-1',
        branch: 'main',
        githubRepoFullName: 'owner/repo',
      },
    })),
    setStatus: vi.fn(async () => {}),
    getStatus: vi.fn(async () => SessionStatusFactory.running()),
    popMessageQueue: vi.fn(async () => null),
    updateHistory: vi.fn(async () => {}),
    getHistory: vi.fn(async () => []),
    waitUntilSynced: vi.fn(async () => {}),
    ...overrides.sessionDoc,
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
  };

  const agentClient = {
    isCreated: vi.fn(() => true),
    prompt: vi.fn(async () => ({})),
    setSessionMode: vi.fn(async () => {}),
    unstable_setSessionModel: vi.fn(async () => {}),
    currentModel: undefined,
  };

  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123';
    return '';
  });

  const session = {
    sessionId,
    acpSessionId,
    agentClient,
    terminalManager: {} as unknown,
    getWorkdir: () => '/tmp',
    getHostWorkdir: () => null,
    exec,
    terminate: vi.fn(async () => {}),
    createAgent: vi.fn(async () => acpSessionId),
    updateGitIdentity: vi.fn(),
  };

  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(() => session),
    getPendingSession: vi.fn(() => null),
    createSession: vi.fn(),
    finishSession: vi.fn(),
    cleanUp: vi.fn(),
    setSessionError: vi.fn(),
    terminateSession: vi.fn(),
    hasSession: vi.fn(),
    initialize: vi.fn(),
    releaseGitHubRepoOwner: vi.fn(),
    refreshGitHubCredentialContext: vi.fn(async () => {}),
  };

  const logger = createSilentLogger();
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

  const handleSessionChat = (turnId = 'turn-1') => {
    const host = handler as unknown as {
      handleSessionChat(message: {
        sessionId: SessionId;
        machineId: string;
        workspaceId: WorkspaceId;
        acpSessionConfig: { prompt: string; cliType: 'builtin'; agentType: 'codex' };
        userTurnId: string;
        userId: string;
        userName: string;
        userEmail: string;
      }): Promise<void>;
    };

    return host.handleSessionChat({
      sessionId,
      machineId: 'm-1',
      workspaceId: 'ws-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: turnId,
      userId: 'u-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    });
  };

  return { handler, sessionId, sessionDoc, sessionManager, handleSessionChat };
}

describe('MessageHandler chat status transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the active turn intact when only its ACP process is replaced', () => {
    const { handler, sessionId, sessionManager } = createTestHarness({});
    const host = handler as unknown as {
      setupSessionEventHandlers(): void;
      finalizeACPState(sessionId: SessionId): Promise<void>;
      clearSessionActivePresence(sessionId: SessionId): void;
      codeCollabV2Service: { releaseWorkspaceWatchForOwner(sessionId: SessionId): void };
    };
    const finalize = vi.spyOn(host, 'finalizeACPState').mockResolvedValue();
    const clearPresence = vi.spyOn(host, 'clearSessionActivePresence').mockImplementation(() => {});
    const releaseWatch = vi
      .spyOn(host.codeCollabV2Service, 'releaseWorkspaceWatchForOwner')
      .mockImplementation(() => {});
    host.setupSessionEventHandlers();
    const terminated = sessionManager.on.mock.calls.find(
      ([event]) => event === 'terminated'
    )?.[1] as
      | ((event: { sessionId: SessionId; exitCode: number; reason: 'acp-replacement' }) => void)
      | undefined;
    expect(terminated).toBeDefined();
    terminated?.({ sessionId, exitCode: 0, reason: 'acp-replacement' });
    expect(finalize).not.toHaveBeenCalled();
    expect(clearPresence).not.toHaveBeenCalled();
    expect(releaseWatch).not.toHaveBeenCalled();
  });

  it('updates an existing assistant entry with the latest model info', async () => {
    const oldModel: ModelInfo = { modelId: 'old-model', name: 'Old Model' };
    const newModel: ModelInfo = { modelId: 'new-model', name: 'New Model' };
    let history: SessionHistoryInput[] = [
      {
        id: 'assistant-turn-model',
        role: 'assistant',
        userTurnId: 'user-turn-model',
        items: [],
        timestamp: new Date().toISOString(),
        userId: undefined,
        read: undefined,
        modelInfo: oldModel,
        fileDiff: [],
      },
    ];
    const { handler, sessionDoc } = createTestHarness({
      sessionDoc: {
        updateHistory: vi.fn(
          async (updater: (prev: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            history = updater(history);
          }
        ),
      },
    });
    const host = handler as unknown as {
      createAssistantEntryForTurn(
        sessionId: SessionId,
        sessionDoc: typeof sessionDoc,
        turnId: string,
        modelInfo: ModelInfo | undefined,
        userTurnId?: string
      ): Promise<void>;
    };

    await host.createAssistantEntryForTurn(
      's-1' as SessionId,
      sessionDoc,
      'assistant-turn-model',
      newModel,
      'user-turn-model'
    );
    expect(history[0]?.modelInfo).toEqual(newModel);

    await host.createAssistantEntryForTurn(
      's-1' as SessionId,
      sessionDoc,
      'assistant-turn-model',
      undefined,
      'user-turn-model'
    );
    expect(history[0]?.modelInfo).toEqual(newModel);
  });
});
