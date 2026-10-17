import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { LoroRepo } from 'loro-repo';
import { LoroDoc } from 'loro-crdt';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import Database from 'better-sqlite3';
import {
  encryptCodeCollabV2RpcPayload,
  LoroStreamsMachineRpcClient,
  LoroStreamsMachineRpcServer,
  type LoroJsonLiveBatchHandler,
  type LoroStreamsJsonStreamClient,
  type SessionHistoryRpcRequest,
} from '@lody/loro-streams-rpc';
import { createRemoteRoostSessionDataFactory } from '../../../packages/components/src/lib/roost-session-bridge';
import {
  getSessionHistoryRpcRejection,
  putSessionHistoryRpcRejection,
} from '../src/session/session-history-rpc-rejections';
import { it as effectIt } from '@effect/vitest';
import {
  awaitSessionHistoryOwner,
  SESSION_HISTORY_METADATA_TIMEOUT_MS,
} from '../src/session/session-history-owner';
import { SessionDocument } from '../src/lib/loro/doc';
import { installRoostNodeSessionBackend } from '../src/session/roost-node-session';
import {
  createSessionBackend,
  routeRemoteOwnedSessionHistory,
  type SessionBackendFactory,
} from '../src/session/session-backend';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  SessionHistoryReadResponseSchema,
  SessionHistoryWriteResponseSchema,
  getMachineRoomId,
  getSessionRoomId,
  SessionStatusFactory,
  type SessionId,
  type SessionHistoryInput,
  type SessionHistoryReadResponse,
  type SessionHistoryReadQuery,
  SessionHistoryChangesSchema,
  type SessionHistoryWriteResponse,
  type SessionHistoryWriteOperation,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { MessageHandler } from '../src/lib/message-handler';
import { MachineRuntime } from '../src/lib/machine-runtime';
import { getDefaultLogger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';
import { createCommandSessionHistoryFactory, type AuthContext } from '../src/lib/command-runtime';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import {
  hashHistoryEntryForVersion,
  hashText,
  type HistoryImportInput,
} from '@lody/shared/session-data';
import { Identity } from '@loro-dev/roost';
import { RoostNativeClient, RoostHostError } from '@loro-dev/roost-node';
import { describeRoostHistoryFailure } from '../src/session/roost-history-diagnostics';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { findNextDispatchableUserTurn } from '../src/session/session-dispatch-logic';
import type { SessionMeta } from '@lody/shared';
import { encodeRoostContent } from '../src/session/roost-history-port';
import { loadRoostOwnerSeedLegacy } from '../src/session/roost-writer-identity';
import type { SessionBackendContractFixtureFactory } from './session-backend-contract';
import { defineSessionBackendContract } from './session-backend-contract';
let nativeDirectory: string;
let ordinal = 0;
const nativeFixtures = new Set<{ close(): Promise<void> }>();
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
const nativeUser = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  userId: 'test-user',
  timestamp: '2026-10-09T00:00:00.000Z',
  status: 'pending',
  read: false,
  items: [{ type: 'text', text: id }],
  fileDiff: [],
});
const nativeAssistant = (id: string): SessionHistoryInput => ({
  id,
  role: 'assistant',
  timestamp: '2026-10-09T00:00:01.000Z',
  finished: false,
  items: [],
  fileDiff: [],
});
async function nativeFixture(
  id = `native-contract-${ordinal++}`,
  queued = false,
  factory?: SessionBackendFactory
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
    factory
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
const nativeContractFixture: SessionBackendContractFixtureFactory = async (options = {}) => {
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
defineSessionBackendContract('Production Roost SQLite', nativeContractFixture);

async function coldHistoryHandlerFixture(count: number) {
  const repo = await LoroRepo.create({});
  const docs = new Map<SessionId, SessionDocument>();
  for (let index = 0; index < count; index++) {
    const id = `pending-handler-${ordinal++}` as SessionId;
    await repo.upsertDocMeta(getSessionRoomId(id), {
      id,
      historyBackend: 'roost',
      userId: 'test-user',
    });
    docs.set(id, new SessionDocument(repo, id, (room) => repo.unloadDoc(room)));
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
      machineId: 'test-machine',
      workspaceId: 'test-workspace' as never,
      token: 'synthetic-token',
      userId: 'test-user',
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
        machineId: 'test-machine',
        status: SessionStatusFactory.idle(),
      }),
    close: async () => {
      await handler.cleanup();
      for (const doc of docs.values()) if (doc.handle) await doc.destroy({ preserveStatus: true });
      await repo.destroy();
    },
  };
}

