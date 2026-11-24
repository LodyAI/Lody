import * as cloudCliPort from '../src/lib/cloud-cli-port';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoroRepo } from 'loro-repo';
import { Identity } from '@loro-dev/roost';
import { RoostNativeClient } from '@loro-dev/roost-node';
import {
  getSessionRoomId,
  SessionStatusFactory,
  type SessionHistoryInput,
  type SessionHistoryReadQuery,
  type SessionHistoryReadResponse,
  type SessionHistoryWriteOperation,
  type SessionHistoryWriteResponse,
  type SessionId,
} from '@lody/shared';
import { LoroDocumentManager, SessionDocument } from '../src/lib/loro/doc';
import { installRoostNodeSessionBackend } from '../src/session/roost-node-session';
import { createSessionBackend, type SessionBackendFactory } from '../src/session/session-backend';
import { MessageHandler } from '../src/lib/message-handler';
import { getDefaultLogger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';
import { loadRoostOwnerSeedLegacy } from '../src/session/roost-writer-identity';
import type { SessionBackendContractFixtureFactory } from './session-backend-contract';

export let nativeDirectory: string;
let ordinal = 0;
const nativeFixtures = new Set<{ close(): Promise<void> }>();

export function nextOrdinal(): number {
  return ordinal++;
}

export function registerRoostNativeBackendSuite(): void {
  beforeEach(() => {
    vi.spyOn(cloudCliPort, 'mintCliSessionHistoryReadProof').mockResolvedValue(
      'synthetic-history-proof'
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  beforeAll(async () => {
    nativeDirectory = await mkdtemp(join(tmpdir(), 'lody-production-roost-'));
    installRoostNodeSessionBackend({
      dbPath: join(nativeDirectory, 'history.db'),
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const fixture of nativeFixtures) await fixture.close();
    await rm(nativeDirectory, { recursive: true, force: true });
  });
}

export const nativeUser = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  userId: 'test-user',
  timestamp: '2026-10-09T00:00:00.000Z',
  status: 'pending',
  read: false,
  items: [{ type: 'text', text: id }],
  fileDiff: [],
});

export const nativeAssistant = (id: string): SessionHistoryInput => ({
  id,
  role: 'assistant',
  timestamp: '2026-10-09T00:00:01.000Z',
  finished: false,
  items: [],
  fileDiff: [],
});

export async function nativeFixture(
  id = `native-contract-${ordinal++}`,
  queued = false,
  factory?: SessionBackendFactory,
  encryptedDirectory?: string
) {
  const repo = await LoroRepo.create({});
  const sessionId = id as SessionId;
  await repo.upsertDocMeta(getSessionRoomId(sessionId), {
    id: sessionId,
    historyBackend: 'roost',
    userId: 'test-user',
    machineId: 'test-machine',
    status: SessionStatusFactory.idle(),
  });
  const doc = new SessionDocument(
    repo,
    sessionId,
    (room) => repo.unloadDoc(room),
    undefined,
    factory,
    encryptedDirectory
  );
  doc.handle = await repo.openPersistedDoc(getSessionRoomId(sessionId));
  doc.composeSessionData(doc.handle.doc, undefined, { historyBackend: 'roost' });
  if (queued)
    await doc.pushMessageQueue({
      task: 'hello',
      userId: 'test-user',
      userTurnId: 'queue-turn',
      operationId: 'queue:queue-turn',
      timestamp: '2026-10-09T00:00:00.000Z',
      acpSessionConfig: {},
    });
  let backend: Awaited<ReturnType<typeof createSessionBackend>>;
  try {
    backend = await createSessionBackend(doc, { historyBackend: 'roost' });
  } catch (error) {
    await doc.destroy({ preserveStatus: true }).catch(() => undefined);
    await repo.destroy();
    throw error;
  }
  let closed = false;
  const result = {
    repo,
    doc,
    backend,
    close: async () => {
      if (closed) return;
      closed = true;
      await doc.destroy({ preserveStatus: true });
      await repo.destroy();
      nativeFixtures.delete(result);
    },
  };
  nativeFixtures.add(result);
  return result;
}

export async function invalidateGoalIndex(sessionId: string): Promise<void> {
  const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
  const client = new RoostNativeClient({
    dbPath: join(nativeDirectory, 'history.db'),
    seed,
    allowedOwners: [Identity.fromSeed(seed).owner()],
    maxQueuedRequests: 32,
    maxQueuedBytes: 8 * 1024 * 1024,
  });
  try {
    await client.ready;
    await client.stream(`lody-session:${sessionId}`).writeBatch([], {
      indexPuts: [
        {
          table: 'lody_goal_projection_v1',
          key: new Uint8Array(),
          value: new TextEncoder().encode('{invalid'),
        },
      ],
    });
  } finally {
    await client.close();
  }
}

export const nativeContractFixture: SessionBackendContractFixtureFactory = async (options = {}) => {
  const fixture = await nativeFixture(undefined, true);
  const queueItem = (await fixture.backend.getMessageQueue())[0]!;
  let failed = false;
  const fail = (point: string) => {
    if (!failed && options.failOnceAt === point) {
      failed = true;
      throw new Error(`Injected ${point}`);
    }
  };
  const setRecord = fixture.doc.setQueuePromotionRecord.bind(fixture.doc);
  fixture.doc.setQueuePromotionRecord = async (id, record) => {
    await setRecord(id, record);
    const points = {
      prepared: 'prepared_receipt',
      history_accepted: 'history_receipt',
      activation_published: 'activation_receipt',
      queue_consumed: 'consumed_receipt',
    };
    if (record) fail(points[record.state]);
  };
  const append = fixture.backend.appendHistoryTurn.bind(fixture.backend);
  fixture.backend.appendHistoryTurn = async (entry) => {
    await append(entry);
    fail('history_acceptance');
  };
  const activate = fixture.doc.publishUserTurnActivation.bind(fixture.doc);
  fixture.doc.publishUserTurnActivation = async (id) => {
    await activate(id);
    fail('activation_publication');
  };
  const remove = fixture.doc.removeMessageQueueItem.bind(fixture.doc);
  fixture.doc.removeMessageQueueItem = async (cid) => {
    await remove(cid);
    fail('queue_consumption');
  };
  return {
    backend: fixture.backend,
    queueItem,
    entry: nativeUser(queueItem.userTurnId!),
    readCopies: async (id) =>
      (await fixture.backend.readHistory()).filter((entry) => entry.id === id),
    readQueueCids: async () => (await fixture.backend.getMessageQueue()).map((item) => item.$cid),
    readActivation: async () => (await fixture.doc.getMetaState())?.latestUserMsgId,
    readPromotionRecord: (id) => fixture.doc.getQueuePromotionRecord(id),
    dispose: fixture.close,
  };
};

export async function coldHistoryHandlerFixture(
  count: number,
  encrypted?: {
    resolveVerifiedExecutionOriginal: ReturnType<
      typeof import('../src/lib/e2ee/execution-intent-verification').makeVerifiedExecutionIntent
    >;
    machineId: string;
  }
) {
  const machineId = encrypted?.machineId ?? 'test-machine';
  const repo = await LoroRepo.create({});
  const docs = new Map<SessionId, SessionDocument>();
  for (let index = 0; index < count; index++) {
    const id = `pending-handler-${ordinal++}` as SessionId;
    await repo.upsertDocMeta(getSessionRoomId(id), {
      id,
      historyBackend: 'roost',
      userId: 'test-user',
    });
    docs.set(
      id,
      new SessionDocument(
        repo,
        id,
        (room) => repo.unloadDoc(room),
        undefined,
        undefined,
        encrypted ? join(nativeDirectory, 'encrypted-owner') : undefined
      )
    );
  }
  const noop = () => undefined;
  const handler = new MessageHandler(
    {
      on: noop,
      setRequestPermissionHandler: noop,
      getSession: () => undefined,
      cleanUp: async () => undefined,
    } as never,
    {
      repo,
      workspaceId: 'test-workspace',
      encryptedWorkspace: encrypted,
      verifyRoostInput: LoroDocumentManager.prototype.verifyRoostInput,
      getOrCreateSessionDoc: async (id: SessionId) => {
        const doc = docs.get(id)!;
        if (!doc.handle) {
          doc.handle = await repo.openPersistedDoc(getSessionRoomId(id));
          doc.composeSessionData(doc.handle.doc, undefined, await doc.getMetaState());
        }
        return doc;
      },
      isTransportConnected: () => false,
      markMachineFlockDocDirty: noop,
      publishSessionPresence: noop,
      clearSessionPresence: noop,
      sendMachineHeartbeat: async () => undefined,
    } as never,
    getDefaultLogger(),
    {
      machineId,
      workspaceId: 'test-workspace' as never,
      token: 'synthetic-token',
      userId: 'test-user',
      encryptedWorkspace: !!encrypted,
      machineName: 'synthetic',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    }
  );
  const observers = new Set<object>();
  const observerWaiters = new Map<number, () => void>();
  const observe = repo.observeDocs.bind(repo);
  vi.spyOn(repo, 'observeDocs').mockImplementation((listener, options) => {
    const subscription = observe(listener, options);
    observers.add(subscription);
    observerWaiters.get(observers.size)?.();
    return {
      ...subscription,
      unsubscribe: () => {
        subscription.unsubscribe();
        observers.delete(subscription);
      },
    };
  });
  return {
    repo,
    docs,
    observers,
    handler,
    rpc: handler as unknown as {
      readSessionHistoryForRpc(
        id: SessionId,
        query: SessionHistoryReadQuery,
        signal?: AbortSignal
      ): Promise<SessionHistoryReadResponse>;
      writeSessionHistoryForRpc(
        id: SessionId,
        operation: SessionHistoryWriteOperation,
        payload: Record<string, unknown>
      ): Promise<SessionHistoryWriteResponse>;
      resolveSessionHistoryOwnerSessionId(
        id: SessionId,
        options: { signal: AbortSignal }
      ): Promise<SessionId>;
    },
    observing: (expected: number) =>
      observers.size === expected
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            observerWaiters.set(expected, resolve);
          }),
    ready: (id: SessionId) =>
      repo.upsertDocMeta(getSessionRoomId(id), {
        machineId,
        status: SessionStatusFactory.idle(),
      }),
    close: async () => {
      await handler.cleanup();
      for (const doc of docs.values()) if (doc.handle) await doc.destroy({ preserveStatus: true });
      await repo.destroy();
    },
  };
}
