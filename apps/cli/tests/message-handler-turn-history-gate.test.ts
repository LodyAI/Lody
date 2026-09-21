import { updateTestHistory } from './history-port-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';

import type {
  AcpSessionNotification,
  SessionHistoryInput,
  SessionId,
  WorkspaceId,
} from '@lody/shared';

import { MessageHandler } from '../src/lib/message-handler';
import { SessionDocument } from '../src/lib/loro/doc';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { SessionDispatchSource } from '../src/session/session-execution-service';
import { DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS } from '../src/session/turn-history-gate';
import type { Logger } from '../src/utils/logger';
import { loadEnv } from '../src/utils/const';
import { createTestCloudPort } from './test-cloud-port';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { AgentClient } from '../src/agent/agent-client';

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

const originalLodyServerUrl = process.env.LODY_SERVER_URL;

type MessageHandlerHost = {
  appendACPUpdatesToAssistantEntry(...args: unknown[]): Promise<void>;
  flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
  handleAgentPermissionRequest(
    sessionId: SessionId,
    requestId: string,
    request: RequestPermissionRequest,
    model: undefined,
    client: Pick<AgentClient, 'getAutomaticToolPermissionOutcome' | 'subscribeConfigOptions'>
  ): Promise<RequestPermissionResponse>;
  beginConversationTurn(
    sessionId: SessionId,
    userTurnId?: string,
    gateContext?: { dispatchSource?: SessionDispatchSource; sessionDoc: SessionDocument }
  ): string;
  enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
  createAssistantEntryForTurn(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: undefined,
    userTurnId?: string
  ): Promise<void>;
};

// loro-repo resolves create()/destroy() on the real clock (native async), not the
// timers vitest fakes — run repo setup/teardown on real timers (same pattern as
// message-handler-acp-batching.test.ts).
const destroyRepoOnRealTimers = async (repo: LoroRepo) => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  await repo.destroy();
};

const createHandlerHarness = async (sessionId: SessionId) => {
  const logger = createSilentLogger();
  const fakeTimersActive = vi.isFakeTimers();
  if (fakeTimersActive) {
    vi.useRealTimers();
  }
  const repo = await LoroRepo.create({});
  const doc = new SessionDocument(repo, sessionId);
  await doc.initOffline();
  if (fakeTimersActive) {
    vi.useFakeTimers();
  }

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

const userEntry = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  timestamp: new Date().toISOString(),
  read: false,
  userId: 'u-1',
  fileDiff: [],
  items: [{ type: 'text', text: 'hi agent' }] as unknown as SessionHistoryInput['items'],
});

const agentChunk = (sessionId: SessionId, text: string): AcpSessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  },
});