describe('Production Roost history semantics', () => {
  it('cancels parked history observers without cancelling a writer waiting for the same owner', async () => {
    const fixture = await coldHistoryHandlerFixture(1);
    const id = [...fixture.docs.keys()][0]!;
    const watching = fixture.rpc.readSessionHistoryForRpc(id, {
      kind: 'watchChanges',
      checkpoint: 'synthetic-checkpoint',
      waitMs: 15_000,
    });
    const writing = fixture.rpc.writeSessionHistoryForRpc(id, 'append', {
      entry: nativeUser('writer-survives-observer-stop'),
    });
    try {
      await fixture.observing(2);
      fixture.handler.cancelPendingHistoryWatches();
      expect(await watching).toMatchObject({ success: false });
      expect(fixture.observers.size).toBe(1);
      await fixture.ready(id);
      expect(await writing).toMatchObject({ success: true });
      expect(await (await createSessionBackend(fixture.docs.get(id)!)).readHistory()).toMatchObject(
        [{ id: 'writer-survives-observer-stop' }]
      );
    } finally {
      await fixture.close();
      await Promise.all([watching, writing]);
    }
  });

  it('cancels a parked local watch before draining and durably flushes another session ACP buffer on shutdown', async () => {
    const fixture = await coldHistoryHandlerFixture(2);
    const [watchedId, writingId] = [...fixture.docs.keys()];
    if (!watchedId || !writingId) throw new Error('Missing synthetic sessions');
    let closing: Promise<void> | undefined;
    const host = fixture.handler as unknown as {
      beginConversationTurn(id: SessionId, userTurnId: string): string;
      enqueueACPUpdate(
        id: SessionId,
        notification: import('@lody/shared').AcpSessionNotification
      ): void;
      store: { get(id: SessionId): { acpUpdateBuffer: unknown[] } };
    };
    try {
      await Promise.all([watchedId, writingId].map((id) => fixture.ready(id)));
      const page = await fixture.rpc.readSessionHistoryForRpc(watchedId, {
        kind: 'readLatestPage',
        limit: 40,
        withCheckpoint: true,
      });
      const checkpoint = (page.result as { checkpoint?: string }).checkpoint;
      if (!page.success || !checkpoint) throw new Error('Missing watch checkpoint');
      await fixture.rpc.writeSessionHistoryForRpc(writingId, 'append', {
        entry: nativeUser('shutdown-input'),
      });
      const writingDoc = fixture.docs.get(writingId)!;
      const backend = await createSessionBackend(writingDoc);
      const assistantId = host.beginConversationTurn(writingId, 'shutdown-input');
      await backend.appendHistoryTurn(nativeAssistant(assistantId));
      const watchedBackend = await createSessionBackend(fixture.docs.get(watchedId)!);
      const wait = watchedBackend.history.waitForChanges?.bind(watchedBackend.history);
      if (!wait) throw new Error('Expected native watch');
      const parked = Promise.withResolvers<void>();
      let watchSignal: AbortSignal | undefined;
      vi.spyOn(watchedBackend.history, 'waitForChanges').mockImplementation(
        (cursor, waitMs, signal) => {
          watchSignal = signal;
          const pending = wait(cursor, waitMs, signal);
          parked.resolve();
          return pending;
        }
      );
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const startedAt = Date.now();
      host.enqueueACPUpdate(writingId, {
        sessionId: writingId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'final buffered reply' },
        },
      });
      expect(host.store.get(writingId).acpUpdateBuffer).toHaveLength(1);
      const runtime = new MachineRuntime({
        workspaceDocument: { clearMachineMonitorProvider: () => {} } as never,
        sessionManagerFactory: () => {
          throw new Error('Synthetic test does not start an agent');
        },
        handlerConfig: { machineId: 'test-machine', workspaceId: 'test-workspace' } as never,
        logger: getDefaultLogger(),
      });
      Reflect.set(runtime, 'handler', fixture.handler);
      const watching = runtime.dispatchLocalMessageForResponse({
        type: 'session/history-read',
        sessionId: watchedId,
        workspaceId: 'test-workspace' as WorkspaceId,
        machineId: 'test-machine' as MachineId,
        query: { kind: 'watchChanges', checkpoint, waitMs: 15_000 },
      });
      await parked.promise;
      closing = runtime.cleanup();
      // Cancellation is synchronous, before the drain can wait on the observer.
      // No native I/O guard or ACP batch timer is advanced to make shutdown pass.
      expect(watchSignal?.aborted).toBe(true);
      expect(await watching).toMatchObject([
        { type: 'session/history-read_response', success: false },
      ]);
      await closing;
      expect(Date.now()).toBe(startedAt);
      expect(host.store.get(writingId).acpUpdateBuffer).toEqual([]);
      await fixture.close();
      const reopened = await nativeFixture(writingId);
      expect(await reopened.backend.readTurn(assistantId)).toMatchObject({
        state: 'ready',
        turn: { items: [{ type: 'text', text: 'final buffered reply' }] },
      });
    } finally {
      fixture.handler.cancelPendingHistoryWatches();
      await closing;
      await fixture.close();
    }
  });

  it('cancels all pending MessageHandler writes before cleanup and never opens history when metadata arrives later', async () => {
    const fixture = await coldHistoryHandlerFixture(2);
    const ids = [...fixture.docs.keys()];
    const writes = Array.from({ length: 6 }, (_, index) =>
      fixture.rpc.writeSessionHistoryForRpc(ids[index % ids.length]!, 'append', {
        entry: nativeUser(`cleanup-turn-${index}`),
      })
    );
    try {
      await fixture.observing(6);
      expect([...fixture.docs.values()].every((doc) => doc.handle === null)).toBe(true);
      await fixture.handler.cleanup();
      expect((await Promise.all(writes)).every((response) => !response.success)).toBe(true);
      expect(fixture.observers.size).toBe(0);
      await Promise.all(ids.map((id) => fixture.ready(id)));
      const afterCleanup = await fixture.rpc.writeSessionHistoryForRpc(ids[0]!, 'append', {
        entry: nativeUser('after-cleanup'),
      });
      expect(afterCleanup.success).toBe(false);
      expect([...fixture.docs.values()].every((doc) => doc.handle === null)).toBe(true);
      expect(fixture.observers.size).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('cancels one history waiter without interrupting another waiter or another session first write', async () => {
    const fixture = await coldHistoryHandlerFixture(2);
    const [first, second] = [...fixture.docs.keys()];
    const controller = new AbortController();
    const cancelled = fixture.rpc
      .resolveSessionHistoryOwnerSessionId(first!, { signal: controller.signal })
      .then(
        () => ({ cancelled: false }),
        () => ({ cancelled: true })
      );
    const writes = [first!, second!].map((id, index) =>
      fixture.rpc.writeSessionHistoryForRpc(id, 'append', {
        entry: nativeUser(`isolated-turn-${index}`),
      })
    );
    try {
      await fixture.observing(3);
      controller.abort();
      expect(await cancelled).toEqual({ cancelled: true });
      expect(fixture.observers.size).toBe(2);
      expect([...fixture.docs.values()].every((doc) => doc.handle === null)).toBe(true);
      await Promise.all([first!, second!].map((id) => fixture.ready(id)));
      expect((await Promise.all(writes)).every((response) => response.success)).toBe(true);
      for (const [index, id] of [first!, second!].entries()) {
        const doc = fixture.docs.get(id)!;
        const backend = await createSessionBackend(doc);
        expect(backend.kind).toBe('roost');
        expect((await backend.readHistory()).map((entry) => entry.id)).toEqual([
          `isolated-turn-${index}`,
        ]);
        expect(doc.handle?.doc.getList('history').length).toBe(0);
      }
      expect(fixture.observers.size).toBe(0);
    } finally {
      controller.abort();
      await fixture.close();
    }
  });

  it('retains rejected RPC identity across SQLite reopen, isolates targets, and removes expired refusals', async () => {
    const filename = join(nativeDirectory, `rpc-refusals-${ordinal++}.sqlite3`);
    const request: SessionHistoryRpcRequest = {
      jsonrpc: '2.0',
      id: 'synthetic-rejected-rpc',
      rpcVersion: '1',
      workspaceId: 'synthetic-workspace' as never,
      machineId: 'synthetic-machine' as never,
      replyTo: 'synthetic-reply',
      method: 'session/history-write',
      sentAt: 1,
      expiresAt: 30_001,
      params: await encryptCodeCollabV2RpcPayload('synthetic-session', {
        sessionId: 'synthetic-session',
        operation: 'append',
        payload: { entry: nativeUser('synthetic-private-payload') },
      }),
    };
    const rejection = {
      code: 'session_metadata_pending',
      message: 'Metadata is pending.',
    } as const;
    expect(await Effect.runPromise(getSessionHistoryRpcRejection(filename, request, 1))).toBeNull();
    expect(
      await Effect.runPromise(putSessionHistoryRpcRejection(filename, request, rejection, 1))
    ).toEqual(rejection);
    // Each Effect closes its handle. This lookup uses a different SQLite connection.
    expect(await Effect.runPromise(getSessionHistoryRpcRejection(filename, request, 2))).toEqual(
      rejection
    );
    expect(
      await Effect.runPromise(
        getSessionHistoryRpcRejection(
          filename,
          { ...request, workspaceId: 'another-workspace' as never },
          2
        )
      )
    ).toBeNull();
    expect(
      await Effect.runPromise(
        getSessionHistoryRpcRejection(
          filename,
          { ...request, machineId: 'another-machine' as never },
          2
        )
      )
    ).toBeNull();
    expect(
      await Effect.runPromise(
        getSessionHistoryRpcRejection(filename, { ...request, id: 'fresh-request' }, 2)
      )
    ).toBeNull();
    await expect(
      Effect.runPromise(
        getSessionHistoryRpcRejection(filename, { ...request, replyTo: 'different-reply' }, 2)
      )
    ).rejects.toMatchObject({ code: 'rpc_request_identity_mismatch' });
    const changedParams = await encryptCodeCollabV2RpcPayload('synthetic-session', {
      sessionId: 'synthetic-session',
      operation: 'append',
      payload: { entry: nativeUser('different-turn') },
    });
    await expect(
      Effect.runPromise(
        getSessionHistoryRpcRejection(filename, { ...request, params: changedParams }, 2)
      )
    ).rejects.toMatchObject({ code: 'rpc_request_identity_mismatch' });
    const original = await Effect.runPromise(
      putSessionHistoryRpcRejection(
        filename,
        request,
        { code: 'session_owner_mismatch', message: 'Owner changed later.' },
        3
      )
    );
    expect(original).toEqual(rejection);
    const db = new Database(filename, { readonly: true });
    try {
      const row = db.prepare('SELECT * FROM history_rpc_rejections').get();
      expect(row).toEqual({
        workspace_id: request.workspaceId,
        machine_id: request.machineId,
        request_id: request.id,
        expires_at: request.expiresAt,
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        ...rejection,
      });
    } finally {
      db.close();
    }
    expect(
      await Effect.runPromise(getSessionHistoryRpcRejection(filename, request, request.expiresAt))
    ).toBeNull();
    const next = { ...request, id: 'new-refusal', sentAt: 30_002, expiresAt: 60_002 };
    await Effect.runPromise(putSessionHistoryRpcRejection(filename, next, rejection, 30_002));
    const after = new Database(filename, { readonly: true });
    try {
      expect(after.prepare('SELECT request_id FROM history_rpc_rejections').all()).toEqual([
        { request_id: next.id },
      ]);
    } finally {
      after.close();
    }
  });

  it('fails closed when durable RPC refusal storage is unavailable and preserves the local cause', async () => {
    const blocked = join(nativeDirectory, `blocked-rpc-refusals-${ordinal++}`);
    await writeFile(blocked, 'synthetic path obstruction');
    const request: SessionHistoryRpcRequest = {
      jsonrpc: '2.0',
      id: 'synthetic-request',
      rpcVersion: '1',
      workspaceId: 'synthetic-workspace' as never,
      machineId: 'synthetic-machine' as never,
      replyTo: 'synthetic-reply',
      method: 'session/history-write',
      sentAt: 1,
      expiresAt: 30_001,
      params: await encryptCodeCollabV2RpcPayload('synthetic-session', {
        sessionId: 'synthetic-session',
        operation: 'append',
        payload: {},
      }),
    };
    const error = await Effect.runPromise(
      getSessionHistoryRpcRejection(join(blocked, 'refusals.sqlite3'), request, 1)
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: 'session_history_request_state_unavailable',
      cause: expect.any(Error),
    });
    expect((error as Error).message).not.toContain(blocked);
  });

  it.each(['absent', 'existence-only', 'owner-pending', 'backend-pending'] as const)(
    'accepts the first cold write after %s metadata arrives without opening Loro history',
    async (phase) => {
      const repo = await LoroRepo.create({});
      const sessionId = `metadata-${phase}-${ordinal++}` as SessionId;
      const roomId = getSessionRoomId(sessionId);
      if (phase !== 'absent') {
        await repo.upsertDocMeta(
          roomId,
          phase === 'existence-only'
            ? {}
            : {
                id: sessionId,
                ...(phase === 'owner-pending'
                  ? { historyBackend: 'roost' }
                  : { machineId: 'test-machine' }),
              }
        );
      }
      const doc = new SessionDocument(repo, sessionId, (room) => repo.unloadDoc(room));
      let observed!: () => void;
      const observing = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const observe = repo.observeDocs.bind(repo);
      const observers = new Set<object>();
      vi.spyOn(repo, 'observeDocs').mockImplementation((listener, options) => {
        const subscription = observe(listener, options);
        observers.add(subscription);
        observed();
        return {
          ...subscription,
          unsubscribe: () => {
            subscription.unsubscribe();
            observers.delete(subscription);
          },
        };
      });
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
          getOrCreateSessionDoc: async () => {
            if (!doc.handle) {
              doc.handle = await repo.openPersistedDoc(roomId);
              // Resolve from metadata, like a cold production SessionDocument.
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
          machineId: 'test-machine',
          workspaceId: 'test-workspace' as never,
          token: 'synthetic-token',
          userId: 'test-user',
          machineName: 'synthetic',
          cliVersion: '0.0.0',
          cloudPort: createTestCloudPort(),
        }
      );
      const rpc = handler as unknown as {
        writeSessionHistoryForRpc(
          id: SessionId,
          operation: 'append',
          payload: Record<string, unknown>
        ): Promise<SessionHistoryWriteResponse>;
      };
      try {
        const write = rpc.writeSessionHistoryForRpc(sessionId, 'append', {
          entry: nativeUser('first-turn'),
        });
        await Promise.race([
          observing,
          write.then(() => {
            throw new Error('History request completed before metadata was ready');
          }),
        ]);
        expect(doc.handle).toBeNull();
        await repo.upsertDocMeta(roomId, {
          id: sessionId,
          machineId: 'test-machine',
          historyBackend: 'roost',
          userId: 'test-user',
          status: SessionStatusFactory.idle(),
        });
        const response = SessionHistoryWriteResponseSchema.parse(await write);
        expect(response.success).toBe(true);
        const backend = await createSessionBackend(doc);
        expect(backend.kind).toBe('roost');
        expect((await backend.readHistory()).map((entry) => entry.id)).toEqual(['first-turn']);
        expect(doc.handle?.doc.getList('history').length).toBe(0);
        expect(observers.size).toBe(0);
      } finally {
        await handler.cleanup();
        if (doc.handle) await doc.destroy({ preserveStatus: true });
        await repo.destroy();
      }
    }
  );

  effectIt.effect.each([
    'foreign',
    'deleted',
    'purged',
    'identity',
    'backend',
    'timeout',
    'cancelled',
  ] as const)('refuses %s metadata without leaving a live observer', (scenario) =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => LoroRepo.create({}));
      yield* Effect.addFinalizer(() => Effect.promise(() => repo.destroy()));
      const sessionId = `metadata-refusal-${scenario}` as SessionId;
      const roomId = getSessionRoomId(sessionId);
      yield* Effect.promise(() =>
        repo.upsertDocMeta(roomId, { id: sessionId, historyBackend: 'roost' })
      );
      let subscribed!: () => void;
      const observing = new Promise<void>((resolve) => {
        subscribed = resolve;
      });
      const observe = repo.observeDocs.bind(repo);
      const observers = new Set<object>();
      vi.spyOn(repo, 'observeDocs').mockImplementation((listener, options) => {
        const subscription = observe(listener, options);
        observers.add(subscription);
        subscribed();
        return {
          ...subscription,
          unsubscribe: () => {
            subscription.unsubscribe();
            observers.delete(subscription);
          },
        };
      });
      const request = yield* Effect.forkChild(
        awaitSessionHistoryOwner(repo, sessionId, 'test-machine')
      );
      yield* Effect.promise(() => observing);
      if (scenario === 'foreign')
        yield* Effect.promise(() => repo.upsertDocMeta(roomId, { machineId: 'foreign-machine' }));
      if (scenario === 'deleted') yield* Effect.promise(() => repo.deleteDoc(roomId));
      if (scenario === 'purged') yield* Effect.promise(() => repo.purgeDoc(roomId));
      if (scenario === 'identity')
        yield* Effect.promise(() =>
          repo.upsertDocMeta(roomId, { id: 'invalid-session', machineId: 'test-machine' })
        );
      if (scenario === 'backend')
        yield* Effect.promise(() =>
          repo.upsertDocMeta(roomId, { machineId: 'test-machine', historyBackend: 'loro' })
        );
      if (scenario === 'timeout') yield* TestClock.adjust(SESSION_HISTORY_METADATA_TIMEOUT_MS);
      if (scenario === 'cancelled') yield* Fiber.interrupt(request);
      const outcome = yield* Fiber.await(request);
      expect(Exit.isFailure(outcome)).toBe(true);
      const code = {
        foreign: 'session_owner_mismatch',
        deleted: 'session_unavailable',
        purged: 'session_unavailable',
        identity: 'session_identity_mismatch',
        backend: 'session_backend_mismatch',
        timeout: 'session_metadata_pending',
      };
      if (scenario !== 'cancelled' && Exit.isFailure(outcome))
        expect(Cause.squash(outcome.cause)).toMatchObject({ code: code[scenario] });
      expect(observers.size).toBe(0);
      expect(
        (yield* Effect.promise(() => repo.openPersistedDoc(roomId))).doc.getList('history').length
      ).toBe(0);
    })
  );

  it('distinguishes history initialization failure without changing the selected backend', async () => {
    const workerFailure = new RoostHostError('workerFailed');
    workerFailure.cause = new Error('synthetic bootstrap Worker failure');
    const request = vi.spyOn(RoostNativeClient.prototype, 'request');
    request.mockRejectedValueOnce(workerFailure);
    const failure = await nativeFixture().catch((error: unknown) => error);
    expect(failure).toBe(workerFailure);
    const detail = describeRoostHistoryFailure(failure, { stage: 'write' });
    expect(detail).toContain('initialize failed (code=workerFailed; diagnostic=');
    expect(detail).not.toContain('synthetic bootstrap Worker failure');
    request.mockRestore();
    const healthy = await nativeFixture();
    expect(healthy.backend.kind).toBe('roost');
    expect((await healthy.doc.getMetaState())?.historyBackend).toBe('roost');
  });

  it.each(['read', 'write'] as const)(
    'returns a safe diagnostic through the real history %s RPC',
    async (kind) => {
      const fixture = await nativeFixture();
      await fixture.backend.appendHistoryTurn(nativeUser('rpc-retained-user'));
      const workerFailure = new RoostHostError('workerFailed');
      workerFailure.cause = new Error('synthetic private Worker path');
      const request = vi.spyOn(RoostNativeClient.prototype, 'request');
      request.mockRejectedValueOnce(workerFailure);
      const noop = () => undefined;
      const handler = new MessageHandler(
        {
          on: noop,
          setRequestPermissionHandler: noop,
          getSession: () => undefined,
          cleanUp: async () => undefined,
        } as never,
        {
          repo: fixture.repo,
          getOrCreateSessionDoc: async () => fixture.doc,
          isTransportConnected: () => false,
          markMachineFlockDocDirty: noop,
          publishSessionPresence: noop,
          clearSessionPresence: noop,
          sendMachineHeartbeat: async () => undefined,
        } as never,
        getDefaultLogger(),
        {
          machineId: 'test-machine',
          workspaceId: 'test-workspace' as never,
          token: 'synthetic-token',
          userId: 'test-user',
          machineName: 'synthetic',
          cliVersion: '0.0.0',
          cloudPort: createTestCloudPort(),
        }
      );
      const rpc = handler as unknown as {
        readSessionHistoryForRpc(
          sessionId: SessionId,
          query: { kind: 'readAll' }
        ): Promise<SessionHistoryReadResponse>;
        writeSessionHistoryForRpc(
          sessionId: SessionId,
          operation: 'append',
          payload: Record<string, unknown>
        ): Promise<SessionHistoryWriteResponse>;
      };
      const response =
        kind === 'read'
          ? await rpc.readSessionHistoryForRpc(fixture.doc.sessionId, { kind: 'readAll' })
          : await rpc.writeSessionHistoryForRpc(fixture.doc.sessionId, 'append', {
              entry: nativeUser('rpc-failed-user'),
            });
      const parsed =
        kind === 'read'
          ? SessionHistoryReadResponseSchema.parse(response)
          : SessionHistoryWriteResponseSchema.parse(response);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('code=workerFailed; diagnostic=');
      expect(JSON.stringify(parsed)).not.toContain('synthetic private Worker path');
      request.mockRestore();
      expect((await fixture.doc.getMetaState())?.historyBackend).toBe('roost');
      expect((await fixture.backend.readHistory()).map((turn) => turn.id)).toEqual([
        'rpc-retained-user',
      ]);
      expect(fixture.doc.handle?.doc.getList('history').length).toBe(0);
      await handler.cleanup();
    }
  );

  it('reports a failed native write without switching backend or writing Loro history', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('retained-user'));
    const workerFailure = new RoostHostError('workerFailed');
    workerFailure.cause = new Error('synthetic private loader detail');
    const request = vi.spyOn(RoostNativeClient.prototype, 'request');
    request.mockRejectedValueOnce(workerFailure);
    const failure = await fixture.backend
      .appendHistoryTurn(nativeUser('failed-user'))
      .catch((error: unknown) => error);
    expect(failure).toBe(workerFailure);
    const detail = describeRoostHistoryFailure(failure, {
      stage: 'write',
      sessionId: fixture.doc.sessionId,
    });
    expect(detail).toContain('write failed (code=workerFailed; diagnostic=');
    expect(detail).not.toContain('synthetic private loader detail');
    request.mockRestore();
    expect(fixture.backend.kind).toBe('roost');
    expect((await fixture.doc.getMetaState())?.historyBackend).toBe('roost');
    expect((await fixture.backend.readHistory()).map((turn) => turn.id)).toEqual(['retained-user']);
    expect(fixture.doc.handle?.doc.getList('history').length).toBe(0);
  });

  it('serves different members and devices through owner RPC and preserves access failures', async () => {
    const owner = await nativeFixture();
    await owner.backend.appendHistoryTurn(nativeUser('remote-u'));
    await owner.repo.upsertDocMeta(getMachineRoomId('test-machine'), {
      id: 'test-machine',
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    });
    let denied = false;
    const remoteClient = async (auth: AuthContext) => {
      const factory = createCommandSessionHistoryFactory(
        () => ({ repo: owner.repo, waitUntilMetaSynced: async () => true }) as LoroDocumentManager,
        auth,
        'test-workspace',
        async (target, run) => {
          expect(target.machineId).toBe('test-machine');
          expect(target.auth).toBe(auth);
          if (denied) throw new Error('Owner access refused');
          return run({
            requestSessionHistoryRead: async (request: {
              sessionId: string;
              ownerSessionId: string;
            }) => {
              expect(request.sessionId).toBe(owner.doc.sessionId);
              expect(request.ownerSessionId).toBe(owner.doc.sessionId);
              return {
                type: 'session/history-read_response',
                sessionId: owner.doc.sessionId,
                success: true,
                result: await owner.backend.readHistory(),
              };
            },
            requestSessionHistoryWrite: async (request: {
              sessionId: string;
              ownerSessionId: string;
              operation: string;
              payload: { entry: SessionHistoryInput };
            }) => {
              expect(request.ownerSessionId).toBe(owner.doc.sessionId);
              if (request.operation !== 'append') throw new Error('Unsupported test operation');
              await owner.backend.appendHistoryTurn(request.payload.entry);
              return {
                type: 'session/history-write_response',
                sessionId: owner.doc.sessionId,
                operation: request.operation,
                success: true,
                historyCount: await owner.backend.history.count(),
              };
            },
          } as never);
        }
      );
      return nativeFixture(owner.doc.sessionId, false, factory);
    };
    const devices = [
      { userId: 'member-a', machineId: 'device-a1', token: 'synthetic-a1' },
      { userId: 'member-b', machineId: 'device-b1', token: 'synthetic-b1' },
      { userId: 'member-a', machineId: 'device-a2', token: 'synthetic-a2' },
    ] as AuthContext[];
    const clients = await Promise.all(devices.map(remoteClient));
    for (const client of clients)
      expect(await client.backend.readHistory()).toMatchObject([{ id: 'remote-u' }]);
    await Promise.all(
      clients.map((client, index) => {
        const device = devices[index];
        if (!device) throw new Error('Synthetic client has no device context');
        const userId = device.userId;
        return client.backend.appendHistoryTurn({
          ...nativeUser(`remote-added-${index}`),
          userId,
          author: { v: 1, kind: 'human', userId },
        });
      })
    );
    const before = await owner.backend.readHistory();
    expect(before.map(({ id, userId, author }) => ({ id, userId, author }))).toEqual([
      { id: 'remote-u', userId: 'test-user', author: undefined },
      ...devices.map(({ userId }, index) => ({
        id: `remote-added-${index}`,
        userId,
        author: { v: 1, kind: 'human', userId },
      })),
    ]);
    for (const client of clients) expect(await client.backend.readHistory()).toEqual(before);
    denied = true;
    for (const client of clients) {
      await expect(client.backend.readHistory()).rejects.toThrow('Owner access refused');
      await expect(client.backend.appendHistoryTurn(nativeUser('refused-input'))).rejects.toThrow(
        'Owner access refused'
      );
    }
    expect(await owner.backend.readHistory()).toEqual(before);
  });

  it('routes daemon history by Session owner: another machine through RPC, its own locally', async () => {
    const owned = await nativeFixture();
    await owned.backend.appendHistoryTurn(nativeUser('owned-u'));
    await owned.repo.upsertDocMeta(getMachineRoomId('test-machine'), {
      id: 'test-machine',
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    });
    const refusedOwner = createCommandSessionHistoryFactory(
      () => ({ repo: owned.repo, waitUntilMetaSynced: async () => true }) as LoroDocumentManager,
      { userId: 'test-user', machineId: 'daemon-machine', token: 'synthetic' } as AuthContext,
      'test-workspace',
      async (target) => {
        throw new Error(`Owner route reached ${target.machineId}`);
      }
    );
    // This daemon is the Session's machine: history stays with its local owner.
    const local = await nativeFixture(
      owned.doc.sessionId,
      false,
      routeRemoteOwnedSessionHistory('test-machine', refusedOwner)
    );
    expect(await local.backend.readHistory()).toMatchObject([{ id: 'owned-u' }]);
    // Another machine owns the Session: a daemon never serves it from its own database.
    const foreign = await nativeFixture(
      `${owned.doc.sessionId}-foreign`,
      false,
      routeRemoteOwnedSessionHistory('daemon-machine', refusedOwner)
    );
    await expect(foreign.backend.readHistory()).rejects.toThrow('Owner route reached test-machine');
    await expect(foreign.backend.appendHistoryTurn(nativeUser('foreign-u'))).rejects.toThrow(
      'Owner route reached test-machine'
    );
    expect(await owned.backend.readHistory()).toMatchObject([{ id: 'owned-u' }]);
  });

  it('binds real owner RPC bodies to checkpoints and treats supersession as retryable', async () => {
    const fixture = await coldHistoryHandlerFixture(1);
    const id = [...fixture.docs.keys()][0];
    if (!id) throw new Error('Missing fixture session');
    try {
      await fixture.ready(id);
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(id, 'append', {
          entry: nativeUser('rpc-first'),
        })
      ).toMatchObject({ success: true });
      const page = await fixture.rpc.readSessionHistoryForRpc(id, {
        kind: 'readLatestPage',
        limit: 40,
        withCheckpoint: true,
      });
      expect(page.success).toBe(true);
      const checkpoint = (page.result as { checkpoint?: string }).checkpoint;
      if (!checkpoint) throw new Error('Missing owner checkpoint');
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(id, 'apply_action', {
          action: { kind: 'user-status', turnId: 'rpc-first', status: 'seen' },
        })
      ).toMatchObject({ success: true });
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(id, 'append', { entry: nativeUser('rpc-next') })
      ).toMatchObject({ success: true });
      const response = await fixture.rpc.readSessionHistoryForRpc(id, {
        kind: 'readChanges',
        checkpoint,
        includeBodiesFrom: 0,
      });
      expect(response.success).toBe(true);
      const changes = SessionHistoryChangesSchema.parse(response.result);
      expect(changes.state).toBe('ready');
      expect(changes).toMatchObject({
        bodies: {
          changed: [{ id: 'rpc-first', status: 'seen' }],
          from: 1,
          suffix: [{ id: 'rpc-next' }],
        },
      });
      const superseded = await fixture.rpc.readSessionHistoryForRpc(id, {
        kind: 'readTurn',
        turnId: 'rpc-first',
        atCheckpoint: checkpoint,
      });
      expect(SessionHistoryReadResponseSchema.parse(superseded)).toMatchObject({
        success: false,
        retryReason: 'superseded',
      });
      const body = await fixture.rpc.readSessionHistoryForRpc(id, {
        kind: 'readTurn',
        turnId: 'rpc-next',
        atCheckpoint: changes.checkpoint,
      });
      expect(body).toMatchObject({
        success: true,
        result: { state: 'ready', turn: { id: 'rpc-next' } },
      });
    } finally {
      await fixture.close();
    }
  });

  it('preserves Unicode scalar edits and list changes through sealing and state correction', async () => {
    const fixture = await nativeFixture();
    const turn = {
      ...nativeAssistant('delta-unicode'),
      items: [
        { type: 'text' as const, text: 'a🙂bc🚀d' },
        { type: 'text' as const, text: 'unchanged' },
        { type: 'text' as const, text: 'removed' },
      ],
    };
    await fixture.backend.appendHistoryTurn(turn);
    let items = [{ type: 'text' as const, text: 'a🙂XYZ🚀d' }, turn.items[1]!];
    await fixture.backend.applyHistoryAction({
      kind: 'assistant-items',
      turnId: turn.id,
      mode: 'replace',
      items,
    });
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items },
    });
    items = [...items, { type: 'text' as const, text: 'added' }];
    await fixture.backend.applyHistoryAction({
      kind: 'assistant-items',
      turnId: turn.id,
      mode: 'replace',
      items,
    });
    await fixture.backend.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: turn.id,
      endedAt: 42,
    });
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items, finished: true, endedAt: 42 },
    });
    // A sealed primary's first correction still uses its SDK state contract;
    // subsequent state edits can use the same atomic delta path.
    for (const text of ['state 🙂 text', 'state 😀 text']) {
      items = [{ type: 'text' as const, text }, turn.items[1]!];
      await fixture.backend.applyHistoryAction({
        kind: 'assistant-items',
        turnId: turn.id,
        mode: 'replace',
        items,
      });
      expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
        state: 'ready',
        turn: { items, finished: true },
      });
    }
    await fixture.backend.flushLocalWrites();
    const id = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(id);
    expect(await reopened.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items, finished: true, endedAt: 42 },
    });
  });

  it('observes owner checkpoints without holding the writer and closes waits on cancellation', async () => {
    const fixture = await nativeFixture();
    const history = fixture.backend.history;
    if (!history.getCheckpoint || !history.waitForChanges)
      throw new Error('Expected checkpoint watch');
    const checkpoint = await history.getCheckpoint();
    const original = history.getCheckpoint;
    let armed = Promise.withResolvers<void>();
    vi.spyOn(history, 'getCheckpoint').mockImplementation(async () => {
      const value = await original();
      armed.resolve();
      return value;
    });
    vi.useFakeTimers();
    const observed = history.waitForChanges(checkpoint, 15_000);
    await armed.promise;
    await fixture.backend.appendHistoryTurn(nativeUser('watched-owner-write'));
    await observed;
    const next = await original();
    expect(next).not.toBe(checkpoint);
    // The durable checkpoint covers a write between the initial read and watch admission.
    await history.waitForChanges(checkpoint, 15_000);
    expect(await history.readTurn('watched-owner-write')).toMatchObject({ state: 'ready' });
    armed = Promise.withResolvers<void>();
    const deadline = history.waitForChanges(next, 15_000);
    await armed.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await deadline;
    armed = Promise.withResolvers<void>();
    const abort = new AbortController();
    const cancelled = history.waitForChanges(next, 15_000, abort.signal).catch((error) => error);
    await armed.promise;
    abort.abort();
    expect(await cancelled).toBeInstanceOf(Error);
    // An aborted viewer does not retire the shared writer or checkpoint reader.
    await fixture.backend.appendHistoryTurn(nativeUser('after-observer-abort'));
    expect(await history.readTurn('after-observer-abort')).toMatchObject({ state: 'ready' });
    const atClose = await original();
    armed = Promise.withResolvers<void>();
    const closing = history.waitForChanges(atClose, 15_000).catch((error) => error);
    await armed.promise;
    await fixture.close();
    expect(await closing).toBeInstanceOf(Error);
  });

  it('recovers missed logical edits and appends from an owner-issued checkpoint', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('catchup-user'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('catchup-assistant'));
    const history = fixture.backend.history;
    if (!history.getCheckpoint || !history.readChanges)
      throw new Error('Expected incremental owner');
    const checkpoint = await history.getCheckpoint();
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'catchup-user',
      status: 'seen',
    });
    await fixture.backend.appendHistoryTurn(nativeUser('catchup-next'));
    await fixture.backend.flushLocalWrites();
    const changes = await history.readChanges(checkpoint);
    expect(changes).toMatchObject({ state: 'ready', from: 2 });
    if (changes.state !== 'ready') throw new Error('Expected complete recovery');
    expect(changes.ids).toContain('catchup-user');
    expect(await history.readTurn('catchup-user')).toMatchObject({
      state: 'ready',
      turn: { status: 'seen' },
    });
    expect(await history.readAt(2)).toMatchObject({ state: 'ready', turn: { id: 'catchup-next' } });
    expect(await history.readChanges(changes.checkpoint)).toMatchObject({
      state: 'ready',
      ids: [],
    });
    expect(await history.readChanges('synthetic-foreign-checkpoint')).toMatchObject({
      state: 'reset',
    });
  });

  it('publishes logical corrections to observers and keeps streaming reads bounded', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('observed-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('observed-a'));
    const changes: unknown[] = [];
    const observation = fixture.backend.history.observe((change) => changes.push(change));
    await observation.initial;
    const full = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
      .mockRejectedValue(new Error('Full hydration is forbidden'));
    const page = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage')
      .mockRejectedValue(new Error('Streaming branch reload is forbidden'));
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'observed-u',
      status: 'seen',
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'observed-a',
      contents: [{ type: 'text', text: 'bounded output' }],
      operationIds: ['bounded-output'],
    });
    expect(await fixture.backend.readTurn('observed-a')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'bounded output' }] },
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: 'changed', ids: ['observed-u'] },
        { kind: 'changed', ids: ['observed-a'] },
      ])
    );
    observation.unsubscribe();
    const observed = [...changes];
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'observed-u',
      status: 'processing',
    });
    expect(changes).toEqual(observed);
    full.mockRestore();
    page.mockRestore();
  });

  it('allows concurrent readers to follow an atomic generation and fences the old writer', async () => {
    const seed = new Uint8Array(32).fill(39);
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'generation.db'),
      seed,
      allowedOwners: [owner],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    try {
      await client.ready;
      const writer = new RoostHistoryGeneration(client, owner, 'generation-race');
      const reader = new RoostHistoryGeneration(client, owner, 'generation-race');
      const old = reader.history;
      await writer.replace([nativeUser('generation-u')], 'generation-replace');
      await Promise.all([reader.resolve(), reader.resolve(), reader.resolve()]);
      expect(
        (await reader.history.readActiveBranch('generation-race')).messages.map(
          (row) => row.businessId
        )
      ).toEqual(['generation-u']);
      await expect(
        old.acceptToView({
          viewId: 'generation-race',
          expectedRevision: 0n,
          expectedHead: null,
          operationId: 'old-writer',
          input: {
            kind: 'message',
            businessId: 'stale-u',
            segmentId: 'primary',
            parents: [],
            content: encodeRoostContent(nativeUser('stale-u')),
          },
        })
      ).rejects.toMatchObject({ code: 'stale' });
      const cursor = await reader.history.observedEventCursor();
      await reader.history.accept({
        kind: 'publication',
        businessId: 'generation-race',
        segmentId: 'newer',
        parents: [],
        content: encodeRoostContent(null),
      });
      await expect(reader.replace([], 'stale-generation', cursor)).rejects.toMatchObject({
        code: 'stale',
      });
      expect(
        (await reader.history.readActiveBranch('generation-race')).messages.map(
          (row) => row.businessId
        )
      ).toEqual(['generation-u']);
    } finally {
      await client.close();
    }
  });

  it('copies opaque stored values into an empty target without validating them as newly authored items', async () => {
    const id = `opaque-${ordinal++}` as SessionId;
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'history.db'),
      seed,
      allowedOwners: [owner],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    const opaque = {
      ...nativeUser('opaque-u'),
      extension: { version: 2 },
      items: [{ type: 'future_item', opaque: ['unchanged'] }],
    };
    try {
      await client.ready;
      await new RoostHistoryGeneration(client, owner, id).replace([opaque as never], 'stored-seed');
    } finally {
      await client.close();
    }
    const source = await nativeFixture(id);
    const target = await nativeFixture();
    const snapshot = await source.backend.captureForkSnapshot();
    await source.close();
    await target.backend.importForkHistory(snapshot, snapshot.history);
    expect(await target.backend.readHistory()).toEqual([opaque]);
    await target.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'opaque-u',
      status: 'seen',
    });
    expect(await target.backend.readHistory()).toMatchObject([
      { extension: opaque.extension, items: opaque.items, status: 'seen' },
    ]);
  });

  it('republishes a committed history correction after its control cursor write fails', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('cursor-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('cursor-a'));
    const before = await fixture.doc.getRoostHistoryCursor();
    const spy = vi
      .spyOn(fixture.doc, 'setRoostHistoryCursor')
      .mockRejectedValueOnce(new Error('Injected cursor failure'));
    await expect(
      fixture.backend.applyHistoryAction({
        kind: 'user-status',
        turnId: 'cursor-u',
        status: 'seen',
      })
    ).rejects.toThrow('Injected cursor failure');
    spy.mockRestore();
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'cursor-u',
      status: 'seen',
    });
    expect(await fixture.backend.readTurn('cursor-u')).toMatchObject({
      state: 'ready',
      turn: { status: 'seen' },
    });
    expect((await fixture.doc.getRoostHistoryCursor())?.historyRevision).toBeGreaterThan(
      before!.historyRevision!
    );
  });

  it('restores only the owned editable tail while retaining later appends and refuses concurrent edits', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('editable-u'));
    const result = await fixture.backend.replaceEditableTail({
      expectedUserTurnId: 'editable-u',
      expectedForkTurnId: undefined,
      replacement: nativeUser('replacement-u') as never,
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('Expected editable tail');
    await fixture.backend.appendHistoryTurn(nativeAssistant('later-a'));
    await result.rollback();
    expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'editable-u',
      'later-a',
    ]);
    const conflict = await nativeFixture();
    await conflict.backend.appendHistoryTurn(nativeUser('conflict-u'));
    const conflicting = await conflict.backend.replaceEditableTail({
      expectedUserTurnId: 'conflict-u',
      expectedForkTurnId: undefined,
      replacement: nativeUser('changed-u') as never,
    });
    if (conflicting.status !== 'accepted') throw new Error('Expected editable tail');
    await conflict.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: { ...nativeUser('changed-u'), items: [{ type: 'text', text: 'peer edit' }] } as never,
    });
    await expect(conflicting.rollback()).rejects.toThrow('rollback_conflict');
    expect(await conflict.backend.readTurn('changed-u')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'peer edit' }] },
    });
    const reused = await nativeFixture();
    await reused.backend.appendHistoryTurn(nativeUser('reused-u'));
    await reused.backend.appendHistoryTurn(nativeAssistant('reused-a'));
    const replaced = await reused.backend.replaceEditableTail({
      expectedUserTurnId: 'reused-u',
      expectedForkTurnId: undefined,
      replacement: nativeUser('reused-replacement') as never,
    });
    expect(replaced.status).toBe('accepted');
    await reused.backend.appendHistoryTurn({
      ...nativeAssistant('reused-a'),
      items: [{ type: 'text', text: 'new use of removed identity' }],
    });
    expect((await reused.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'reused-replacement',
      'reused-a',
    ]);
    expect(await reused.backend.readTurn('reused-a')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'new use of removed identity' }] },
    });
  });

  it('rejects an edit for an older active goal and rebuilds an invalid derived cache', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('goal-first-u'));
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('goal-first-a'),
      finished: true,
      acpTurnId: 'goal-boundary',
      items: [{ type: 'goal', threadId: 'old-goal', objective: 'Keep working', status: 'active' }],
    });
    await fixture.backend.appendHistoryTurn(nativeUser('goal-tail-u'));
    for (let index = 0; index < 43; index += 1)
      await fixture.backend.appendHistoryTurn({
        ...nativeAssistant(`goal-tail-${index}`),
        finished: true,
      });
    const input = {
      expectedUserTurnId: 'goal-tail-u',
      expectedForkTurnId: 'goal-boundary',
      replacement: nativeUser('goal-replacement') as never,
    };
    const before = await fixture.backend.readHistory();
    const full = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
      .mockRejectedValue(new Error('Cached guard must not scan'));
    try {
      expect(await fixture.backend.replaceEditableTail(input)).toEqual({
        status: 'rejected',
        reason: { code: 'active_goal' },
      });
    } finally {
      full.mockRestore();
    }
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
      await client.stream(`lody-session:${fixture.doc.sessionId}`).writeBatch([], {
        indexPuts: [
          {
            table: 'lody_goal_projection_v1',
            key: new Uint8Array(),
            value: new TextEncoder().encode('{invalid'),
          },
        ],
      });
      expect(await fixture.backend.replaceEditableTail(input)).toEqual({
        status: 'rejected',
        reason: { code: 'active_goal' },
      });
      expect(await fixture.backend.readHistory()).toEqual(before);
    } finally {
      await client.close();
    }
  });

  it('does not advance a goal cache across a concurrent owner write', async () => {
    const first = await nativeFixture();
    await first.backend.appendHistoryTurn(nativeUser('concurrent-goal-u'));
    await first.backend.appendHistoryTurn({
      ...nativeAssistant('concurrent-goal-a'),
      finished: true,
      acpTurnId: 'concurrent-boundary',
    });
    await first.backend.appendHistoryTurn(nativeUser('concurrent-tail-u'));
    const peer = await nativeFixture(first.doc.sessionId);
    const original = RoostHistoryGeneration.prototype.commitPatches;
    let injected = false;
    const spy = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementation(async function (...args) {
        const result = await original.apply(this, args);
        if (!injected) {
          injected = true;
          await peer.backend.applyHistoryAction({
            kind: 'upsert-turn',
            turn: {
              ...nativeAssistant('concurrent-goal-a'),
              finished: true,
              acpTurnId: 'concurrent-boundary',
              items: [
                {
                  type: 'goal',
                  threadId: 'concurrent-goal',
                  objective: 'Do not discard',
                  status: 'active',
                },
              ],
            } as never,
          });
        }
        return result;
      });
    try {
      await first.backend.applyHistoryAction({
        kind: 'user-status',
        turnId: 'concurrent-tail-u',
        status: 'handled',
      });
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(
      await first.backend.replaceEditableTail({
        expectedUserTurnId: 'concurrent-tail-u',
        expectedForkTurnId: 'concurrent-boundary',
        replacement: nativeUser('concurrent-replacement') as never,
      })
    ).toEqual({ status: 'rejected', reason: { code: 'active_goal' } });
    expect((await first.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'concurrent-goal-u',
      'concurrent-goal-a',
      'concurrent-tail-u',
    ]);
  });

  it('refreshes the same-session prefix edit after its committed activation loses the reply', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('lost-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('lost-a'));
    const original = RoostHistoryGeneration.prototype.fork;
    const spy = vi
      .spyOn(RoostHistoryGeneration.prototype, 'fork')
      .mockImplementationOnce(async function (...args) {
        await original.apply(this, args);
        throw new Error('Injected lost branch reply');
      });
    let result: Awaited<ReturnType<typeof fixture.backend.replaceEditableTail>>;
    try {
      result = await fixture.backend.replaceEditableTail({
        expectedUserTurnId: 'lost-u',
        expectedForkTurnId: undefined,
        replacement: nativeUser('lost-replacement') as never,
      });
    } finally {
      spy.mockRestore();
    }
    expect(result.status).toBe('indeterminate');
    expect(await fixture.backend.history.count()).toBe(1);
    expect(await fixture.backend.history.readAt(0)).toMatchObject({
      state: 'ready',
      turn: { id: 'lost-replacement' },
    });
    await fixture.backend.flushLocalWrites();
    expect(await fixture.doc.getRoostHistoryCursor()).toMatchObject({ historyCount: 1 });
    expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'lost-replacement',
    ]);
  });

  it('keeps an import baseline with its native commit when the Loro cursor projection fails', async () => {
    const fixture = await nativeFixture();
    const entry = { ...nativeUser('import-u'), status: 'handled' as const, read: true };
    const hashes = [hashHistoryEntryForVersion(entry as never, 2)];
    const input: HistoryImportInput = {
      mode: 'initialize',
      replay: {
        history: [entry as never],
        turnHashes: hashes,
        replayDigest: hashText(hashes.join('\n')),
        hashVersion: 2,
        droppedNotifications: 0,
      },
    };
    const spy = vi
      .spyOn(fixture.doc, 'setExternalHistoryCursor')
      .mockRejectedValueOnce(new Error('Injected import cursor failure'));
    expect(await fixture.backend.applyHistoryImport(input)).toMatchObject({
      status: 'indeterminate',
    });
    spy.mockRestore();
    await fixture.close();
    const reopened = await nativeFixture(fixture.doc.sessionId);
    expect(
      await reopened.backend.applyHistoryImport({
        ...input,
        mode: 'refresh',
        externalHistory: {
          importedTurnCount: 1,
          importedTurnHashes: hashes,
          replayDigest: input.replay.replayDigest,
          hashVersion: 2,
        },
      })
    ).toMatchObject({ status: 'accepted', appended: 0 });
    expect(await reopened.backend.readHistory()).toMatchObject([{ id: 'import-u' }]);
    expect((await reopened.doc.getExternalHistoryCursor())?.importedTurnHashes).toEqual(hashes);
  });

  it('continues a permission-bearing assistant with sparse tool updates and text', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('live-permission-a'),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'live-tool',
          status: 'pending',
          permissionRequest: {
            requestId: 'live-request',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        },
      ],
    });
    expect(
      await fixture.backend.respondPermission('live-request', {
        outcome: 'selected',
        optionId: 'allow',
      })
    ).toBe(true);
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'live-permission-a',
      notifications: [
        {
          sessionId: 'acp-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'live-tool',
            status: 'completed',
          },
        },
        {
          sessionId: 'acp-test',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'continued after approval' },
          },
        },
      ],
      operationIds: ['permission-tool-update', 'permission-text-update'],
    });
    expect(await fixture.backend.readTurn('live-permission-a')).toMatchObject({
      state: 'ready',
      turn: {
        finished: false,
        items: [
          {
            status: 'completed',
            permissionRequest: { outcome: { outcome: 'selected', optionId: 'allow' } },
          },
          { text: 'continued after approval' },
        ],
      },
    });
    await fixture.close();
    expect(
      await (await nativeFixture(fixture.doc.sessionId)).backend.readTurn('live-permission-a')
    ).toMatchObject({
      state: 'ready',
      turn: {
        items: [
          { permissionRequest: { outcome: { optionId: 'allow' } } },
          { text: 'continued after approval' },
        ],
      },
    });
  });

  it('keeps a sealed user status correction separate from ongoing assistant output, including reopen', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('a'));
    await fixture.backend.applyHistoryAction({ kind: 'user-status', turnId: 'u', status: 'seen' });
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'u',
      status: 'processing',
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'a',
      contents: [{ type: 'text', text: 'continued' }],
      operationIds: ['status-output'],
    });
    expect(await fixture.backend.readHistory()).toMatchObject([
      { id: 'u', status: 'processing' },
      { id: 'a', items: [{ type: 'text', text: 'continued' }], finished: false },
    ]);
    await fixture.close();
    const reopened = await nativeFixture(fixture.doc.sessionId);
    expect(await reopened.backend.readHistory()).toMatchObject([
      { id: 'u', status: 'processing' },
      { id: 'a', items: [{ type: 'text', text: 'continued' }] },
    ]);
  });

  it('answers an older permission by request id and continues the current assistant', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('permission-a'),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'tool',
          status: 'pending',
          permissionRequest: {
            requestId: 'native-request',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        },
      ],
    });
    await fixture.backend.appendHistoryTurn(nativeAssistant('current-a'));
    expect(
      await fixture.backend.respondPermission('native-request', {
        outcome: 'selected',
        optionId: 'allow',
      })
    ).toBe(true);
    expect(
      await fixture.backend.respondPermission('native-request', {
        outcome: 'selected',
        optionId: 'allow',
      })
    ).toBe(false);
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'current-a',
      contents: [{ type: 'text', text: 'current output' }],
      operationIds: ['permission-current-output'],
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'permission-a',
      contents: [{ type: 'text', text: 'tool finished' }],
      operationIds: ['permission-late-output'],
    });
    expect(await fixture.backend.readTurn('permission-a')).toMatchObject({
      state: 'ready',
      turn: {
        items: [
          { permissionRequest: { outcome: { outcome: 'selected', optionId: 'allow' } } },
          { type: 'text', text: 'tool finished' },
        ],
      },
    });
    expect(await fixture.backend.readTurn('current-a')).toMatchObject({
      state: 'ready',
      turn: { finished: false, items: [{ text: 'current output' }] },
    });
  });

  it('copies a held source snapshot with a new Fork notice before target initialization', async () => {
    const source = await nativeFixture();
    const target = await nativeFixture();
    await source.backend.appendHistoryTurn(nativeUser('fork-u'));
    await target.backend.appendHistoryTurn({ ...nativeAssistant('target-init'), role: 'system' });
    const snapshot = await source.backend.captureForkSnapshot();
    await source.close();
    snapshot.history[0]!.items![0] = { type: 'text', text: 'authored copy' };
    await target.backend.importForkHistory(snapshot, [
      ...snapshot.history,
      {
        id: 'fork-origin',
        role: 'system',
        timestamp: '2026-10-09T00:00:00.000Z',
        items: [
          {
            type: 'system_notice',
            name: 'session_fork_origin',
            meta: {
              sourceSessionId: source.doc.sessionId,
              sourceTurnId: 'fork-u',
              sourceTitle: 'Source session',
            },
          },
        ],
        fileDiff: [],
      },
    ]);
    expect((await target.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'fork-u',
      'fork-origin',
      'target-init',
    ]);
    await expect(target.backend.importForkHistory(snapshot, snapshot.history)).rejects.toThrow(
      'copy_target_conflict'
    );
    await expect(
      target.backend.importForkHistory({ ...snapshot, storageSnapshot: { history: [] } }, [])
    ).rejects.toThrow('invalid_snapshot');
  });

  it('leaves the old branch intact if preparing a structural replacement fails', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('old-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('old-a'));
    const before = await fixture.backend.readHistory();
    const original = NodeLodyHistory.prototype.acceptToView;
    let stages = 0;
    const spy = vi
      .spyOn(NodeLodyHistory.prototype, 'acceptToView')
      .mockImplementation(async function (input) {
        if (input.operationId.startsWith('stage:') && ++stages === 2)
          throw new Error('Injected stage failure');
        return original.call(this, input);
      });
    await expect(
      fixture.backend.applyHistoryAction({
        kind: 'upsert-turn',
        turn: nativeUser('insert-u') as never,
        beforeTurnId: 'old-u',
      })
    ).rejects.toThrow('Injected stage failure');
    spy.mockRestore();
    expect(await fixture.backend.readHistory()).toEqual(before);
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: nativeUser('insert-u') as never,
      beforeTurnId: 'old-u',
    });
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'old-u' });
    expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'insert-u',
      'old-a',
    ]);
    await fixture.close();
    expect(
      (await (await nativeFixture(fixture.doc.sessionId)).backend.readHistory()).map(
        (entry) => entry.id
      )
    ).toEqual(['insert-u', 'old-a']);
  });

  it('refreshes count and position reads after a committed generation loses its reply', async () => {
    const source = await nativeFixture();
    for (const id of ['copied-one', 'copied-two', 'copied-three'])
      await source.backend.appendHistoryTurn(nativeUser(id));
    const snapshot = await source.backend.captureForkSnapshot();
    for (const reader of ['count', 'readAt', 'readDirectory'] as const) {
      const target = await nativeFixture();
      await target.backend.appendHistoryTurn(nativeUser('target-u'));
      await target.backend.appendHistoryTurn(nativeAssistant('target-a'));
      const original = RoostHistoryGeneration.prototype.replace;
      const spy = vi
        .spyOn(RoostHistoryGeneration.prototype, 'replace')
        .mockImplementationOnce(async function (...args) {
          await original.apply(this, args);
          throw new Error('Injected lost activation reply');
        });
      await expect(target.backend.importForkHistory(snapshot, snapshot.history)).rejects.toThrow(
        'Injected lost activation reply'
      );
      spy.mockRestore();
      if (reader === 'count') expect(await target.backend.history.count()).toBe(5);
      if (reader === 'readAt')
        expect(await target.backend.history.readAt(4)).toMatchObject({
          state: 'ready',
          turn: { id: 'target-a' },
        });
      if (reader === 'readDirectory')
        expect(await target.backend.history.readDirectory(4, 5)).toMatchObject([
          { position: 4, turnId: 'target-a' },
        ]);
      await target.backend.flushLocalWrites();
      expect(await target.doc.getRoostHistoryCursor()).toMatchObject({ historyCount: 5 });
      expect((await target.backend.readHistory()).map((entry) => entry.id)).toEqual([
        'copied-one',
        'copied-two',
        'copied-three',
        'target-u',
        'target-a',
      ]);
    }
  });

  it('persists sparse ACP tool updates and subsequent text together, including retry after reopen', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeAssistant('sparse-tools'));
    const checkpoint = await fixture.backend.history.getCheckpoint?.();
    const input = {
      targetAssistantEntryId: 'sparse-tools',
      notifications: [
        {
          sessionId: 'synthetic-acp',
          update: {
            sessionUpdate: 'tool_call' as const,
            toolCallId: 'synthetic-tool',
            title: 'Synthetic tool',
            status: 'in_progress' as const,
          },
        },
        {
          sessionId: 'synthetic-acp',
          update: {
            sessionUpdate: 'tool_call_update' as const,
            toolCallId: 'synthetic-tool',
            status: 'completed' as const,
          },
        },
        {
          sessionId: 'synthetic-acp',
          update: {
            sessionUpdate: 'agent_message_chunk' as const,
            content: { type: 'text' as const, text: 'Visible reply after tool' },
          },
        },
      ],
      operationIds: ['sparse-tool-start', 'sparse-tool-finish', 'sparse-text'],
    };
    await fixture.backend.applyAgentBatch(input);
    const expected = {
      state: 'ready',
      turn: {
        items: [
          { type: 'tool_call', toolCallId: 'synthetic-tool', status: 'completed' },
          { type: 'text', text: 'Visible reply after tool' },
        ],
      },
    };
    expect(await fixture.backend.readTurn('sparse-tools')).toMatchObject(expected);
    if (!checkpoint || !fixture.backend.history.readChanges)
      throw new Error('Expected incremental owner');
    expect(await fixture.backend.history.readChanges(checkpoint)).toMatchObject({
      state: 'ready',
      ids: ['sparse-tools'],
    });
    await fixture.backend.flushLocalWrites();
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(sessionId);
    await reopened.backend.applyAgentBatch(input);
    expect(await reopened.backend.readTurn('sparse-tools')).toMatchObject(expected);
  });

  it('delivers an accepted user turn through the ACP buffer and Native history to peer RPC reads', async () => {
    const fixture = await coldHistoryHandlerFixture(1);
    const sessionId = [...fixture.docs.keys()][0];
    if (!sessionId) throw new Error('Missing synthetic session');
    const host = fixture.handler as unknown as {
      beginConversationTurn(id: SessionId, userTurnId: string): string;
      enqueueACPUpdate(
        id: SessionId,
        notification: import('@lody/shared').AcpSessionNotification
      ): void;
      flushACPUpdatesNow(id: SessionId): Promise<void>;
      store: { get(id: SessionId): { acpUpdateBuffer: unknown[] } };
    };
    try {
      await fixture.ready(sessionId);
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'append', {
          entry: nativeUser('synthetic-request'),
        })
      ).toMatchObject({ success: true });
      const doc = fixture.docs.get(sessionId);
      if (!doc) throw new Error('Missing synthetic document');
      const backend = await createSessionBackend(doc);
      const assistantId = host.beginConversationTurn(sessionId, 'synthetic-request');
      await backend.appendHistoryTurn(nativeAssistant(assistantId));
      const page = await fixture.rpc.readSessionHistoryForRpc(sessionId, {
        kind: 'readLatestPage',
        limit: 40,
        withCheckpoint: true,
      });
      const checkpoint = (page.result as { checkpoint?: string }).checkpoint;
      if (!page.success || !checkpoint) throw new Error('Expected peer checkpoint');
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'buffered-tool',
          title: 'Synthetic tool',
          status: 'in_progress',
        },
      });
      const chunks = Array.from({ length: 31 }, (_, index) => `chunk-${index};`);
      for (const text of chunks)
        host.enqueueACPUpdate(sessionId, {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'buffered-tool',
          status: 'completed',
        },
      });
      await host.flushACPUpdatesNow(sessionId);
      expect(host.store.get(sessionId).acpUpdateBuffer).toEqual([]);
      const response = SessionHistoryReadResponseSchema.parse(
        JSON.parse(
          JSON.stringify(
            await fixture.rpc.readSessionHistoryForRpc(sessionId, {
              kind: 'readChanges',
              checkpoint,
              includeBodiesFrom: 0,
            })
          )
        )
      );
      expect(response.success).toBe(true);
      const changes = SessionHistoryChangesSchema.parse(response.result);
      const expected = {
        id: assistantId,
        items: [
          { type: 'tool_call', toolCallId: 'buffered-tool', status: 'completed' },
          { type: 'text', text: chunks.join('') },
        ],
      };
      expect(changes).toMatchObject({
        state: 'ready',
        ids: [assistantId],
        bodies: { changed: [expected] },
      });
      await backend.flushLocalWrites();
      await fixture.close();
      const reopened = await nativeFixture(sessionId);
      expect(await reopened.backend.readTurn(assistantId)).toMatchObject({
        state: 'ready',
        turn: expected,
      });
      expect(await reopened.backend.readHistoryCount()).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it.each([false, true])(
    'updates two independent renderer replicas through encrypted RPC without control hints (lostNativeReply=%s)',
    async (lostNativeReply) => {
      // The renderer package owns its browser test dependency; the CLI runtime
      // stays free of IndexedDB dependencies.
      const rendererRequire = createRequire(
        new URL('../../../packages/components/package.json', import.meta.url)
      );
      const idb = rendererRequire('fake-indexeddb') as {
        IDBFactory: new () => IDBFactory;
        IDBKeyRange: typeof IDBKeyRange;
      };
      vi.stubGlobal('indexedDB', new idb.IDBFactory());
      vi.stubGlobal('IDBKeyRange', idb.IDBKeyRange);
      const fixture = await coldHistoryHandlerFixture(1);
      const sessionId = [...fixture.docs.keys()][0];
      if (!sessionId) throw new Error('Missing synthetic session');
      const host = fixture.handler as unknown as {
        beginConversationTurn(id: SessionId, userTurnId: string): string;
        enqueueACPUpdate(id: SessionId, value: import('@lody/shared').AcpSessionNotification): void;
        flushACPUpdatesNow(id: SessionId): Promise<void>;
        waitForSessionHistoryChanges(args: {
          sessionId: SessionId;
          checkpoint: string;
          waitMs: number;
          signal: AbortSignal;
        }): Promise<void>;
        store: { get(id: SessionId): { acpUpdateBuffer: unknown[] } };
      };
      // Substitute only delivery. Both production RPC endpoints still serialize,
      // encrypt, validate and decrypt every request/result.
      const receivers = new Map<string, LoroJsonLiveBatchHandler>();
      const streams: LoroStreamsJsonStreamClient = {
        ensureJsonStream: async () => undefined,
        appendJson: async (streamId, value) => {
          const receive = receivers.get(streamId);
          if (!receive) throw new Error('Synthetic stream has no receiver');
          await receive({ messages: [JSON.parse(JSON.stringify(value))], upToDate: true });
          return 'synthetic-offset';
        },
        readJsonLive: (streamId, _state, receive, options) =>
          new Promise<void>((resolve) => {
            if (options?.signal?.aborted) return resolve();
            receivers.set(streamId, receive);
            options?.signal?.addEventListener(
              'abort',
              () => {
                receivers.delete(streamId);
                resolve();
              },
              { once: true }
            );
          }),
      };
      const workspaceId = 'test-workspace' as WorkspaceId;
      const machineId = 'test-machine' as MachineId;
      const parked = Promise.withResolvers<void>();
      let observations = 0;
      let checkedObservations = 0;
      const refusalPath = join(nativeDirectory, `replica-refusals-${ordinal++}.db`);
      const server = new LoroStreamsMachineRpcServer({
        workspaceId,
        machineId,
        streamClient: streams,
        logger: getDefaultLogger(),
        getMachineStatus: async () => {
          throw new Error('Unused machine status');
        },
        refreshMachineAcpCapabilities: async () => {
          throw new Error('Unused capability refresh');
        },
        historyRequestRejections: {
          get: (request) =>
            Effect.runPromise(getSessionHistoryRpcRejection(refusalPath, request, Date.now())),
          put: (request, refusal) =>
            Effect.runPromise(
              putSessionHistoryRpcRejection(refusalPath, request, refusal, Date.now())
            ),
        },
        resolveSessionHistoryOwnerSessionId: (id, options) =>
          fixture.rpc.resolveSessionHistoryOwnerSessionId(id, options),
        readSessionHistory: ({ sessionId: id, query, signal }) =>
          fixture.rpc.readSessionHistoryForRpc(id, query, signal),
        writeSessionHistory: ({ sessionId: id, operation, payload }) =>
          fixture.rpc.writeSessionHistoryForRpc(id, operation, payload),
        waitForSessionHistoryChanges: (args) => {
          const waiting = host.waitForSessionHistoryChanges(args);
          observations++;
          return waiting;
        },
      });
      const client = new LoroStreamsMachineRpcClient({
        workspaceId,
        machineId,
        streamClient: streams,
      });
      const peers: ReturnType<ReturnType<typeof createRemoteRoostSessionDataFactory>>[] = [];
      const peerDocs = [new LoroDoc(), new LoroDoc()];
      const stops: (() => void)[] = [];
      try {
        await fixture.ready(sessionId);
        await server.start();
        await client.start();
        expect(
          await client.requestSessionHistoryWrite({
            sessionId,
            operation: 'append',
            payload: { entry: nativeUser('replica-user') },
          })
        ).toMatchObject({ success: true });
        const doc = fixture.docs.get(sessionId);
        if (!doc) throw new Error('Missing synthetic document');
        const backend = await createSessionBackend(doc);
        const checkpoint = backend.history.getCheckpoint;
        if (!checkpoint) throw new Error('Missing native checkpoint observation');
        vi.spyOn(backend.history, 'getCheckpoint').mockImplementation(async () => {
          const result = await checkpoint();
          if (observations > 0 && ++checkedObservations === 2) parked.resolve();
          return result;
        });
        const assistantId = host.beginConversationTurn(sessionId, 'replica-user');
        await backend.appendHistoryTurn(nativeAssistant(assistantId));
        const chunks = Array.from({ length: 31 }, (_, index) => `跨端-${index}🙂;`);
        const finalText = chunks.join('');
        const visible = peerDocs.map(() => Promise.withResolvers<void>());
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const ticks: number[] = [];
        let timerReady = Promise.withResolvers<void>();
        const setTimer = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
          const timer = setTimer(...args);
          // Advance scheduled recovery explicitly, without expiring a parked
          // 15-second owner watch or relying on native I/O scheduling speed.
          if (args[1] === 0 || args[1] === 500) {
            ticks.push(args[1]);
            timerReady.resolve();
          }
          return timer;
        });
        for (const [index, peerDoc] of peerDocs.entries()) {
          const peer = createRemoteRoostSessionDataFactory({
            accountId: `synthetic-peer-${index}`,
            workspaceId,
            machineId,
            incremental: true,
            watch: true,
            requestHistoryRead: async (_machine, id, query) => {
              const result = await client.requestSessionHistoryRead({ sessionId: id, query });
              if (!result) throw new Error('Missing history read response');
              return result;
            },
            requestHistoryWrite: async (args) => {
              const result = await client.requestSessionHistoryWrite(args);
              if (!result) throw new Error('Missing history write response');
              return result;
            },
          })({ sessionId, doc: peerDoc, backendKind: 'roost' });
          peers.push(peer);
          const observation = peer.history.observe(() => {
            void peer.history.readTurn(assistantId).then((read) => {
              if (
                read.state === 'ready' &&
                read.turn.items?.some((item) => item.type === 'text' && item.text === finalText)
              )
                visible[index]!.resolve();
            }, visible[index]!.reject);
          });
          stops.push(observation.unsubscribe);
          await observation.initial;
        }
        await vi.advanceTimersByTimeAsync(0);
        await parked.promise;
        host.enqueueACPUpdate(sessionId, {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'replica-tool',
            title: 'Synthetic tool',
            status: 'in_progress',
          },
        });
        for (const text of chunks)
          host.enqueueACPUpdate(sessionId, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          });
        host.enqueueACPUpdate(sessionId, {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'replica-tool',
            status: 'completed',
          },
        });
        if (lostNativeReply) {
          const commit = RoostHistoryGeneration.prototype.commitPatches;
          vi.spyOn(RoostHistoryGeneration.prototype, 'commitPatches').mockImplementationOnce(
            async function (this: RoostHistoryGeneration, ...args) {
              await commit.apply(this, args);
              throw new Error('Synthetic committed native reply loss');
            }
          );
        }
        await host.flushACPUpdatesNow(sessionId);
        expect(host.store.get(sessionId).acpUpdateBuffer).toEqual([]);
        const displayed = Promise.all(visible.map((result) => result.promise));
        for (;;) {
          const outcome = await Promise.race([
            displayed.then(() => 'displayed' as const),
            (ticks.length ? Promise.resolve() : timerReady.promise).then(() => 'tick' as const),
          ]);
          if (outcome === 'displayed') break;
          timerReady = Promise.withResolvers<void>();
          const delay = ticks.shift();
          if (delay === undefined) throw new Error('Missing scheduled recovery');
          await vi.advanceTimersByTimeAsync(delay);
        }
        const expected = {
          id: assistantId,
          items: [
            { type: 'tool_call', toolCallId: 'replica-tool', status: 'completed' },
            { type: 'text', text: finalText },
          ],
        };
        for (const peer of peers) {
          expect(await peer.history.readTurn(assistantId)).toMatchObject({
            state: 'ready',
            turn: expected,
          });
          expect(await peer.history.count()).toBe(2);
        }
        expect(peerDocs.map((peerDoc) => peerDoc.getMap('roostHistoryCursor').toJSON())).toEqual([
          {},
          {},
        ]);
        stops.forEach((stop) => stop());
        peers.forEach((peer) => peer.dispose?.());
        server.stop();
        client.stop();
        await Promise.all(
          (server as unknown as { inFlightRequests: Set<Promise<void>> }).inFlightRequests
        );
        vi.restoreAllMocks();
        vi.useRealTimers();
        await fixture.close();
        const reopened = await nativeFixture(sessionId);
        expect(await reopened.backend.readTurn(assistantId)).toMatchObject({
          state: 'ready',
          turn: expected,
        });
        expect(await reopened.backend.readHistoryCount()).toBe(2);
      } finally {
        stops.forEach((stop) => stop());
        peers.forEach((peer) => peer.dispose?.());
        server.stop();
        client.stop();
        await Promise.all(
          (server as unknown as { inFlightRequests: Set<Promise<void>> }).inFlightRequests
        );
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await fixture.close();
      }
    }
  );

  it('uses the same JSON absence rules for inserted items and newly assigned nested fields', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('nested-optionals'),
      items: [{ type: 'tool_call', toolCallId: 'nested-tool', status: 'completed' }],
    });
    const item = {
      type: 'tool_call' as const,
      toolCallId: 'nested-tool',
      status: 'completed' as const,
      kind: undefined,
      rawOutput: {
        absent: undefined,
        kept: null,
        nested: { absent: undefined, kept: 'value' },
        list: [undefined, { absent: undefined, kept: 0 }],
      },
    };
    for (const items of [[item], [item, { type: 'text' as const, text: 'after nested data' }]]) {
      await fixture.backend.applyHistoryAction({
        kind: 'assistant-items',
        turnId: 'nested-optionals',
        mode: 'replace',
        items,
      });
      const read = await fixture.backend.readTurn('nested-optionals');
      if (read.state !== 'ready') throw new Error('Expected persisted content');
      expect(read.turn.items).toEqual(JSON.parse(JSON.stringify(items)));
    }
  });

  it('deduplicates durable per-item retries and retains identical output with different identities', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('retry-a'),
      items: [{ type: 'text', text: 'start:' }],
    });
    const original = RoostHistoryGeneration.prototype.commitPatches;
    const spy = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementationOnce(async function (...args) {
        await original.apply(this, args);
        throw new Error('Injected lost native reply');
      });
    const input = {
      targetAssistantEntryId: 'retry-a',
      notifications: [
        {
          sessionId: 'acp-test',
          update: {
            sessionUpdate: 'agent_message_chunk' as const,
            content: { type: 'text' as const, text: 'same' },
          },
        },
      ],
      operationIds: ['output-once'],
    };
    await expect(fixture.backend.applyAgentBatch(input)).rejects.toThrow(
      'Injected lost native reply'
    );
    spy.mockRestore();
    await fixture.backend.applyAgentBatch(input);
    await fixture.backend.applyAgentBatch({ ...input, operationIds: ['output-twice'] });
    expect(await fixture.backend.readTurn('retry-a')).toMatchObject({
      state: 'ready',
      turn: { items: [{ type: 'text', text: 'start:samesame' }] },
    });
    await expect(
      fixture.backend.applyAgentBatch({
        ...input,
        notifications: [
          {
            sessionId: 'acp-test',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'changed' },
            },
          },
        ],
      })
    ).rejects.toThrow('identity conflict');
  });

  it('keeps sustained streaming writes bounded with a large unchanged field and survives reopen', async () => {
    const fixture = await nativeFixture();
    const untouched = 'unchanged'.repeat(4096);
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('bounded-stream'),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'unchanged-tool',
          status: 'completed',
          title: 'Synthetic unchanged tool',
          rawOutput: { text: untouched },
        },
        { type: 'text', text: '' },
      ],
    });
    const notification = (index: number) => ({
      sessionId: 'synthetic-acp',
      update: {
        sessionUpdate: 'agent_message_chunk' as const,
        content: { type: 'text' as const, text: `🙂increment-${index};` },
      },
    });
    const output = Array.from(
      { length: 128 },
      (_, index) => notification(index).update.content.text
    ).join('');
    for (let i = 0; i < 128; i++)
      await fixture.backend.applyAgentBatch({
        targetAssistantEntryId: 'bounded-stream',
        notifications: [notification(i)],
        operationIds: [`bounded-stream-${i}`],
      });
    await fixture.backend.flushLocalWrites();
    const streamed = await fixture.backend.readTurn('bounded-stream');
    expect(streamed).toMatchObject({ state: 'ready' });
    if (streamed.state === 'ready') {
      const text =
        streamed.turn.items?.map((item) => (item.type === 'text' ? item.text : '')).join('') ?? '';
      expect(text).toBe(output);
      expect(streamed.turn.items?.[0]).toMatchObject({ rawOutput: { text: untouched } });
    }
    const db = new Database(join(nativeDirectory, 'history.db'), { readonly: true });
    try {
      const stats = db
        .prepare(`SELECT COUNT(*) AS rows, SUM(LENGTH(key) + LENGTH(value)) AS bytes
        FROM roost_kv WHERE space LIKE ?`)
        .get(`%${fixture.doc.sessionId}%:updates`) as { rows: number; bytes: number };
      expect(stats.rows).toBeGreaterThan(128);
      expect(stats.bytes).toBeLessThan(1024 * 1024);
      const receipts = db
        .prepare(`SELECT COUNT(*) AS count FROM roost_kv WHERE space LIKE ?`)
        .get(`%${fixture.doc.sessionId}%:lody_agent_operation_receipts_v1`) as { count: number };
      expect(receipts.count).toBe(128);
      const projection = db
        .prepare(`SELECT COUNT(*) AS count FROM roost_kv WHERE space LIKE ?`)
        .get(`%${fixture.doc.sessionId}%:projection`) as { count: number };
      expect(projection.count).toBeGreaterThan(0);
      expect(projection.count).toBeLessThan(1000);
    } finally {
      db.close();
    }
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(sessionId);
    await reopened.backend.applyAgentBatch({
      targetAssistantEntryId: 'bounded-stream',
      notifications: [notification(127)],
      operationIds: ['bounded-stream-127'],
    });
    expect(await reopened.backend.readTurn('bounded-stream')).toMatchObject({
      state: 'ready',
      turn: {
        items: [
          { type: 'tool_call', rawOutput: { text: untouched } },
          { type: 'text', text: output },
        ],
      },
    });
  });
});

