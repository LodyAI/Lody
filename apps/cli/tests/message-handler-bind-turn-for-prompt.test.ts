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
import { PromptActivityRecorder } from '../src/session/prompt-activity-recorder';
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
  bindConversationTurnForPrompt(
    sessionId: SessionId,
    turnRef: TurnRef,
    recorder?: PromptActivityRecorder
  ): BindTurnForPromptResult;
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
  hasPromptOutputForTurn(sessionId: SessionId, turnId: string): boolean;
  observePromptOutputForTurn(sessionId: SessionId, turnId: string): boolean | undefined;
  recordPromptSideEffect(sessionId: SessionId): void;
  store: {
    deleteSession(sessionId: SessionId): void;
    clearTurnState(sessionId: SessionId): void;
    observePromptActivityForTurn(sessionId: SessionId, turnId: string): string;
  };
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

  it('refuses a replay after the turn requested a permission, with nothing in the transcript', async () => {
    // End-to-end through the real producer: `handleAgentPermissionRequest` records
    // a side effect, so a turn that approved and ran a tool without emitting any
    // ACP update still refuses replay. Before the recorder this read as "produced
    // nothing" and the prompt was replayed, re-running the tool.
    const sessionId = 's-recorder-permission' as SessionId;
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const turnRef = host.beginConversationTurn(sessionId, 'user-1', {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      const recorder = new PromptActivityRecorder();
      expect(host.bindConversationTurnForPrompt(sessionId, turnRef, recorder)).toBe('bound');

      expect(host.hasPromptOutputForTurn(sessionId, turnRef.turnId)).toBe(false);

      // The agent asks to run a tool. Nothing reaches the transcript.
      host.recordPromptSideEffect(sessionId);

      expect(host.store.observePromptActivityForTurn(sessionId, turnRef.turnId)).toBe(
        'dropped_prompt_activity'
      );
      expect(host.hasPromptOutputForTurn(sessionId, turnRef.turnId)).toBe(true);

      // ...and the evidence survives the turn ending, which is when the gate runs.
      host.store.clearTurnState(sessionId);
      expect(host.hasPromptOutputForTurn(sessionId, turnRef.turnId)).toBe(true);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('separates "may have acted" from "produced visible output"', async () => {
    // These are different questions and the two guards need different answers.
    // Conflating them means a turn that only requested a permission reads as
    // having produced output, so the no-output guard takes the SUCCESS path: no
    // `agent_no_output`, no notice, and the user is left looking at an empty
    // assistant entry with no explanation — worse than the original bug.
    //
    // Asserted at the MessageHandler seam with no mocked deps, because that is
    // exactly where the two accessors diverge.
    const sessionId = 's-recorder-visible-vs-acted' as SessionId;
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const turnRef = host.beginConversationTurn(sessionId, 'user-5', {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnRef.turnId, undefined, 'user-5');
      expect(
        host.bindConversationTurnForPrompt(sessionId, turnRef, new PromptActivityRecorder())
      ).toBe('bound');

      // The agent asks to run a tool and nothing else happens: no ACP update, so
      // nothing reaches the transcript.
      host.recordPromptSideEffect(sessionId);

      expect(host.store.observePromptActivityForTurn(sessionId, turnRef.turnId)).toBe(
        'dropped_prompt_activity'
      );
      // Replay gate: this turn may have acted, so refuse.
      expect(host.hasPromptOutputForTurn(sessionId, turnRef.turnId)).toBe(true);
      // No-output guard: the user saw nothing, so this IS a silent failure.
      expect(host.observePromptOutputForTurn(sessionId, turnRef.turnId)).toBe(false);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('reports visible output once an update is actually routed', async () => {
    const sessionId = 's-recorder-visible-routed' as SessionId;
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const turnRef = host.beginConversationTurn(sessionId, 'user-6', {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnRef.turnId, undefined, 'user-6');
      expect(
        host.bindConversationTurnForPrompt(sessionId, turnRef, new PromptActivityRecorder())
      ).toBe('bound');

      expect(host.observePromptOutputForTurn(sessionId, turnRef.turnId)).toBe(false);

      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'hello'));
      await host.flushACPUpdatesNow(sessionId);

      expect(host.observePromptOutputForTurn(sessionId, turnRef.turnId)).toBe(true);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('leaves the no-output guard failing open for an unobservable turn', async () => {
    const sessionId = 's-recorder-unobservable' as SessionId;
    const { repo, host } = await createHarness(sessionId);

    try {
      // Never seen by the store at all.
      expect(host.observePromptOutputForTurn(sessionId, 'assistant:user-7')).toBeUndefined();
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('refuses a replay for a turn with no recorder at all', async () => {
    const sessionId = 's-recorder-missing' as SessionId;
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const turnRef = host.beginConversationTurn(sessionId, 'user-2', {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      // Bound WITHOUT a recorder, as a process restart would leave things.
      expect(host.bindConversationTurnForPrompt(sessionId, turnRef)).toBe('bound');

      expect(host.store.observePromptActivityForTurn(sessionId, turnRef.turnId)).toBe('unknown');
      expect(host.hasPromptOutputForTurn(sessionId, turnRef.turnId)).toBe(true);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('records a routed update as persisted output', async () => {
    const sessionId = 's-recorder-routed' as SessionId;
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const turnRef = host.beginConversationTurn(sessionId, 'user-4', {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnRef.turnId, undefined, 'user-4');
      expect(
        host.bindConversationTurnForPrompt(sessionId, turnRef, new PromptActivityRecorder())
      ).toBe('bound');

      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'hello'));
      await host.flushACPUpdatesNow(sessionId);

      expect(host.store.observePromptActivityForTurn(sessionId, turnRef.turnId)).toBe(
        'persisted_output'
      );
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
