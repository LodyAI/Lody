/**
 * Finalization is a compare-and-set against the turn it names.
 *
 * `finalizeACPState` runs a long await chain (history gate, ACP flush, usage,
 * image uploads, unread marker) before it stamps `finished=true` and clears turn
 * state. A redispatch reuses `assistant:<userTurnId>` as the turn id, so "same
 * turn id" is not "same turn": epoch 2 can take the entry over while epoch 1 is
 * still inside those awaits. Committing on the pre-await snapshot closes an entry
 * a live turn is streaming into and clears that turn's routing state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcpSessionNotification,
  MessageContent,
  SessionHistoryInput,
  SessionId,
} from '@lody/shared';

import type { SessionDocument } from '../src/lib/loro/doc';
import { loadEnv } from '../src/utils/const';

import { createMessageHandlerHarness, destroyRepoOnRealTimers } from './message-handler-harness';

const originalLodyServerUrl = process.env.LODY_SERVER_URL;

type MessageHandlerHost = {
  beginConversationTurn(
    sessionId: SessionId,
    userTurnId?: string,
    gateContext?: { dispatchSource?: 'crdt' | 'rpc' | 'queue'; sessionDoc: SessionDocument }
  ): { turnId: string; turnEpoch: number; assistantEntryId: string };
  createAssistantEntryForTurn(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: undefined,
    userTurnId?: string
  ): Promise<void>;
  enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
  flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
  finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
  store: { getTurnId(sessionId: SessionId): string | undefined };
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

describe('MessageHandler turn finalization compare-and-set', () => {
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

  it('does not close or clear a turn that took over during finalization', async () => {
    const sessionId = 's-finalize-cas' as SessionId;
    const userTurnId = 'user-1';
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const { turnId } = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);
      // Marks the session unread, which is what gives us a deterministic await
      // inside `finalizeACPState` — right before the `finished` stamp.
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'first run'));

      let redispatched = false;
      vi.spyOn(doc, 'setLastMessageAt').mockImplementation(async () => {
        if (redispatched) return;
        redispatched = true;
        // The turn is redispatched while epoch 1 is mid-finalization. Same turn
        // id (`assistant:<userTurnId>`), new epoch.
        host.beginConversationTurn(sessionId, userTurnId, {
          dispatchSource: 'crdt',
          sessionDoc: doc,
        });
      });

      await host.finalizeACPState(sessionId, turnId);

      expect(redispatched).toBe(true);

      // The entry belongs to the live turn now: it must not be stamped finished.
      const assistant = (await doc.getHistory()).find((entry) => entry.id === turnId);
      expect(assistant).toBeDefined();
      expect(readItems(assistant)).toEqual([{ type: 'text', text: 'first run' }]);
      expect(assistant?.finished).not.toBe(true);
      expect(assistant?.endedAt).toBeUndefined();

      // ...and the CAS refused to clear the new turn's state.
      expect(host.store.getTurnId(sessionId)).toBe(turnId);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('keeps late-update routing when a teardown finalizes without a turn id', async () => {
    // Archive/delete/child-cleanup/shutdown paths pass no turn id. They must still
    // commit through the CAS: clearing turn state without remembering the routing
    // target drops every update that arrives after the clear. The lifecycle
    // listeners reach this branch whenever no execution runtime is registered,
    // and a store turn can exist without one (an auto-prompt turn runs inside the
    // visible turn's runtime under its own store turn id).
    const sessionId = 's-finalize-no-turnid' as SessionId;
    const userTurnId = 'user-3';
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const { turnId } = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'before teardown'));

      await host.finalizeACPState(sessionId);

      expect(host.store.getTurnId(sessionId)).toBeUndefined();

      // A late update still routes to the finalized turn's entry.
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, ' and after'));
      await host.flushACPUpdatesNow(sessionId);

      const assistant = (await doc.getHistory()).find((entry) => entry.id === turnId);
      expect(readItems(assistant)).toEqual([{ type: 'text', text: 'before teardown and after' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('still closes the entry when the turn it names is the one finalizing', async () => {
    const sessionId = 's-finalize-cas-normal' as SessionId;
    const userTurnId = 'user-2';
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const { turnId } = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);
      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'done'));

      await host.finalizeACPState(sessionId, turnId);

      const assistant = (await doc.getHistory()).find((entry) => entry.id === turnId);
      expect(assistant?.finished).toBe(true);
      expect(typeof assistant?.endedAt).toBe('number');
      expect(host.store.getTurnId(sessionId)).toBeUndefined();
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });
});
