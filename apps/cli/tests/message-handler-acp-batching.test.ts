import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { LoroRepo } from 'loro-repo';

import type {
  AcpSessionNotification,
  MessageContent,
  SessionHistoryInput,
  SessionFilePayload,
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

const readItems = (entry: SessionHistoryInput | undefined): MessageContent[] => {
  if (!entry || !Array.isArray(entry.items)) {
    return [];
  }
  return entry.items as unknown as MessageContent[];
};

type UploadValidatedSessionFileForTest = (args: {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  file: {
    absolutePath: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    textPreview: boolean;
  };
}) => Promise<SessionFilePayload & { downloadUrl: string }>;

const originalLodyServerUrl = process.env.LODY_SERVER_URL;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// loro-repo >= 0.16.11 resolves create()/initOffline()/destroy() on the real clock
// (native libuv async), NOT via the timers vitest fakes. Awaiting them while fake
// timers are installed leaves the resolution to real wall time, which on a loaded CI
// runner can be starved past the 30s test timeout. So run repo setup/teardown on real
// timers and only keep the fake clock for the batch-window assertions.
const destroyRepoOnRealTimers = async (repo: LoroRepo) => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  await repo.destroy();
};

const createHandlerHarness = async (sessionIds: SessionId[]) => {
  const logger = createSilentLogger();
  const fakeTimersActive = vi.isFakeTimers();
  if (fakeTimersActive) {
    vi.useRealTimers();
  }
  const repo = await LoroRepo.create({});
  const docs = new Map<SessionId, SessionDocument>();
  for (const sessionId of sessionIds) {
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();
    docs.set(sessionId, doc);
  }
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
        meta: {
          needToArchiveSessions: {},
          needToDeleteSessions: {},
        },
      })),
    },
    getOrCreateSessionDoc: vi.fn(async (sessionId: SessionId) => {
      const doc = docs.get(sessionId);
      if (!doc) {
        throw new Error(`Missing session doc for ${sessionId}`);
      }
      return doc;
    }),
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
      cloudPort: createTestCloudPort({
        attachmentUpload: { serverBaseUrl: 'https://uploads.example.test' },
      }),
    }
  );

  return {
    repo,
    docs,
    workspaceDocument,
    sessionManager,
    handler,
  };
};

