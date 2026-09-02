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
import type { SessionManager } from '../src/session/session-manager';
import type { BindTurnForPromptResult, TurnRef } from '../src/lib/session-transient-store';
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

const destroyRepoOnRealTimers = async (repo: LoroRepo) => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  await repo.destroy();
};

const createHarness = async (sessionId: SessionId) => {
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

  it('lets replay into the turn when bind is moved before the suppression release', async () => {
    // Guards the invariant from the other side: this is what a future refactor
    // that hoists the bind would produce, and it must stay visibly wrong.
    const sessionId = 's-bind-order-wrong' as SessionId;
    const userTurnId = 'user-2';
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const turnRef = host.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      await host.createAssistantEntryForTurn(sessionId, doc, turnRef.turnId, undefined, userTurnId);

      // WRONG ORDER: bind before the suppression window closes.
      expect(host.bindConversationTurnForPrompt(sessionId, turnRef)).toBe('bound');
      host.beginACPReplaySuppression(sessionId);
      host.endACPReplaySuppression(sessionId);

      host.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'REPLAYED HISTORY'));
      await host.flushACPUpdatesNow(sessionId);

      const assistant = (await doc.getHistory()).find((entry) => entry.id === turnRef.turnId);
      expect(readItems(assistant)).toEqual([{ type: 'text', text: 'REPLAYED HISTORY' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('refuses to bind a session whose transient state is gone', async () => {
    const sessionId = 's-bind-missing-state' as SessionId;
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const turnRef = host.beginConversationTurn(sessionId, 'user-3', {
        dispatchSource: 'crdt',
        sessionDoc: doc,
        deferACPUpdateTarget: true,
      });
      host.store.deleteSession(sessionId);

      expect(host.bindConversationTurnForPrompt(sessionId, turnRef)).toBe('session_state_missing');
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
