/**
 * Process lifecycle events (`error` / `exit` / `terminated`) must never end a
 * turn the SessionExecutionService still owns.
 *
 * The production failure this pins: continuing an old Claude session, ACP
 * `loadSession` answers `Resource not found`, Lody falls back to replaying chat
 * history on a NEW ACP session — and the `terminate()` of the failed instance
 * emits `terminated` while the visible turn is still in its deferred window
 * (`ownsACPUpdates === false`, because visible dispatch does not claim ACP
 * routing until its prompt starts). The old handler answered that event with a
 * no-turnId `finalizeACPState`, which cleared the turn; the fallback's
 * `activateTurnACPUpdateTarget` then silently no-opped against an idle turn and
 * every one of the 505 seconds of agent output was dropped, after which the turn
 * was recorded as `agent_no_output`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';

import type {
  AcpSessionNotification,
  MessageContent,
  SessionHistoryInput,
  SessionId,
  WorkspaceId,
} from '@lody/shared';

import { MessageHandler } from '../src/lib/message-handler';
import { SessionDocument } from '../src/lib/loro/doc';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { CodeCollabV2Service } from '../src/lib/code-collab/code-collab-v2-service';
import type { ISession, SessionManager } from '../src/session/session-manager';
import type {
  SessionExecutionService,
  SessionExecutionSnapshot,
} from '../src/session/session-execution-service';
import type { SessionActivePresenceController } from '../src/lib/loro/session-active-presence';
import type { Logger } from '../src/utils/logger';
import { loadEnv } from '../src/utils/const';
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

const originalLodyServerUrl = process.env.LODY_SERVER_URL;

type LifecycleListeners = {
  error?: (event: { sessionId: SessionId; error: Error; session: ISession }) => void;
  exit?: (event: { sessionId: SessionId; exitCode: number; session: ISession }) => void;
  terminated?: (event: { sessionId: SessionId; exitCode?: number; session: ISession }) => void;
};

type MessageHandlerHost = {
  beginConversationTurn(
    sessionId: SessionId,
    userTurnId?: string,
    gateContext?: {
      dispatchSource?: 'crdt' | 'rpc' | 'queue';
      sessionDoc: SessionDocument;
      deferACPUpdateTarget?: boolean;
    }
  ): string;
  activateConversationTurnForACPUpdates(sessionId: SessionId, turnId: string): void;
  beginACPReplaySuppression(sessionId: SessionId): void;
  endACPReplaySuppression(sessionId: SessionId): void;
  createAssistantEntryForTurn(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: undefined,
    userTurnId?: string
  ): Promise<void>;
  enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
  observePromptOutputForTurn(sessionId: SessionId, turnId: string): boolean | undefined;
  executionService: SessionExecutionService;
  codeCollabV2Service: CodeCollabV2Service;
  sessionActivePresence: SessionActivePresenceController;
};

// loro-repo resolves create()/destroy() on the real clock (native async), not the
// timers vitest fakes — run repo setup/teardown on real timers.
const destroyRepoOnRealTimers = async (repo: LoroRepo) => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  await repo.destroy();
};

const createHarness = async (sessionId: SessionId) => {
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

  const listeners: LifecycleListeners = {};
  const sessionManager = {
    on: vi.fn((event: string, listener: unknown) => {
      if (event === 'error' || event === 'exit' || event === 'terminated') {
        (listeners as Record<string, unknown>)[event] = listener;
      }
    }),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(() => null),
    cleanUp: vi.fn(async () => {}),
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

  const host = handler as unknown as MessageHandlerHost;

  // The lifecycle listeners ask the execution service whether a turn runtime is
  // registered. Driving a real visible turn would need the whole dispatch stack,
  // so the snapshot — the exact seam production reads — is pinned per test.
  const setActiveTurn = (hasActiveTurn: boolean, activeTurnId?: string) => {
    vi.spyOn(host.executionService, 'getExecutionSnapshot').mockReturnValue({
      ...(activeTurnId ? { activeTurnId } : {}),
      hasActiveTurn,
      hasBlockingPendingCreate: false,
      hasReusableSession: false,
      hasRewriteBarrier: false,
      hasActiveAutomation: false,
    } satisfies SessionExecutionSnapshot);
  };

  const releaseWatch = vi
    .spyOn(host.codeCollabV2Service, 'releaseWorkspaceWatchForOwner')
    .mockImplementation(() => {});
  const clearPresence = vi.spyOn(host.sessionActivePresence, 'clear').mockImplementation(() => {});
  const setStatus = vi.spyOn(doc, 'setStatus');

  return {
    repo,
    doc,
    host,
    listeners,
    setActiveTurn,
    releaseWatch,
    clearPresence,
    setStatus,
  };
};

const agentChunk = (sessionId: SessionId, text: string): AcpSessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  },
});

const deadSession = (sessionId: SessionId): ISession => ({ sessionId }) as unknown as ISession;

const readItems = (entry: SessionHistoryInput | undefined): MessageContent[] =>
  Array.isArray(entry?.items) ? (entry.items as unknown as MessageContent[]) : [];

describe('MessageHandler session lifecycle events vs. an owned turn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.LODY_SERVER_URL = 'https://server.example.test';
    loadEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalLodyServerUrl === undefined) {
      delete process.env.LODY_SERVER_URL;
    } else {
      process.env.LODY_SERVER_URL = originalLodyServerUrl;
    }
    loadEnv();
  });

  it('keeps a deferred turn routable when `terminated` lands before the prompt claims ACP updates', async () => {
    const sessionId = 's-lifecycle-1' as SessionId;
    const userTurnId = 'user-turn-1';
    const { repo, doc, host, listeners, setActiveTurn, releaseWatch, clearPresence, setStatus } =
      await createHarness(sessionId);

    try {
      setActiveTurn(true, `assistant:${userTurnId}`);

      const turnId = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);

      // The failed restore terminates its own Session instance.
      listeners.terminated?.({ sessionId, exitCode: 0, session: deadSession(sessionId) });
      await vi.advanceTimersByTimeAsync(50);

      // The fallback's new ACP session starts prompting and claims routing.
      host.activateConversationTurnForACPUpdates(sessionId, turnId);
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'hello'));
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, ' world'));
      await vi.advanceTimersByTimeAsync(50);

      const history = await doc.getHistory();
      const assistant = history.find((entry) => entry.id === turnId);
      expect(assistant).toBeDefined();
      expect(readItems(assistant)).toEqual([{ type: 'text', text: 'hello world' }]);
      expect(assistant?.finished).not.toBe(true);

      // The turn owner stays the only party that may end the turn.
      expect(releaseWatch).not.toHaveBeenCalled();
      expect(clearPresence).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('reports produced output for a resume-fallback turn instead of `agent_no_output`', async () => {
    const sessionId = 's-lifecycle-2' as SessionId;
    const userTurnId = 'user-turn-2';
    const { repo, doc, host, listeners, setActiveTurn } = await createHarness(sessionId);

    try {
      setActiveTurn(true, `assistant:${userTurnId}`);

      const turnId = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);

      // Restore path: suppress ACP replay, `loadSession` throws
      // `[ACP_RESUME_FAILED]`, SessionManager terminates the failed instance.
      host.beginACPReplaySuppression(sessionId);
      listeners.terminated?.({ sessionId, exitCode: 0, session: deadSession(sessionId) });
      await vi.advanceTimersByTimeAsync(50);

      // Fallback succeeds on a fresh ACP session and the prompt starts.
      host.endACPReplaySuppression(sessionId);
      host.activateConversationTurnForACPUpdates(sessionId, turnId);
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'real answer'));
      await vi.advanceTimersByTimeAsync(50);

      // This is exactly what the no-output guard reads right after the prompt
      // returns; `false` here is what produced the false `agent_no_output`.
      expect(host.observePromptOutputForTurn(sessionId, turnId)).toBe(true);

      const assistant = (await doc.getHistory()).find((entry) => entry.id === turnId);
      expect(readItems(assistant)).toEqual([{ type: 'text', text: 'real answer' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('still finalizes and idles a session whose `exit` arrives with no turn running', async () => {
    const sessionId = 's-lifecycle-3' as SessionId;
    const { repo, doc, host, listeners, setActiveTurn, clearPresence, setStatus } =
      await createHarness(sessionId);

    try {
      setActiveTurn(false);

      const turnId = host.beginConversationTurn(sessionId, 'user-turn-3', {
        dispatchSource: 'crdt',
        sessionDoc: doc,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, 'user-turn-3');
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'partial'));

      listeners.exit?.({ sessionId, exitCode: 1, session: deadSession(sessionId) });
      await vi.advanceTimersByTimeAsync(50);

      expect(clearPresence).toHaveBeenCalledWith(sessionId);
      expect(setStatus).toHaveBeenCalled();
      const assistant = (await doc.getHistory()).find((entry) => entry.id === turnId);
      // Buffered output is still written out, and the entry is closed.
      expect(readItems(assistant)).toEqual([{ type: 'text', text: 'partial' }]);
      expect(assistant?.finished).toBe(true);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('releases the workspace watch on `terminated` only once no turn is running', async () => {
    const sessionId = 's-lifecycle-4' as SessionId;
    const { repo, host, listeners, setActiveTurn, releaseWatch } = await createHarness(sessionId);

    try {
      setActiveTurn(true, 'assistant:user-turn-4');
      listeners.terminated?.({ sessionId, exitCode: 0, session: deadSession(sessionId) });
      expect(releaseWatch).not.toHaveBeenCalled();

      setActiveTurn(false);
      listeners.terminated?.({ sessionId, exitCode: 0, session: deadSession(sessionId) });
      expect(releaseWatch).toHaveBeenCalledWith(sessionId);

      await vi.advanceTimersByTimeAsync(50);
      void host;
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });
});