describe('Production Roost immutable input acceptance', () => {
  const inputPort = (fixture: Awaited<ReturnType<typeof nativeFixture>>) => {
    const port = fixture.backend.inputAcceptance;
    if (!port) throw new Error('Expected immutable input acceptance');
    return port;
  };

  it('commits human provenance and activation with ordinary acceptance and preserves a newer pointer on retry', async () => {
    const fixture = await nativeFixture();
    const first = nativeUser('combined-first'),
      second = nativeUser('combined-second');
    const accept = inputPort(fixture).acceptAndDispatch;
    if (!accept) throw new Error('Expected combined input dispatch');
    expect(await accept(first)).toMatchObject({
      status: 'accepted',
      turnId: first.id,
      active: true,
    });
    expect((await fixture.doc.getDocState())?.humanInputReceipts?.[first.id]).toEqual({
      userId: first.userId,
    });
    expect((await fixture.doc.getMetaState())?.latestUserMsgId).toBe(first.id);
    await accept(second);
    await accept(first);
    expect((await fixture.doc.getMetaState())?.latestUserMsgId).toBe(second.id);
    expect((await fixture.backend.readHistory()).map((turn) => turn.id)).toEqual([
      first.id,
      second.id,
    ]);
    const meta = await fixture.doc.getMetaState();
    if (!meta) throw new Error('Expected live session metadata');
    expect(findNextDispatchableUserTurn(await fixture.backend.readHistory(), meta)?.id).toBe(
      first.id
    );
    await expect(accept({ ...first, userId: 'another-user' })).rejects.toThrow();
    expect((await fixture.doc.getDocState())?.humanInputReceipts?.[first.id]).toEqual({
      userId: first.userId,
    });
  });

  it('keeps provenance before a paused native commit and serializes competing acceptance and activation', async () => {
    const fixture = await nativeFixture();
    const first = nativeUser('combined-paused-first'),
      second = nativeUser('combined-paused-second');
    const accept = inputPort(fixture).acceptAndDispatch;
    if (!accept) throw new Error('Expected combined input dispatch');
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const request = RoostNativeClient.prototype.request;
    let paused = false;
    const spy = vi
      .spyOn(RoostNativeClient.prototype, 'request')
      .mockImplementation(async function (args, options) {
        if (
          !paused &&
          args.method === 'writeBatch' &&
          args.stream === `lody-session:${fixture.doc.sessionId}` &&
          args.indexPuts?.some((put) => put.table === 'lody_history_branch_operations_v1')
        ) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return request.call(this, args, options);
      });
    const initial = accept(first),
      competing = accept(second);
    void initial.catch(() => {});
    void competing.catch(() => {});
    try {
      await entered.promise;
      expect((await fixture.doc.getDocState())?.humanInputReceipts).toEqual({
        [first.id]: { userId: first.userId },
      });
      expect((await fixture.doc.getMetaState())?.latestUserMsgId).toBeUndefined();
      expect(await fixture.backend.readTurn(first.id)).toMatchObject({ state: 'missing' });
      release.resolve();
      await Promise.all([initial, competing]);
      expect((await fixture.backend.readHistory()).map((turn) => turn.id)).toEqual([
        first.id,
        second.id,
      ]);
      expect((await fixture.doc.getMetaState())?.latestUserMsgId).toBe(second.id);
    } finally {
      release.resolve();
      await Promise.allSettled([initial, competing]);
      spy.mockRestore();
    }
  });

  it.each(['handled', 'canceled', 'removed', 'archived', 'missing-marker'] as const)(
    'never reactivates a settled or unavailable accepted input: %s',
    async (state) => {
      const fixture = await nativeFixture();
      const input = nativeUser(`combined-${state}`);
      const accept = inputPort(fixture).acceptAndDispatch;
      if (!accept) throw new Error('Expected combined input dispatch');
      await accept(input);
      await fixture.repo.upsertDocMeta(fixture.doc.roomId, {
        latestUserMsgId: 'preserved-pointer',
      });
      if (state === 'removed')
        await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: input.id });
      else if (state === 'archived')
        await fixture.repo.upsertDocMeta(fixture.doc.roomId, { isArchived: true });
      else if (state === 'missing-marker')
        await fixture.repo.upsertDocMeta(fixture.doc.roomId, {
          lastMissingHistoryUserMsgId: input.id,
        });
      else
        await fixture.backend.applyHistoryAction({
          kind: 'user-status',
          turnId: input.id,
          status: state,
        });
      expect(await accept(input)).toMatchObject({
        status: 'accepted',
        active: state !== 'removed',
      });
      expect((await fixture.doc.getMetaState())?.latestUserMsgId).toBe('preserved-pointer');
      expect((await fixture.backend.readHistory()).map((turn) => [turn.id, turn.status])).toEqual(
        state === 'removed'
          ? []
          : [[input.id, state === 'handled' || state === 'canceled' ? state : 'pending']]
      );
    }
  );

  it('recovers a committed input after activation failed without appending it again', async () => {
    const fixture = await nativeFixture();
    const input = nativeUser('combined-activation-failure');
    const accept = inputPort(fixture).acceptAndDispatch;
    if (!accept) throw new Error('Expected combined input dispatch');
    const activate = fixture.doc.publishUserTurnActivation.bind(fixture.doc);
    fixture.doc.publishUserTurnActivation = async () => {
      throw new Error('Synthetic activation failure');
    };
    await expect(accept(input)).rejects.toThrow('Synthetic activation failure');
    expect(await inputPort(fixture).lookup(input)).toMatchObject({
      status: 'accepted',
      active: true,
    });
    fixture.doc.publishUserTurnActivation = activate;
    await accept(input);
    expect((await fixture.backend.readHistory()).map((turn) => turn.id)).toEqual([input.id]);
    expect((await fixture.doc.getMetaState())?.latestUserMsgId).toBe(input.id);
  });

  it('returns the combined RPC receipt after owner activation while dispatch execution is still blocked', async () => {
    const fixture = await nativeFixture();
    const input = nativeUser('combined-rpc-input');
    const execution = Promise.withResolvers<void>();
    let dispatched = false;
    const handler = Object.assign(Object.create(MessageHandler.prototype), {
      workspaceDocument: { repo: fixture.repo, getOrCreateSessionDoc: async () => fixture.doc },
      resolveSessionHistoryOwnerSessionId: async (id: SessionId) => id,
      touchSession: () => undefined,
      logger: getDefaultLogger(),
      cleanedUp: false,
      sessionDispatchWatcher: {
        enqueueSessionCheck: async () => {
          dispatched = true;
          await execution.promise;
        },
      },
    }) as {
      writeSessionHistoryForRpc(
        id: SessionId,
        operation: 'accept_input_and_dispatch',
        payload: Record<string, unknown>
      ): Promise<SessionHistoryWriteResponse>;
    };
    try {
      const receipt = await handler.writeSessionHistoryForRpc(
        fixture.doc.sessionId,
        'accept_input_and_dispatch',
        { entry: input }
      );
      expect(receipt).toMatchObject({
        success: true,
        operation: 'accept_input_and_dispatch',
        result: { status: 'accepted', turnId: input.id, active: true },
      });
      expect(SessionHistoryWriteResponseSchema.safeParse(receipt).success).toBe(true);
      expect((await fixture.doc.getMetaState())?.latestUserMsgId).toBe(input.id);
      expect(await fixture.backend.readTurn(input.id)).toMatchObject({
        state: 'ready',
        turn: { id: input.id },
      });
      expect(dispatched).toBe(true);
    } finally {
      execution.resolve();
    }
  });

  it('keeps committed inputs dispatchable in history order independently of reply observation and later activation pointers', async () => {
    const fixture = await nativeFixture();
    const first = nativeUser('first-input'),
      second = nativeUser('second-input');
    await inputPort(fixture).accept(first);
    await inputPort(fixture).accept(second);
    const found = await fixture.repo.getDocMeta(getSessionRoomId(fixture.doc.sessionId));
    const meta = { ...found?.meta, latestUserMsgId: second.id } as SessionMeta;
    expect(findNextDispatchableUserTurn(await fixture.backend.readHistory(), meta)?.id).toBe(
      first.id
    );
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: first.id,
      status: 'handled',
    });
    expect(findNextDispatchableUserTurn(await fixture.backend.readHistory(), meta)?.id).toBe(
      second.id
    );
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: second.id,
      status: 'handled',
    });
    expect(
      findNextDispatchableUserTurn(await fixture.backend.readHistory(), {
        ...meta,
        lastHandledUserMsgId: second.id,
      })
    ).toBeNull();
    expect(await inputPort(fixture).accept(first)).toEqual({
      status: 'accepted',
      turnId: first.id,
      active: true,
    });
    expect((await fixture.backend.readHistory()).map((turn) => [turn.id, turn.status])).toEqual([
      [first.id, 'handled'],
      [second.id, 'handled'],
    ]);
  });

  it.each(['retry-first', 'replacement-first', 'removed-after-original'] as const)(
    'converges a delayed original and the same immutable retry: %s',
    async (scenario) => {
      const source = await nativeFixture();
      await source.backend.appendHistoryTurn(nativeUser('baseline'));
      const peer = await nativeFixture(source.doc.sessionId);
      const input = nativeUser('delayed-original');
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const originalRequest = RoostNativeClient.prototype.request;
      let gated = false;
      const spy = vi
        .spyOn(RoostNativeClient.prototype, 'request')
        .mockImplementation(async function (request, options) {
          if (
            !gated &&
            request.method === 'writeBatch' &&
            request.stream === `lody-session:${source.doc.sessionId}` &&
            request.indexPuts?.some((put) => put.table === 'lody_history_branch_operations_v1')
          ) {
            gated = true;
            entered.resolve();
            await release.promise;
          }
          return originalRequest.call(this, request, options);
        });
      const initial = inputPort(source).accept(input);
      void initial.catch(() => {});
      try {
        await entered.promise;
        expect(await inputPort(peer).lookup(input)).toEqual({ status: 'unobserved' });
        if (scenario === 'removed-after-original') {
          release.resolve();
          await initial;
          await peer.backend.applyHistoryAction({ kind: 'remove-turn', turnId: input.id });
          expect(await inputPort(peer).accept(input)).toEqual({
            status: 'accepted',
            turnId: input.id,
            active: false,
          });
          expect((await peer.backend.readHistory()).map((turn) => turn.id)).toEqual(['baseline']);
        } else {
          if (scenario === 'replacement-first')
            await peer.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'baseline' });
          expect(await inputPort(peer).accept(input)).toEqual({
            status: 'accepted',
            turnId: input.id,
            active: true,
          });
          release.resolve();
          expect(await initial).toEqual({ status: 'accepted', turnId: input.id, active: true });
          const expected = scenario === 'replacement-first' ? [input.id] : ['baseline', input.id];
          expect((await source.backend.readHistory()).map((turn) => turn.id)).toEqual(expected);
          expect((await peer.backend.readHistory()).map((turn) => turn.id)).toEqual(expected);
        }
        await source.close();
        await peer.close();
        const reopened = await nativeFixture(source.doc.sessionId);
        expect(await inputPort(reopened).lookup(input)).toEqual({
          status: 'accepted',
          turnId: input.id,
          active: scenario !== 'removed-after-original',
        });
      } finally {
        release.resolve();
        await initial.catch(() => {});
        spy.mockRestore();
      }
    }
  );

  it('recovers the original input receipt after state changes and owner reopen without another history append', async () => {
    const id = `immutable-input-${ordinal++}`;
    let fixture = await nativeFixture(id);
    const input = nativeUser('immutable-user');
    expect(await inputPort(fixture).lookup(input)).toEqual({ status: 'unobserved' });
    expect(await fixture.backend.readHistory()).toEqual([]);
    expect(await inputPort(fixture).accept(input)).toEqual({
      status: 'accepted',
      turnId: input.id,
      active: true,
    });
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: input.id,
      status: 'handled',
    });
    await fixture.backend.appendHistoryTurn(nativeAssistant('later-assistant'));
    const before = await fixture.backend.readHistory();
    expect(await inputPort(fixture).accept(input)).toEqual({
      status: 'accepted',
      turnId: input.id,
      active: true,
    });
    expect(await fixture.backend.readHistory()).toEqual(before);
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await inputPort(fixture).lookup(input)).toEqual({
      status: 'accepted',
      turnId: input.id,
      active: true,
    });
    expect(await fixture.backend.readHistory()).toEqual(before);
    await expect(
      inputPort(fixture).accept({ ...input, items: [{ type: 'text', text: 'conflicting input' }] })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await fixture.backend.readHistory()).toEqual(before);
    await fixture.close();
  });

  it('does not mistake unreadable accepted history for a removed input', async () => {
    const fixture = await nativeFixture();
    const input = nativeUser('unreadable-input');
    await inputPort(fixture).accept(input);
    const read = vi
      .spyOn(fixture.backend.history, 'readTurn')
      .mockResolvedValue({ state: 'unavailable', reason: 'incomplete' });
    await expect(inputPort(fixture).lookup(input)).rejects.toThrow('not readable');
    read.mockRestore();
    expect(await inputPort(fixture).lookup(input)).toEqual({
      status: 'accepted',
      turnId: input.id,
      active: true,
    });
    expect((await fixture.backend.readHistory()).map((turn) => turn.id)).toEqual([input.id]);
  });

  it('retains receipts across branch removal and storage-generation replacement', async () => {
    const id = `immutable-generation-${ordinal++}`;
    let fixture = await nativeFixture(id);
    const input = nativeUser('removed-input');
    await inputPort(fixture).accept(input);
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: input.id });
    expect(await fixture.backend.readHistory()).toEqual([]);
    expect(await inputPort(fixture).accept(input)).toEqual({
      status: 'accepted',
      turnId: input.id,
      active: false,
    });
    expect(await fixture.backend.readHistory()).toEqual([]);
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await inputPort(fixture).lookup(input)).toEqual({
      status: 'accepted',
      turnId: input.id,
      active: false,
    });
    expect(await inputPort(fixture).accept(input)).toEqual({
      status: 'accepted',
      turnId: input.id,
      active: false,
    });
    expect(await fixture.backend.readHistory()).toEqual([]);
    await fixture.close();
  });
});

