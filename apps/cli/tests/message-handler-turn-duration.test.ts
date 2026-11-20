import { createSessionBackend } from '../src/session/session-backend';
import { updateTestHistory, withHistoryPort } from './history-port-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';

import {
  SessionStatusFactory,
  type ACPSessionId,
  type AcpConfigOptionValue,
  type ModelInfo,
  type SessionHistoryInput,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { MessageHandler } from '../src/lib/message-handler';
import { SessionDocument } from '../src/lib/loro/doc';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { SessionExecutionService } from '../src/session/session-execution-service';
import type { Logger } from '../src/utils/logger';
import { loadEnv } from '../src/utils/const';
import { createTestCloudPort } from './test-cloud-port';
import { fakeSessionData } from './session-data-test-double';
import { TurnHistoryGate } from '../src/session/turn-history-gate';
import type { SessionTransientStore } from '../src/lib/session-transient-store';

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

const originalLodyServerUrl = process.env.LODY_SERVER_URL;

type MessageHandlerHost = {
  store: SessionTransientStore;
  writeAssistantEntryForTurn(
    sessionId: SessionId,
    doc: SessionDocument,
    turnId: string,
    modelInfo: undefined,
    userTurnId: string,
    signal: AbortSignal
  ): Promise<void>;
  finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
  beginConversationTurn(sessionId: SessionId): string;
  markACPNotificationsUnread(
    sessionId: SessionId,
    doc: SessionDocument,
    notifications: readonly {
      sessionId: string;
      update: { sessionUpdate: 'agent_message_chunk'; content: { type: 'text'; text: string } };
    }[]
  ): Promise<void>;
};

const createHandlerHarness = async (sessionId: SessionId) => {
  const logger = createSilentLogger();
  const repo = await LoroRepo.create({});
  const doc = new SessionDocument(repo, sessionId);
  await doc.initOffline();

  const workspaceDocument = {
    isTransportConnected: vi.fn(() => true),
    markMachineFlockDocDirty: vi.fn(),
    registerMachine: vi.fn(),
    repo: {
      watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getDocMeta: vi.fn(async () => ({
        meta: { needToArchiveSessions: {}, needToDeleteSessions: {} },
      })),
    },
    getOrCreateSessionDoc: vi.fn(async () => doc),
  };
  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(() => null),
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

  return { repo, doc, handler: handler as unknown as MessageHandlerHost };
};

const TURN_STARTED_AT = Date.parse('2026-01-01T00:00:00.000Z');
const TURN_ENDED_AT = TURN_STARTED_AT + 12_000;
const APP_CLOSED_AT = TURN_STARTED_AT + 3_600_000;

const assistantEntry = (): SessionHistoryInput => ({
  id: 'assistant:user-turn-1',
  role: 'assistant',
  timestamp: new Date(TURN_STARTED_AT).toISOString(),
  fileDiff: [],
  items: [{ type: 'text', text: 'done' }] as unknown as SessionHistoryInput['items'],
});

describe('MessageHandler turn duration (finalize stamps)', () => {
  beforeEach(() => {
    process.env.LODY_SERVER_URL = 'https://server.example.test';
    loadEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    if (originalLodyServerUrl === undefined) {
      delete process.env.LODY_SERVER_URL;
    } else {
      process.env.LODY_SERVER_URL = originalLodyServerUrl;
    }
    loadEnv();
  });

  it('does not let a timed-out assistant callback reopen history during finalization', async () => {
    const sessionId = 's-finalize-gate' as SessionId;
    const { repo, doc, handler } = await createHandlerHarness(sessionId);
    const entered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const releaseFinalize = Promise.withResolvers<void>();
    let callback: Promise<void> | undefined;
    let finalizing: Promise<void> | undefined;
    try {
      const turnId = handler.beginConversationTurn(sessionId);
      await updateTestHistory(doc, () => [
        {
          ...assistantEntry(),
          id: turnId,
          author: { v: 1, kind: 'agent', sessionId, turnId, name: 'Fixture Agent' },
        },
      ]);
      const backend = await createSessionBackend(doc);
      const read = backend.history.readTurn.bind(backend.history);
      vi.spyOn(backend.history, 'readTurn').mockImplementation(async (id) => {
        const result = await read(id);
        if (id === turnId) {
          entered.resolve();
          await releaseRead.promise;
        }
        return result;
      });
      const apply = backend.applyHistoryAction.bind(backend);
      vi.spyOn(backend, 'applyHistoryAction').mockImplementation(async (action) => {
        const result = await apply(action);
        if (action.kind === 'finish-assistant') {
          finished.resolve();
          await releaseFinalize.promise;
        }
        return result;
      });
      vi.useFakeTimers();
      const gate = TurnHistoryGate.waitForUserTurn({
        logger: createSilentLogger(),
        sessionId,
        userTurnId: 'user-1',
        timeoutMs: 1_000,
        hasUserTurn: async () => true,
        subscribeHistory: () => undefined,
        onBeforeOpen: (_reason, signal) => {
          callback = handler.writeAssistantEntryForTurn(
            sessionId,
            doc,
            turnId,
            undefined,
            'user-1',
            signal
          );
          return callback;
        },
      });
      handler.store.get(sessionId).turnHistoryGate = gate;
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await gate.waitUntilOpen();
      vi.useRealTimers();
      finalizing = handler.finalizeACPState(sessionId, turnId);
      await finished.promise;
      releaseRead.resolve();
      await callback;
      expect((await backend.readHistory()).find((row) => row.id === turnId)?.finished).toBe(true);
      releaseFinalize.resolve();
      await finalizing;
    } finally {
      releaseRead.resolve();
      releaseFinalize.resolve();
      await callback;
      await finalizing;
      vi.useRealTimers();
      await repo.destroy();
    }
  });

  it('does not publish unread while the history finalizer is pending or during teardown', async () => {
    const sessionId = 's-duration-unread' as SessionId;
    const { repo, doc, handler } = await createHandlerHarness(sessionId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      await updateTestHistory(doc, (history) => [...history, assistantEntry()]);
      await doc.setLastMessageAt(TURN_STARTED_AT);
      handler.beginConversationTurn(sessionId);
      await handler.markACPNotificationsUnread(sessionId, doc, [
        {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
        },
      ]);
      const backend = await createSessionBackend(doc);
      const apply = backend.applyHistoryAction.bind(backend);
      vi.spyOn(backend, 'applyHistoryAction').mockImplementation(async (action) => {
        entered.resolve();
        await release.promise;
        return apply(action);
      });
      const finalizing = handler.finalizeACPState(sessionId);
      await entered.promise;
      expect((await doc.getMetaState())?.lastMessageAt).toBe(TURN_STARTED_AT);
      expect((await backend.readHistory())[0]?.finished).not.toBe(true);
      release.resolve();
      await finalizing;
      expect((await backend.readHistory())[0]?.finished).toBe(true);
      expect((await doc.getMetaState())?.lastMessageAt).toBe(TURN_STARTED_AT);
    } finally {
      release.resolve();
      await repo.destroy();
    }
  });

  it('reports failed live-turn history finalization instead of authorizing success', async () => {
    const sessionId = 's-duration-failed' as SessionId;
    const { repo, doc, handler } = await createHandlerHarness(sessionId);
    try {
      await updateTestHistory(doc, (history) => [...history, assistantEntry()]);
      const backend = await createSessionBackend(doc);
      vi.spyOn(backend, 'applyHistoryAction').mockRejectedValue(new Error('disk full'));
      await expect(handler.finalizeACPState(sessionId, 'assistant:user-turn-1')).rejects.toThrow(
        'disk full'
      );
      expect((await backend.readHistory())[0]?.finished).not.toBe(true);
      // Independent shutdown remains best effort.
      await handler.finalizeACPState(sessionId);
    } finally {
      await repo.destroy();
    }
  });

  it('keeps a finished turn timing when teardown finalizes again at app close', async () => {
    // #260: closing the app raises exit/terminated for every live session, and
    // both handlers run the no-turnId finalize whether or not the turn is over.
    // The turn's `endedAt` used to be rewritten to the close-time clock, so the
    // rendered "Worked for …" grew with however long the app had been open.
    const sessionId = 's-duration-1' as SessionId;
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      await updateTestHistory(doc, (history) => [...history, assistantEntry()]);

      const now = vi.spyOn(Date, 'now').mockReturnValue(TURN_ENDED_AT);
      await handler.finalizeACPState(sessionId);
      expect((await doc.sessionData.history.readAll())[0]).toMatchObject({
        finished: true,
        endedAt: TURN_ENDED_AT,
      });

      now.mockReturnValue(APP_CLOSED_AT);
      await handler.finalizeACPState(sessionId);

      expect((await doc.sessionData.history.readAll())[0]?.endedAt).toBe(TURN_ENDED_AT);
    } finally {
      await repo.destroy();
    }
  });

  it('still stamps a turn that was interrupted before it finished', async () => {
    const sessionId = 's-duration-2' as SessionId;
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      await updateTestHistory(doc, (history) => [...history, assistantEntry()]);

      vi.spyOn(Date, 'now').mockReturnValue(APP_CLOSED_AT);
      await handler.finalizeACPState(sessionId);

      expect((await doc.sessionData.history.readAll())[0]).toMatchObject({
        finished: true,
        endedAt: APP_CLOSED_AT,
      });
    } finally {
      await repo.destroy();
    }
  });
});

