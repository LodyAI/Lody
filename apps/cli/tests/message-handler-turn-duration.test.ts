import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';

import type { SessionHistoryInput, SessionId, WorkspaceId } from '@lody/shared';

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
  finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
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

  it('keeps a finished turn timing when teardown finalizes again at app close', async () => {
    // #260: closing the app raises exit/terminated for every live session, and
    // both handlers run the no-turnId finalize whether or not the turn is over.
    // The turn's `endedAt` used to be rewritten to the close-time clock, so the
    // rendered "Worked for …" grew with however long the app had been open.
    const sessionId = 's-duration-1' as SessionId;
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      await doc.updateHistory((history) => [...history, assistantEntry()]);

      const now = vi.spyOn(Date, 'now').mockReturnValue(TURN_ENDED_AT);
      await handler.finalizeACPState(sessionId);
      expect((await doc.getHistory())[0]).toMatchObject({
        finished: true,
        endedAt: TURN_ENDED_AT,
      });

      now.mockReturnValue(APP_CLOSED_AT);
      await handler.finalizeACPState(sessionId);

      expect((await doc.getHistory())[0]?.endedAt).toBe(TURN_ENDED_AT);
    } finally {
      await repo.destroy();
    }
  });

  it('still stamps a turn that was interrupted before it finished', async () => {
    const sessionId = 's-duration-2' as SessionId;
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      await doc.updateHistory((history) => [...history, assistantEntry()]);

      vi.spyOn(Date, 'now').mockReturnValue(APP_CLOSED_AT);
      await handler.finalizeACPState(sessionId);

      expect((await doc.getHistory())[0]).toMatchObject({
        finished: true,
        endedAt: APP_CLOSED_AT,
      });
    } finally {
      await repo.destroy();
    }
  });
});