it('persists one targeted Inbox batch receipt through native Roost reopen without changing user input', async () => {
  const fixture = await nativeFixture();
  const one = '00000000-0000-4000-8000-000000000001';
  const two = '00000000-0000-4000-8000-000000000002';
  await fixture.backend.appendHistoryTurn(nativeUser('request'));
  for (const [id, batchId] of [
    ['one', one],
    ['two', two],
  ] as const)
    await fixture.backend.appendHistoryTurn({
      id,
      role: 'system',
      timestamp: '2026-10-12T00:00:00Z',
      finished: true,
      fileDiff: [],
      items: [
        {
          type: 'operation_completion_batch',
          batchId,
          memberCount: 8,
          members: [],
          deliveryStatus: 'prepared',
        },
      ],
    });
  const original = await fixture.backend.readHistory();
  expect(
    await fixture.backend.applyHistoryAction({
      kind: 'operation-batch-status',
      turnId: 'one',
      batchId: 'foreign',
      status: 'unknown',
    })
  ).toMatchObject({ matched: false });
  await fixture.backend.applyHistoryAction({
    kind: 'operation-batch-status',
    turnId: 'one',
    batchId: one,
    status: 'unknown',
  });
  expect(
    await fixture.backend.applyHistoryAction({
      kind: 'operation-batch-status',
      turnId: 'one',
      batchId: one,
      status: 'unknown',
    })
  ).toMatchObject({ matched: false });
  const id = fixture.doc.sessionId;
  await fixture.close();
  const reopened = await nativeFixture(id);
  const history = await reopened.backend.readHistory();
  expect(history).toHaveLength(3);
  expect(history[0]).toEqual(original[0]);
  expect(history[1]?.items?.[0]).toMatchObject({
    type: 'operation_completion_batch',
    batchId: one,
    deliveryStatus: 'unknown',
    memberCount: 8,
  });
  expect(history[2]).toEqual(original[2]);
  await reopened.close();
});
