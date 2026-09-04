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
 * no-turnId `finalizeACPState`, which cleared the turn; the fallback's routing
 * claim then found an idle turn, and every one of the 505 seconds of agent
 * output was dropped, after which the turn was recorded as `agent_no_output`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcpSessionNotification,
  MessageContent,
  SessionHistoryInput,
  SessionId,
} from '@lody/shared';

import type { SessionDocument } from '../src/lib/loro/doc';
import type { CodeCollabV2Service } from '../src/lib/code-collab/code-collab-v2-service';
import type { ISession } from '../src/session/session-manager';
import type {
  SessionExecutionService,
  SessionExecutionSnapshot,
} from '../src/session/session-execution-service';
import type { SessionActivePresenceController } from '../src/lib/loro/session-active-presence';
import { loadEnv } from '../src/utils/const';
import { createMessageHandlerHarness, destroyRepoOnRealTimers } from './message-handler-harness';

const originalLodyServerUrl = process.env.LODY_SERVER_URL;

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
  createAssistantEntryForTurn(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: undefined,
    userTurnId?: string
  ): Promise<void>;
  enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
  executionService: SessionExecutionService;
  codeCollabV2Service: CodeCollabV2Service;
  sessionActivePresence: SessionActivePresenceController;
};

const createHarness = async (sessionId: SessionId) => {
  const { repo, doc, handler, listeners } = await createMessageHandlerHarness(sessionId);
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

  return { repo, doc, host, listeners, setActiveTurn, releaseWatch, clearPresence, setStatus };
};

const agentChunk = (sessionId: SessionId, text: string): AcpSessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  },
});

const deadSession = (sessionId: SessionId): ISession => ({ sessionId }) as unknown as ISession;

declare const listenersShape: Awaited<ReturnType<typeof createHarness>>['listeners'];

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

  it.each([
    [
      'error',
      (l: typeof listenersShape, sessionId: SessionId) =>
        l.error?.({
          sessionId,
          error: new Error('resource limit'),
          session: deadSession(sessionId),
        }),
    ],
    [
      'exit',
      (l: typeof listenersShape, sessionId: SessionId) =>
        l.exit?.({ sessionId, exitCode: 1, session: deadSession(sessionId) }),
    ],
    [
      'terminated',
      (l: typeof listenersShape, sessionId: SessionId) =>
        l.terminated?.({ sessionId, exitCode: 0, session: deadSession(sessionId) }),
    ],
  ])('drains buffered output on `%s` without ending an owned turn', async (kind, fire) => {
    // All three listeners, not just `terminated`: a resource-limit violation
    // arrives as `error`, and an in-session AI command exit arrives as `exit`.
    // While a turn is owned they may only flush what is already buffered —
    // the flush has to actually happen (nothing else drains it here), and
    // none of presence/status/turn-state may be touched.
    const sessionId = `s-drain-${kind}` as SessionId;
    const userTurnId = `user-${kind}`;
    const { repo, doc, host, listeners, setActiveTurn, releaseWatch, clearPresence, setStatus } =
      await createHarness(sessionId);

    try {
      setActiveTurn(true, `assistant:${userTurnId}`);
      const turnId = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'buffered before the event'));

      fire(listeners, sessionId);
      await vi.advanceTimersByTimeAsync(50);

      const assistant = (await doc.getHistory()).find((entry) => entry.id === turnId);
      expect(readItems(assistant)).toEqual([{ type: 'text', text: 'buffered before the event' }]);
      expect(assistant?.finished).not.toBe(true);
      expect(releaseWatch).not.toHaveBeenCalled();
      expect(clearPresence).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('still finalizes and idles a session with no turn running', async () => {
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

  it('releases the workspace watch after termination with no running turn', async () => {
    const sessionId = 's-lifecycle-4' as SessionId;
    const { repo, listeners, setActiveTurn, releaseWatch } = await createHarness(sessionId);
    try {
      setActiveTurn(false);
      listeners.terminated?.({ sessionId, exitCode: 0, session: deadSession(sessionId) });
      expect(releaseWatch).toHaveBeenCalledWith(sessionId);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

});
