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
    gateContext?: { dispatchSource?: 'crdt' | 'rpc' | 'queue'; sessionDoc: SessionDocument }
  ): string;
  createAssistantEntryForTurn(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: undefined,
    userTurnId?: string
  ): Promise<void>;
  enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
  finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
  store: { getTurnId(sessionId: SessionId): string | undefined };
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
      const turnId = host.beginConversationTurn(sessionId, userTurnId, {
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

  it('still closes the entry when the turn it names is the one finalizing', async () => {
    const sessionId = 's-finalize-cas-normal' as SessionId;
    const userTurnId = 'user-2';
    const { repo, doc, host } = await createHarness(sessionId);

    try {
      const turnId = host.beginConversationTurn(sessionId, userTurnId, {
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
