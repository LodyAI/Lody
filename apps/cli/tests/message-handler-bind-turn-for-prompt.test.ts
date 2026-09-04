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
import {
  PromptActivityRecorder,
  allowsPromptReplay,
  type PromptActivityObservation,
} from '../src/session/prompt-activity-recorder';
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
  observePromptOutputForTurn(sessionId: SessionId, turnId: string): boolean | undefined;
  handleAgentPermissionRequest(
    sessionId: SessionId,
    requestId: string,
    request: unknown,
    model?: unknown
  ): Promise<unknown>;
  recordPromptSideEffect(sessionId: SessionId): void;
  store: {
    observePromptActivityForTurn(sessionId: SessionId, turnId: string): PromptActivityObservation;
  };
};

const createHarness = async (sessionId: SessionId) => {
  const { repo, doc, handler, sessionManager } = await createMessageHandlerHarness(sessionId);
  return { repo, doc, sessionManager, host: handler as unknown as MessageHandlerHost };
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
      expect(
        allowsPromptReplay(host.store.observePromptActivityForTurn(sessionId, turnRef.turnId))
      ).toBe(false);
      // No-output guard: the user saw nothing, so this IS a silent failure.
      expect(host.observePromptOutputForTurn(sessionId, turnRef.turnId)).toBe(false);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it.each([
    [
      'a permission request',
      async (host: MessageHandlerHost, sessionId: SessionId, _fire: (s: SessionId) => void) => {
        // Not `recordPromptSideEffect` directly: the point is that the REAL
        // producer reaches the recorder. Rejected by the harness (no responder),
        // which is fine — recording happens on arrival, before any answer.
        await host
          .handleAgentPermissionRequest(sessionId, 'req-1', {
            sessionId,
            toolCall: { toolCallId: 'tool-1', title: 'rm -rf' },
            options: [],
          })
          .catch(() => undefined);
      },
    ],
    [
      'an fs/write_text_file',
      async (_host: MessageHandlerHost, sessionId: SessionId, fireWriteTextFile) => {
        fireWriteTextFile(sessionId);
      },
    ],
  ])('records %s against the bound turn', async (_label, act) => {
    // Both are independent JSON-RPC requests that never reach
    // `enqueueACPUpdate`, which is exactly why the replay gate could not see
    // them. Wiring each producer to the recorder is the whole point of Step D,
    // and neither call site had a test.
    const sessionId = `s-producer-${_label.replace(/[^a-z]/gi, '')}` as SessionId;
    const { repo, doc, host, sessionManager } = await createHarness(sessionId);
    const fireWriteTextFile = (id: SessionId) => {
      const registered = sessionManager.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'onWriteTextFile'
      );
      if (!registered) throw new Error('onWriteTextFile listener was never registered');
      (registered[1] as (s: SessionId, e: unknown) => void)(id, {
        path: '/tmp/x.ts',
        content: 'x',
      });
    };

    try {
      const turnRef = host.beginConversationTurn(sessionId, 'user-p', {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      expect(
        host.bindConversationTurnForPrompt(sessionId, turnRef, new PromptActivityRecorder())
      ).toBe('bound');
      expect(host.store.observePromptActivityForTurn(sessionId, turnRef.turnId)).toBe('none');

      await act(host, sessionId, fireWriteTextFile);

      expect(host.store.observePromptActivityForTurn(sessionId, turnRef.turnId)).toBe(
        'dropped_prompt_activity'
      );
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });
});