describe('MessageHandler turn history gate (RPC fast path ordering)', () => {
  it.each([false, true, 'write-failure', 'new-turn'] as const)(
    'drains text before a permission tool (buffered tool: %s)',
    async (includeTool) => {
      const sessionId = 'permission-order' as SessionId;
      const { repo, doc, handler } = await createHandlerHarness(sessionId);
      try {
        await updateTestHistory(doc, () => [userEntry('user-permission')]);
        const turnId = handler.beginConversationTurn(sessionId, 'user-permission');
        await handler.createAssistantEntryForTurn(
          sessionId,
          doc,
          turnId,
          undefined,
          'user-permission'
        );
        handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'The first '));
        await handler.flushACPUpdatesNow(sessionId);
        handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'sentence.'));
        const failedWrite =
          includeTool === 'write-failure'
            ? vi
                .spyOn(handler, 'appendACPUpdatesToAssistantEntry')
                .mockRejectedValue(new Error('storage unavailable'))
            : undefined;
        const toolCall = {
          toolCallId: 'read-1',
          title: 'Read',
          kind: 'read' as const,
          status: 'pending' as const,
        };
        if (includeTool && includeTool !== 'new-turn')
          handler.enqueueACPUpdate(sessionId, {
            sessionId,
            update: { sessionUpdate: 'tool_call', ...toolCall },
          });
        if (includeTool === 'new-turn') {
          const drain = handler.flushACPUpdatesNow.bind(handler);
          vi.spyOn(handler, 'flushACPUpdatesNow').mockImplementationOnce(async (id) => {
            await drain(id);
            await updateTestHistory(doc, (history) => [...history, userEntry('next-user')]);
            const next = handler.beginConversationTurn(sessionId, 'next-user');
            await handler.createAssistantEntryForTurn(sessionId, doc, next, undefined, 'next-user');
          });
        }
        const outcome = { outcome: 'selected' as const, optionId: 'allow' };
        const result = await handler.handleAgentPermissionRequest(
          sessionId,
          'permission-1',
          {
            sessionId,
            toolCall,
            options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow' }],
          },
          undefined,
          {
            getAutomaticToolPermissionOutcome: () => outcome,
            subscribeConfigOptions: () => () => {},
          }
        );
        if (includeTool === 'new-turn') {
          expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
          const history = await doc.sessionData.history.readAll();
          expect(history.at(-1)?.items).toEqual([]);
          expect(history[1]?.items).toEqual([{ type: 'text', text: 'The first sentence.' }]);
          return;
        }
        if (failedWrite) {
          expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
          const beforeRetry = await doc.sessionData.history.readAll();
          expect(beforeRetry[1]?.items).toEqual([{ type: 'text', text: 'The first ' }]);
          failedWrite.mockRestore();
          await handler.flushACPUpdatesNow(sessionId);
          const afterRetry = await doc.sessionData.history.readAll();
          expect(afterRetry[1]?.items).toMatchObject([
            { type: 'text', text: 'The first sentence.' },
            { type: 'tool_call', toolCallId: 'read-1' },
          ]);
          return;
        }
        expect(result).toEqual({ outcome });
        handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'A separate answer.'));
        await handler.flushACPUpdatesNow(sessionId);
        const history = await doc.sessionData.history.readAll();
        expect(history[1]?.items).toMatchObject([
          { type: 'text', text: 'The first sentence.' },
          {
            type: 'tool_call',
            toolCallId: 'read-1',
            permissionRequest: { requestId: 'permission-1', outcome },
          },
          { type: 'text', text: 'A separate answer.' },
        ]);
      } finally {
        await destroyRepoOnRealTimers(repo);
      }
    }
  );

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.LODY_SERVER_URL = 'https://server.example.test';
    loadEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    if (originalLodyServerUrl === undefined) {
      delete process.env.LODY_SERVER_URL;
    } else {
      process.env.LODY_SERVER_URL = originalLodyServerUrl;
    }
    loadEnv();
  });

  it('holds RPC-turn output until the user entry syncs, then orders it after the user entry', async () => {
    const sessionId = 's-gate-1' as SessionId;
    const userTurnId = 'user-turn-1';
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      const turnId = handler.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'rpc',
        sessionDoc: doc,
      });
      expect(turnId).toBe(`assistant:${userTurnId}`);

      // The eager assistant-entry creation (execution service does this before
      // the prompt) must defer while the user entry is missing locally.
      await handler.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);
      expect(await doc.sessionData.history.readAll()).toHaveLength(0);

      // Streamed output arrives and the batch window elapses — still nothing
      // may be persisted ahead of the user entry.
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'hello'));
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, ' world'));
      await vi.advanceTimersByTimeAsync(200);
      expect(await doc.sessionData.history.readAll()).toHaveLength(0);

      // The user entry syncs in (as the web client's CRDT write would land).
      await updateTestHistory(doc, (history) => [...history, userEntry(userTurnId)]);
      await vi.advanceTimersByTimeAsync(200);

      const history = await doc.sessionData.history.readAll();
      expect(history.map((entry) => [entry.role, entry.id])).toEqual([
        ['user', userTurnId],
        ['assistant', turnId],
      ]);
      const items = history[1]?.items as unknown as Array<{ type: string; text: string }>;
      expect(items).toEqual([{ type: 'text', text: 'hello world' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('releases output after the gate timeout when the user entry never syncs', async () => {
    const sessionId = 's-gate-2' as SessionId;
    const userTurnId = 'user-turn-2';
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      const turnId = handler.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'rpc',
        sessionDoc: doc,
      });
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'stalled sync'));
      await vi.advanceTimersByTimeAsync(200);
      expect(await doc.sessionData.history.readAll()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS);

      const history = await doc.sessionData.history.readAll();
      expect(history.map((entry) => [entry.role, entry.id])).toEqual([['assistant', turnId]]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('does not gate turns dispatched from local history (crdt source)', async () => {
    const sessionId = 's-gate-3' as SessionId;
    const userTurnId = 'user-turn-3';
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      await updateTestHistory(doc, (history) => [...history, userEntry(userTurnId)]);
      const turnId = handler.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
      });
      await handler.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'immediate'));
      await vi.advanceTimersByTimeAsync(20);

      const history = await doc.sessionData.history.readAll();
      expect(history.map((entry) => [entry.role, entry.id])).toEqual([
        ['user', userTurnId],
        ['assistant', turnId],
      ]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });
});