function createChatStatusHarness(overrides: { sessionDoc?: Record<string, unknown> }) {
  const sessionId = 's-1' as SessionId;
  const acpSessionId = 'acp-1' as ACPSessionId;

  const sessionDoc = withHistoryPort({
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
    getHistory: vi.fn(() => []),
    waitUntilSynced: vi.fn(async () => {}),
    ...overrides.sessionDoc,
  });
  (sessionDoc as { sessionData?: unknown }).sessionData = fakeSessionData(
    sessionDoc.updateHistory as never
  );
  Object.assign(sessionDoc, { agentWrites: (sessionDoc as any).sessionData.agentWrites });

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
    validateSessionCredentials: vi.fn(async () => {}),
  };

  const handler = new MessageHandler(
    sessionManager as unknown as SessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    createSilentLogger(),
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

  return { handler, sessionId, sessionDoc };
}

describe('MessageHandler chat status transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the legacy invocation response unchanged when the runtime knows the sender', async () => {
    const { handler, sessionId } = createChatStatusHarness({});
    const host = handler as unknown as { executionService: SessionExecutionService };
    const invocation = {
      requesterUserId: 'u-1',
      sourceTurnId: 'goal:resume:synthetic',
      inputConfig: {},
      notificationOriginTurnIds: ['goal:resume:synthetic'],
    };
    const read = vi.spyOn(host.executionService, 'getActiveInvocationContext').mockReturnValue({
      ...invocation,
      sender: { kind: 'user' },
    });
    try {
      expect(
        await handler.handleLocalMachineRpc({
          method: 'session/get-active-invocation-context',
          machineId: 'm-1',
          workspaceId: 'ws-1',
          params: { sessionId },
        })
      ).toEqual({
        ok: true,
        result: {
          type: 'session/active-invocation-context',
          active: true,
          sessionId,
          ...invocation,
        },
      });
    } finally {
      read.mockRestore();
    }
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
    const { handler, sessionDoc } = createChatStatusHarness({
      sessionDoc: withHistoryPort({
        updateHistory: vi.fn(
          async (updater: (prev: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            history = updater(history);
          }
        ),
      }),
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

type ApplyAcpModeAndModel = (
  session: {
    sessionId: SessionId;
    acpSessionId: ACPSessionId;
    agentClient: {
      isCreated: () => boolean;
      getAvailableCommands: () => [];
      getAvailableCommandsForSession: () => [];
      getConfigOptions: () => Array<{ id: string; category?: string }>;
      setSessionMode: (sessionId: ACPSessionId, modeId: string) => Promise<void>;
      unstable_setSessionModel: (sessionId: ACPSessionId, modelId: string) => Promise<void>;
      setSessionConfigOption: (
        sessionId: ACPSessionId,
        configId: string,
        value: AcpConfigOptionValue
      ) => Promise<void>;
    };
  },
  config: {
    agentType?: string;
    modelId?: string;
    configOptionValues?: Record<string, AcpConfigOptionValue>;
  },
  context: { sessionDoc: unknown }
) => Promise<void>;

function createFableHarness() {
  const workspaceDocument = {
    repo: {
      watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
    },
    getOrCreateSessionDoc: vi.fn(),
    isTransportConnected: vi.fn(() => true),
  };
  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(),
  };
  const handler = new MessageHandler(
    sessionManager as unknown as SessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    createSilentLogger(),
    {
      token: 'token',
      workspaceId: 'workspace-1' as WorkspaceId,
      userId: 'user-1',
      machineId: 'machine-1',
      machineName: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    }
  );
  const setSessionConfigOption = vi.fn(async () => {});
  const unstableSetSessionModel = vi.fn(async () => {});
  const session = {
    sessionId: 'session-1' as SessionId,
    acpSessionId: 'acp-session-1' as ACPSessionId,
    agentClient: {
      isCreated: () => true,
      getAvailableCommands: () => [],
      getAvailableCommandsForSession: () => [],
      getConfigOptions: () => [
        { id: 'model', category: 'model' },
        { id: 'fast', category: 'model_config' },
      ],
      setSessionMode: vi.fn(async () => {}),
      unstable_setSessionModel: unstableSetSessionModel,
      setSessionConfigOption,
    },
  };

  const applyAcpModeAndModel = (
    handler as unknown as {
      applyAcpModeAndModel: ApplyAcpModeAndModel;
    }
  ).applyAcpModeAndModel.bind(handler);

  return {
    apply: (
      targetSession: Parameters<ApplyAcpModeAndModel>[0],
      config: Parameters<ApplyAcpModeAndModel>[1]
    ) => applyAcpModeAndModel(targetSession, config, { sessionDoc: {} }),
    session,
    setSessionConfigOption,
    unstableSetSessionModel,
  };
}

describe('MessageHandler Claude Fable Fast mode compatibility', () => {
  it.each(['fast', 'fast-mode'])('does not send %s=false to a Fable model', async (configId) => {
    const { apply, session, setSessionConfigOption } = createFableHarness();

    await apply(session, {
      agentType: 'claude',
      modelId: 'claude-fable-5[1m]',
      configOptionValues: { [configId]: false },
    });

    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('recognizes Fable when the target model is carried as a config option', async () => {
    const { apply, session, setSessionConfigOption, unstableSetSessionModel } =
      createFableHarness();

    await apply(session, {
      agentType: 'claude',
      configOptionValues: {
        model: 'claude-fable-5',
        fast: false,
      },
    });

    expect(unstableSetSessionModel).toHaveBeenCalledWith('acp-session-1', 'claude-fable-5');
    expect(setSessionConfigOption).not.toHaveBeenCalledWith('acp-session-1', 'fast', false);
  });

  it.each([
    {
      name: 'enabled Fast mode on Fable',
      agentType: 'claude',
      modelId: 'claude-fable-5',
      value: true,
    },
    {
      name: 'disabled Fast mode on another Claude model',
      agentType: 'claude',
      modelId: 'opus[1m]',
      value: false,
    },
  ])('still sends $name', async ({ agentType, modelId, value }) => {
    const { apply, session, setSessionConfigOption } = createFableHarness();

    await apply(session, {
      agentType,
      modelId,
      configOptionValues: { fast: value },
    });

    expect(setSessionConfigOption).toHaveBeenCalledWith('acp-session-1', 'fast', value);
  });
});
