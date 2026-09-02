/**
 * `bindTurnForPrompt` ordering, and the fail-closed refusals.
 *
 * Binding must happen AFTER `acpReplaySuppression.release` and BEFORE the prompt.
 * Both edges are load bearing:
 *
 * - Bind too early and the notifications ACP `loadSession` replays while restoring
 *   a session land in the NEW turn's assistant entry, so the user sees the whole
 *   previous conversation replayed as fresh output.
 * - Bind too late and the turn's own output has no routing target.
 *
 * The predecessor (`activateTurnACPUpdateTarget`) absorbed an early bind as a
 * silent no-op, so this ordering used to be enforced by accident. An
 * authoritative write has no such backstop, which is what these tests are for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcpSessionNotification,
  MessageContent,
  SessionHistoryInput,
  SessionId,
} from '@lody/shared';

import type { SessionDocument } from '../src/lib/loro/doc';
import type { BindTurnForPromptResult, TurnRef } from '../src/lib/session-transient-store';
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
  ): TurnRef;
  bindConversationTurnForPrompt(sessionId: SessionId, turnRef: TurnRef): BindTurnForPromptResult;
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
  flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
  store: { deleteSession(sessionId: SessionId): void };
};

const createHarness = async (sessionId: SessionId) => {
  const { repo, doc, handler } = await createMessageHandlerHarness(sessionId);
  return { repo, doc, host: handler as unknown as MessageHandlerHost };
};

const agentChunk = (sessionId: SessionId, text: string): AcpSessionNotification => ({
  sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});

const readItems = (entry: SessionHistoryInput | undefined): MessageContent[] =>
  Array.isArray(entry?.items) ? (entry.items as unknown as MessageContent[]) : [];

describe('MessageHandler bindTurnForPrompt', () => {
  beforeEach(() => {
    process.env.LODY_SERVER_URL = 'https://server.example.test';
    loadEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLodyServerUrl === undefined) {
      delete process.env.LODY_SERVER_URL;
    } else {
      process.env.LODY_SERVER_URL = originalLodyServerUrl;
    }
    loadEnv();
  });

  it('keeps loadSession replay out of the new turn when bind follows the suppression release', async () => {
    const sessionId = 's-bind-order' as SessionId;
    const userTurnId = 'user-1';
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      // Restore path: the turn starts deferred, then suppression is armed before
      // ACP `loadSession` replays the previous conversation.
      const turnRef = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnRef.turnId, undefined, userTurnId);
      host.beginACPReplaySuppression(sessionId);

      // Everything `loadSession` replays arrives here.
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'REPLAYED HISTORY'));
      await host.flushACPUpdatesNow(sessionId);

      const duringSuppression = (await doc.getHistory()).find(
        (entry) => entry.id === turnRef.turnId
      );
      expect(readItems(duringSuppression)).toEqual([]);

      // Correct order: release, then bind, then prompt.
      host.endACPReplaySuppression(sessionId);
      expect(host.bindConversationTurnForPrompt(sessionId, turnRef)).toBe('bound');

      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'real answer'));
      await host.flushACPUpdatesNow(sessionId);

      const assistant = (await doc.getHistory()).find((entry) => entry.id === turnRef.turnId);
      expect(readItems(assistant)).toEqual([{ type: 'text', text: 'real answer' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('refuses to bind a turn that a redispatch superseded', async () => {
    const sessionId = 's-bind-superseded' as SessionId;
    const userTurnId = 'user-4';
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const staleRef = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      // Same turn id (`assistant:<userTurnId>`), new epoch.
      const liveRef = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      expect(liveRef.turnId).toBe(staleRef.turnId);
      expect(liveRef.turnEpoch).not.toBe(staleRef.turnEpoch);

      expect(host.bindConversationTurnForPrompt(sessionId, staleRef)).toBe('turn_superseded');
      expect(host.bindConversationTurnForPrompt(sessionId, liveRef)).toBe('bound');
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });
});