describe('MessageHandler ACP batching', () => {
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

  it('waits for the initial 10ms batch window before flushing ACP updates', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, docs, workspaceDocument, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' world' },
        },
      });

      expect(workspaceDocument.getOrCreateSessionDoc).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5);

      expect(workspaceDocument.getOrCreateSessionDoc).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);

      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(1);

      const history = await doc.getHistory();
      const entry = history[0];
      const items = readItems(entry);
      expect(items).toEqual([{ type: 'text', text: 'hello world' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('uses a longer batch window after the first ACP flush in a turn', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, docs, workspaceDocument, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      });

      await vi.advanceTimersByTimeAsync(15);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(1);

      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' again' },
        },
      });

      await vi.advanceTimersByTimeAsync(90);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(2);

      const history = await doc.getHistory();
      expect(readItems(history[0])).toEqual([{ type: 'text', text: 'hello again' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('flushes pending ACP updates during finalization without replaying them later', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, docs, workspaceDocument, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        finalizeACPState(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'pending' },
        },
      });

      expect(workspaceDocument.getOrCreateSessionDoc).not.toHaveBeenCalled();

      await host.finalizeACPState(sessionId);

      const callCountAfterFinalize = workspaceDocument.getOrCreateSessionDoc.mock.calls.length;
      const historyAfterFinalize = await doc.getHistory();
      const entryAfterFinalize = historyAfterFinalize[0] as
        | (SessionHistoryInput & { finished?: boolean; endedAt?: number })
        | undefined;

      expect(readItems(entryAfterFinalize)).toEqual([{ type: 'text', text: 'pending' }]);
      expect(entryAfterFinalize?.finished).toBe(true);
      expect(typeof entryAfterFinalize?.endedAt).toBe('number');

      await vi.advanceTimersByTimeAsync(250);

      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(callCountAfterFinalize);

      const historyAfterTimerDrain = await doc.getHistory();
      expect(readItems(historyAfterTimerDrain[0])).toEqual([{ type: 'text', text: 'pending' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('persists updates buffered during the finalization tail instead of dropping them', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        finalizeACPState(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'pending' },
        },
      });

      // Agents keep emitting briefly after cancel: land one update in the
      // finalization tail — after the drain flushed 'pending' (1st history
      // write) and the finished marker was stamped (2nd write), but before the
      // turn state is cleared. Wiping the buffer at turn clear used to drop it.
      const originalUpdateHistory = doc.updateHistory.bind(doc);
      let historyWrites = 0;
      doc.updateHistory = (async (mutator: Parameters<typeof originalUpdateHistory>[0]) => {
        const result = await originalUpdateHistory(mutator);
        historyWrites += 1;
        if (historyWrites === 2) {
          host.enqueueACPUpdate(sessionId, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: ' tail' },
            },
          });
        }
        return result;
      }) as typeof doc.updateHistory;

      await host.finalizeACPState(sessionId);

      await vi.advanceTimersByTimeAsync(250);

      const history = await doc.getHistory();
      expect(readItems(history[0])).toEqual([{ type: 'text', text: 'pending tail' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('keeps batched ACP buffers isolated per session when updates interleave', async () => {
    const sessionIds = ['s-1' as SessionId, 's-2' as SessionId] as const;
    const { repo, docs, workspaceDocument, handler } = await createHandlerHarness([...sessionIds]);

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      };

      for (const sessionId of sessionIds) {
        host.beginConversationTurn(sessionId);
      }

      host.enqueueACPUpdate(sessionIds[0], {
        sessionId: sessionIds[0],
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'alpha' },
        },
      });
      host.enqueueACPUpdate(sessionIds[1], {
        sessionId: sessionIds[1],
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'beta' },
        },
      });
      host.enqueueACPUpdate(sessionIds[0], {
        sessionId: sessionIds[0],
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' one' },
        },
      });
      host.enqueueACPUpdate(sessionIds[1], {
        sessionId: sessionIds[1],
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' two' },
        },
      });

      await vi.advanceTimersByTimeAsync(35);

      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(2);

      const firstDoc = docs.get(sessionIds[0]);
      const secondDoc = docs.get(sessionIds[1]);
      if (!firstDoc || !secondDoc) {
        throw new Error('Missing session docs for multi-session batching test');
      }

      const firstHistory = await firstDoc.getHistory();
      const secondHistory = await secondDoc.getHistory();

      expect(readItems(firstHistory[0])).toEqual([{ type: 'text', text: 'alpha one' }]);
      expect(readItems(secondHistory[0])).toEqual([{ type: 'text', text: 'beta two' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('uploads ACP image content and appends an assistant image group', async () => {
    const sessionId = 's-1' as SessionId;
    const imageBytes = Buffer.from('fake-png-bytes');
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        image: {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'diagram.png',
          sizeBytes: imageBytes.byteLength,
          width: 1,
          height: 1,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'image',
            data: imageBytes.toString('base64'),
            mimeType: 'image/png',
            uri: 'file:///tmp/diagram.png',
          },
        },
      });

      await host.flushACPUpdatesNow(sessionId);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const history = await doc.getHistory();
      const items = readItems(history[0]);
      expect(items).toEqual([
        {
          type: 'image_group',
          images: [
            {
              imageId: 'img-1',
              mimeType: 'image/png',
              fileName: 'diagram.png',
              sizeBytes: imageBytes.byteLength,
              width: 1,
              height: 1,
            },
          ],
        },
      ]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('bounds automatic retries after a persistent ACP history failure', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, workspaceDocument, handler } = await createHandlerHarness([sessionId]);
    workspaceDocument.getOrCreateSessionDoc.mockRejectedValue(new Error('persistent failure'));

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      };
      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'retained' },
        },
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(5);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(5);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('reuses materialized rich content when its history write is retried', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const text = 'hello from retried resource';
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }
    const uploadFileMock = vi
      .spyOn(
        handler as unknown as { uploadValidatedSessionFile: UploadValidatedSessionFileForTest },
        'uploadValidatedSessionFile'
      )
      .mockResolvedValue({
        type: 'file',
        fileId: 'file-retried',
        fileName: 'retry.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        sha256,
        textPreview: true,
        transport: 'r2',
        uploadedAt: 123,
        downloadUrl: 'https://server.example.test/api/files/file-retried',
      });
    const originalUpdateHistory = doc.updateHistory.bind(doc);
    let historyWrites = 0;
    doc.updateHistory = (async (mutator: Parameters<typeof originalUpdateHistory>[0]) => {
      historyWrites += 1;
      if (historyWrites === 2) {
        throw new Error('transient history write failure');
      }
      return await originalUpdateHistory(mutator);
    }) as typeof doc.updateHistory;

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'before ' },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'resource',
            resource: { uri: 'file:///tmp/retry.txt', text, mimeType: 'text/plain' },
          },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'after' },
        },
      });

      await host.flushACPUpdatesNow(sessionId);

      expect(uploadFileMock).toHaveBeenCalledTimes(1);
      const items = readItems((await doc.getHistory())[0]);
      expect(items.map((item) => item.type)).toEqual(['text', 'file', 'text']);
      expect(items[0]).toEqual({ type: 'text', text: 'before ' });
      expect(items[1]).toMatchObject({
        type: 'file',
        fileId: 'file-retried',
        fileName: 'retry.txt',
      });
      expect(items[2]).toEqual({ type: 'text', text: 'after' });
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('keeps unread state and coalesces plans when a plan write is retried', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }
    const originalSetPlan = doc.setPlan.bind(doc);
    const planSnapshots: Parameters<typeof originalSetPlan>[0][] = [];
    doc.setPlan = (async (entries: Parameters<typeof originalSetPlan>[0]) => {
      planSnapshots.push(entries);
      if (planSnapshots.length === 1) {
        throw new Error('transient plan write failure');
      }
      return await originalSetPlan(entries);
    }) as typeof doc.setPlan;

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
        store: { get(sessionId: SessionId): { pendingUnread: boolean } };
      };
      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'before' },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'Old', priority: 'low', status: 'pending' }],
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'Latest', priority: 'high', status: 'in_progress' }],
        },
      });

      await host.flushACPUpdatesNow(sessionId);

      expect(planSnapshots).toHaveLength(2);
      expect(planSnapshots[0]).toEqual([
        { content: 'Latest', priority: 'high', status: 'in_progress' },
      ]);
      expect(planSnapshots[1]).toEqual(planSnapshots[0]);
      expect(readItems((await doc.getHistory())[0])).toEqual([{ type: 'text', text: 'before' }]);
      expect(host.store.get(sessionId).pendingUnread).toBe(true);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('persists late diff evidence against its finalized enqueue-time turn', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const standardDiffSpy = vi
      .spyOn(
        handler as unknown as {
          collectCodeCollabStandardDiffs: (
            sessionId: SessionId,
            turnId: string,
            diffs: readonly unknown[]
          ) => Promise<void>;
        },
        'collectCodeCollabStandardDiffs'
      )
      .mockResolvedValue();

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
        finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
      };
      const { turnId: oldTurnId } = host.beginConversationTurn(sessionId);
      await host.finalizeACPState(sessionId, oldTurnId);
      const persistDiffsSpy = vi
        .spyOn(
          handler as unknown as {
            persistCodeCollabTurnDiffs: (sessionId: SessionId, turnId: string) => Promise<boolean>;
          },
          'persistCodeCollabTurnDiffs'
        )
        .mockResolvedValue(true);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-1',
          status: 'completed',
          content: [{ type: 'diff', path: '/tmp/a.txt', oldText: 'old', newText: 'new' }],
        },
      });
      const { turnId: newTurnId } = host.beginConversationTurn(sessionId);
      expect(newTurnId).not.toBe(oldTurnId);

      await host.flushACPUpdatesNow(sessionId);

      expect(standardDiffSpy).toHaveBeenCalledWith(sessionId, oldTurnId, [
        { path: '/tmp/a.txt', oldText: 'old', newText: 'new' },
      ]);
      expect(persistDiffsSpy).toHaveBeenCalledWith(sessionId, oldTurnId);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('buffers write_text_file evidence before workspace resolution', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, handler, sessionManager } = await createHandlerHarness([sessionId]);
    const internals = handler as unknown as {
      beginConversationTurn(sessionId: SessionId): {
        turnId: string;
        turnEpoch: number;
        assistantEntryId: string;
      };
      flushCodeCollabEvidenceWrites(sessionId: SessionId): Promise<void>;
      codeCollabV2TurnDiffs: Map<string, unknown[]>;
      resolveCodeCollabV2Workspace(sessionId: SessionId): Promise<unknown>;
    };
    const onWriteTextFile = sessionManager.on.mock.calls.find(
      ([eventName]) => eventName === 'onWriteTextFile'
    )?.[1] as
      | ((
          sessionId: SessionId,
          evidence: { path: string; oldText: string | null; newText: string }
        ) => void)
      | undefined;

    try {
      expect(onWriteTextFile).toBeTypeOf('function');
      const { turnId } = internals.beginConversationTurn(sessionId);
      const resolveWorkspaceSpy = vi.spyOn(internals, 'resolveCodeCollabV2Workspace');

      onWriteTextFile?.(sessionId, {
        path: '/tmp/a.txt',
        oldText: 'old',
        newText: 'new',
      });
      await internals.flushCodeCollabEvidenceWrites(sessionId);

      expect(resolveWorkspaceSpy).not.toHaveBeenCalled();
      expect(internals.codeCollabV2TurnDiffs.get(`${sessionId}\0${turnId}`)).toEqual([
        {
          path: '/tmp/a.txt',
          oldText: 'old',
          newText: 'new',
          oldTextEvidence: 'strong',
        },
      ]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('restores both diff evidence sets after a transient persistence failure', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const turnId = 'turn-retry';
    const key = `${sessionId}\0${turnId}`;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const acpEvent = { path: 'a.txt', oldText: 'old', newText: 'new' };
    const editEvidence = {
      path: '/tmp/a.txt',
      changeType: 'update',
      contentOldText: 'old',
      contentNewText: 'new',
    };
    const internals = handler as unknown as {
      codeCollabV2TurnDiffs: Map<string, unknown[]>;
      codeCollabV2TurnEdits: Map<string, unknown[]>;
      resolveCodeCollabV2Workspace: (sessionId: SessionId) => Promise<unknown>;
      persistCodeCollabTurnDiffsOnce: (sessionId: SessionId, turnId: string) => Promise<boolean>;
    };
    internals.codeCollabV2TurnDiffs.set(key, [acpEvent]);
    internals.codeCollabV2TurnEdits.set(key, [editEvidence]);
    const resolveWorkspaceSpy = vi
      .spyOn(internals, 'resolveCodeCollabV2Workspace')
      .mockResolvedValueOnce({
        ok: false,
        code: 'transient_io',
        message: 'transient workspace failure',
      })
      .mockResolvedValueOnce({ ok: false, code: 'workspace_unavailable' });

    try {
      await expect(internals.persistCodeCollabTurnDiffsOnce(sessionId, turnId)).rejects.toThrow(
        'transient workspace failure'
      );
      expect(internals.codeCollabV2TurnDiffs.get(key)).toEqual([acpEvent]);
      expect(internals.codeCollabV2TurnEdits.get(key)).toEqual([editEvidence]);

      // A later finalized-turn notification invokes the same drain again. The
      // second workspace resolution proves the restored evidence was retained
      // past the early empty-evidence return.
      await expect(internals.persistCodeCollabTurnDiffsOnce(sessionId, turnId)).resolves.toBe(
        false
      );
      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(2);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('retries late finalized-turn evidence without another ACP notification', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const host = handler as unknown as {
      beginConversationTurn(sessionId: SessionId): {
        turnId: string;
        turnEpoch: number;
        assistantEntryId: string;
      };
      enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
      finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
      persistCodeCollabTurnDiffs: (sessionId: SessionId, turnId: string) => Promise<boolean>;
      collectCodeCollabStandardDiffs(
        sessionId: SessionId,
        turnId: string,
        diffs: readonly unknown[]
      ): Promise<void>;
    };

    try {
      const { turnId } = host.beginConversationTurn(sessionId);
      await host.finalizeACPState(sessionId, turnId);
      vi.spyOn(host, 'collectCodeCollabStandardDiffs').mockResolvedValue();
      const persistSpy = vi
        .spyOn(host, 'persistCodeCollabTurnDiffs')
        .mockRejectedValueOnce(new Error('transient persistence failure'))
        .mockResolvedValueOnce(true);
      vi.useFakeTimers();

      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-1',
          status: 'completed',
          content: [{ type: 'diff', path: '/tmp/a.txt', oldText: 'old', newText: 'new' }],
        },
      });
      await host.flushACPUpdatesNow(sessionId);
      expect(persistSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(persistSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(persistSpy).toHaveBeenCalledTimes(2);
      expect(persistSpy).toHaveBeenLastCalledWith(sessionId, turnId);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('drains pending evidence retries before cleanup closes the diff store', async () => {
    const sessionId = 's-1' as SessionId;
    const turnId = 'turn-cleanup';
    const key = `${sessionId}\0${turnId}`;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const internals = handler as unknown as {
      codeCollabV2TurnDiffs: Map<string, unknown[]>;
      codeCollabV2DiffStore: { close(): void };
      resolveCodeCollabV2Workspace: (sessionId: SessionId) => Promise<unknown>;
      persistLateCodeCollabTurnDiffs: (sessionId: SessionId, turnId: string) => Promise<void>;
    };
    internals.codeCollabV2TurnDiffs.set(key, [{ path: 'a.txt', oldText: 'old', newText: 'new' }]);
    const resolveWorkspaceSpy = vi
      .spyOn(internals, 'resolveCodeCollabV2Workspace')
      .mockRejectedValueOnce(new Error('transient persistence failure'))
      .mockResolvedValueOnce({ ok: false, code: 'workspace_unavailable' });
    const closeSpy = vi.spyOn(internals.codeCollabV2DiffStore, 'close');

    try {
      await internals.persistLateCodeCollabTurnDiffs(sessionId, turnId);
      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(1);

      await handler.cleanup();

      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(2);
      expect(internals.codeCollabV2TurnDiffs.has(key)).toBe(false);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(resolveWorkspaceSpy.mock.invocationCallOrder[1]).toBeLessThan(
        closeSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
      );

      await vi.advanceTimersByTimeAsync(2_000);
      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(2);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('stops ACP producers before the final cleanup evidence drain', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, handler, sessionManager } = await createHandlerHarness([sessionId]);
    const host = handler as unknown as {
      beginConversationTurn(sessionId: SessionId): {
        turnId: string;
        turnEpoch: number;
        assistantEntryId: string;
      };
      enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
      codeCollabV2DiffStore: { close(): void };
      resolveCodeCollabV2Workspace: (sessionId: SessionId) => Promise<unknown>;
    };

    try {
      const { turnId } = host.beginConversationTurn(sessionId);
      await host.finalizeACPState(sessionId, turnId);
      const resolveWorkspaceSpy = vi
        .spyOn(host, 'resolveCodeCollabV2Workspace')
        .mockResolvedValueOnce({
          ok: true,
          ownerSessionId: sessionId,
          workspaceRoot: '/tmp',
          allChangesBaseBranch: 'main',
        })
        .mockRejectedValueOnce(new Error('transient persistence failure'))
        .mockResolvedValueOnce({ ok: false, code: 'workspace_unavailable' });
      const closeSpy = vi.spyOn(host.codeCollabV2DiffStore, 'close');
      let cleanupCalls = 0;
      sessionManager.cleanUp.mockImplementation(async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
          host.enqueueACPUpdate(sessionId, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'late-cleanup-edit',
              status: 'completed',
              content: [{ type: 'diff', path: '/tmp/a.txt', oldText: 'old', newText: 'new' }],
            },
          });
        }
      });

      await handler.cleanup();

      expect(sessionManager.cleanUp).toHaveBeenNthCalledWith(1, {
        keepWorkspaceDocumentOpen: true,
      });
      expect(sessionManager.cleanUp).toHaveBeenNthCalledWith(2);
      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(3);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(resolveWorkspaceSpy.mock.invocationCallOrder[2]).toBeLessThan(
        closeSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
      );
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('waits for pending evidence collectors before the cleanup map snapshot', async () => {
    const sessionId = 's-1' as SessionId;
    const turnId = 'turn-pending-collector';
    const key = `${sessionId}\0${turnId}`;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const internals = handler as unknown as {
      codeCollabV2PendingEvidenceWrites: Map<SessionId, Set<Promise<void>>>;
      codeCollabV2TurnDiffs: Map<string, unknown[]>;
      codeCollabV2DiffStore: { close(): void };
      resolveCodeCollabV2Workspace: (sessionId: SessionId) => Promise<unknown>;
    };
    let releaseCollector: (() => void) | undefined;
    let trackedCollector: Promise<void>;
    const pending = new Set<Promise<void>>();
    const collector = new Promise<void>((resolve) => {
      releaseCollector = () => {
        internals.codeCollabV2TurnDiffs.set(key, [
          { path: 'a.txt', oldText: 'old', newText: 'new' },
        ]);
        resolve();
      };
    });
    trackedCollector = collector.finally(() => {
      pending.delete(trackedCollector);
      if (pending.size === 0) {
        internals.codeCollabV2PendingEvidenceWrites.delete(sessionId);
      }
    });
    pending.add(trackedCollector);
    internals.codeCollabV2PendingEvidenceWrites.set(sessionId, pending);
    const resolveWorkspaceSpy = vi
      .spyOn(internals, 'resolveCodeCollabV2Workspace')
      .mockResolvedValue({ ok: false, code: 'workspace_unavailable' });
    const closeSpy = vi.spyOn(internals.codeCollabV2DiffStore, 'close');

    try {
      const cleanup = handler.cleanup();
      await Promise.resolve();
      await Promise.resolve();
      expect(closeSpy).not.toHaveBeenCalled();

      releaseCollector?.();
      await cleanup;

      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(1);
      expect(internals.codeCollabV2TurnDiffs.has(key)).toBe(false);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(resolveWorkspaceSpy.mock.invocationCallOrder[0]).toBeLessThan(
        closeSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
      );
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  // Unlike the batch-window tests, this one never advances fake timers — it calls
  // flushACPUpdatesNow() directly. Its flush does real filesystem I/O
  // (materializeACPAgentRichContent → fs.mkdtemp/writeFile) plus native loro doc
  // writes. Holding vitest's fake clock over that real async only adds risk, and on a
  // contended CI runner the I/O can be starved past the default 30s budget. So run it
  // on real timers with extra headroom.
  it('uploads ACP embedded resources and preserves surrounding text order', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const text = 'hello from agent resource';
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }
    const uploadFileMock = vi
      .spyOn(
        handler as unknown as { uploadValidatedSessionFile: UploadValidatedSessionFileForTest },
        'uploadValidatedSessionFile'
      )
      .mockResolvedValue({
        type: 'file',
        fileId: 'file-1',
        fileName: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        sha256,
        textPreview: true,
        transport: 'r2',
        uploadedAt: 123,
        downloadUrl: 'https://server.example.test/api/files/file-1',
      });

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): {
          turnId: string;
          turnEpoch: number;
          assistantEntryId: string;
        };
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'before ' },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'resource',
            resource: {
              uri: 'file:///tmp/report.txt',
              text,
              mimeType: 'text/plain',
            },
          },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'after' },
        },
      });

      await host.flushACPUpdatesNow(sessionId);

      expect(uploadFileMock).toHaveBeenCalledTimes(1);
      expect(uploadFileMock.mock.calls[0]?.[0].file).toMatchObject({
        fileName: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        sha256,
        textPreview: true,
      });
      const history = await doc.getHistory();
      const items = readItems(history[0]);
      expect(items.map((item) => item.type)).toEqual(['text', 'file', 'text']);
      expect(items[0]).toEqual({ type: 'text', text: 'before ' });
      expect(items[1]).toEqual({
        type: 'file',
        fileId: 'file-1',
        fileName: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        sha256,
        textPreview: true,
        transport: 'r2',
        uploadedAt: 123,
      });
      expect(items[2]).toEqual({ type: 'text', text: 'after' });
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);
});
