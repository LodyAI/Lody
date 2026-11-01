import {
  readSessionTranscript,
  toSessionTranscriptEntries,
  selectSessionTranscriptEntries,
} from '../src/commands/session';
import { buildReplayPromptFromHistory, createReplayPromptBuilder } from '@lody/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  disposeSessionBackend,
  routeRemoteOwnedSessionHistory,
  type SessionBackendFactory,
} from '../src/session/session-backend';
import { NodeLodyHistory, type HistoryIdentity } from '@loro-dev/roost/lody-history';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  resolveActiveAssistantTurnId,
  SessionHistoryReadQuerySchema,
  applyNotificationOnHistory,
  prepareReplacement,
  SessionHistoryReadResponseSchema,
  SessionHistoryWriteResponseSchema,
  getMachineRoomId,
  getSessionRoomId,
  SessionStatusFactory,
  resolveLatestSessionGoalFromHistory,
  type SessionGoalMessage,
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
  createRoostDirectoryRow,
  readSessionHistoryMetadata,
  hashHistoryEntryForVersion,
  hashText,
  applySessionHistoryPatches,
  applyHistoryAction,
  type HistoryImportInput,
} from '@lody/shared/session-data';
import { decodeBatch, Identity } from '@loro-dev/roost';
import { RoostNativeClient, RoostHostError } from '@loro-dev/roost-node';
import { describeRoostHistoryFailure } from '../src/session/roost-history-diagnostics';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { RoostDispatchIndex } from '../src/session/roost-dispatch-index';
import { dispatchEntry, selectDispatchHistory } from '../src/session/session-dispatch-history';
import { SessionDispatchWatcher } from '../src/session/session-dispatch-watcher';
import type { SessionExecutionService } from '../src/session/session-execution-service';
import { readGoalProjection } from '../src/session/roost-goal-projection';
import { encodeRoostHistoryChange } from '../src/session/roost-history-change-codec';
import {
  AGENT_RECEIPTS_TABLE,
  agentReceiptKey,
  agentReceiptPut,
  decodeAgentReceipt,
} from '../src/session/roost-content-patches';
import { findNextDispatchableUserTurn } from '../src/session/session-dispatch-logic';
import type { SessionMeta } from '@lody/shared';
import { encodeRoostContent } from '../src/session/roost-history-port';
import { RoostHistoryHead, ROOST_HEAD_KEY } from '../src/session/roost-history-head';
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
async function invalidateGoalIndex(sessionId: string): Promise<void> {
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
      const nativeRequest = RoostNativeClient.prototype.request;
      let rejected = false;
      const request = vi
        .spyOn(RoostNativeClient.prototype, 'request')
        .mockImplementation(function (dto, options) {
          const target =
            kind === 'write'
              ? dto.method === 'writeBatch' && dto.writes?.length
              : dto.method === 'indexRead' &&
                dto.keys?.some((key) => key.table === ROOST_HEAD_KEY.table);
          if (!rejected && dto.stream === `lody-session:${fixture.doc.sessionId}` && target) {
            rejected = true;
            return Promise.reject(workerFailure);
          }
          return nativeRequest.call(this, dto, options);
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
    const nativeRequest = RoostNativeClient.prototype.request;
    let rejected = false;
    const request = vi
      .spyOn(RoostNativeClient.prototype, 'request')
      .mockImplementation(function (dto, options) {
        if (
          !rejected &&
          dto.stream === `lody-session:${fixture.doc.sessionId}` &&
          dto.method === 'writeBatch' &&
          dto.writes?.length
        ) {
          rejected = true;
          return Promise.reject(workerFailure);
        }
        return nativeRequest.call(this, dto, options);
      });
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

  it('keeps retained projections isolated and refreshes peer corrections before a local patch', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const previous = {
      ...nativeAssistant('projection-old'),
      finished: true,
      items: [
        {
          type: 'tool_call' as const,
          toolCallId: 'retained-tool',
          status: 'completed' as const,
          rawOutput: { text: 'retained output 🙂'.repeat(128) },
        },
      ],
    };
    await fixture.backend.appendHistoryTurn(nativeUser('projection-u'));
    await fixture.backend.appendHistoryTurn(previous);
    await fixture.backend.appendHistoryTurn(nativeUser('projection-next-u'));
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('projection-active'),
      items: [{ type: 'text', text: 'start' }],
    });
    const snapshot = await fixture.backend.readHistory();
    const snapshotCopy = structuredClone(snapshot);
    const exposed = await fixture.backend.readTurn('projection-old');
    if (exposed.state !== 'ready') throw new Error('Expected retained turn');
    const tool = exposed.turn.items[0];
    if (tool?.type !== 'tool_call') throw new Error('Expected retained tool');
    tool.rawOutput = { text: 'caller mutation' };
    const append = (operationId: string, text: string) =>
      fixture.backend.applyAgentBatch({
        targetAssistantEntryId: 'projection-active',
        operationIds: [operationId],
        notifications: [
          {
            sessionId: 'synthetic-acp',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          },
        ],
      });
    await append('projection-first', '🙂');
    await append('projection-first', '🙂');
    expect(snapshot).toEqual(snapshotCopy);
    expect(await fixture.backend.readTurn('projection-old')).toEqual({
      state: 'ready',
      turn: snapshotCopy[1],
    });
    expect(await fixture.backend.readTurn('projection-active')).toMatchObject({
      turn: { items: [{ type: 'text', text: 'start🙂' }] },
    });
    const activeSnapshot = await fixture.backend.readTurn('projection-active');
    if (activeSnapshot.state !== 'ready') throw new Error('Expected active turn');
    const activeText = activeSnapshot.turn.items[0];
    if (activeText?.type !== 'text') throw new Error('Expected active text');
    activeText.text = 'caller mutation of the active path';
    expect(await fixture.backend.readTurn('projection-active')).toMatchObject({
      turn: { items: [{ type: 'text', text: 'start🙂' }] },
    });

    const peer = await nativeFixture(id);
    await peer.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: {
        ...previous,
        items: [...previous.items, { type: 'text', text: 'peer correction 漢字' }],
      } as never,
    });
    await append('projection-second', '漢字');
    const complete = await fixture.backend.readHistory();
    expect(complete.map((entry) => entry.id)).toEqual(snapshotCopy.map((entry) => entry.id));
    expect(complete[1]).toMatchObject({
      items: [...previous.items, { type: 'text', text: 'peer correction 漢字' }],
    });
    expect(complete[3]).toMatchObject({ items: [{ type: 'text', text: 'start🙂漢字' }] });
    expect(snapshot).toEqual(snapshotCopy);
    await peer.close();
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await fixture.backend.readHistory()).toEqual(complete);
  });

  it('serves certified text appends while body rereads are unavailable and reopens the same committed content', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const turnId = 'certified-append';
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant(turnId),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'retained',
          status: 'completed',
          rawOutput: { text: '🙂'.repeat(1024) },
        },
        { type: 'text', text: 'start' },
      ],
    });
    const before = await fixture.backend.readTurn(turnId);
    const beforeCopy = structuredClone(before);
    const reread = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
      .mockRejectedValue(new Error('Synthetic body reread unavailable'));
    try {
      for (const [i, text] of ['🙂', '漢字', '\n🚀'].entries()) {
        await fixture.backend.applyAgentBatch({
          targetAssistantEntryId: turnId,
          operationIds: [`certified-${i}`],
          contents: [{ type: 'text', text }],
        });
      }
      expect(await fixture.backend.readTurn(turnId)).toMatchObject({
        state: 'ready',
        turn: {
          items: [
            beforeCopy.state === 'ready' ? beforeCopy.turn.items[0] : {},
            { type: 'text', text: 'start🙂漢字\n🚀' },
          ],
        },
      });
      expect(before).toEqual(beforeCopy);
    } finally {
      reread.mockRestore();
    }
    await fixture.backend.applyHistoryAction({ kind: 'finish-assistant', turnId, endedAt: 42 });
    const complete = await fixture.backend.readHistory();
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await fixture.backend.readHistory()).toEqual(complete);
  });

  it('recovers atomically committed text, receipt and active goal after the Native reply is lost', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const turnId = 'atomic-goal-a';
    await fixture.backend.appendHistoryTurn(nativeUser('atomic-goal-u'));
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant(turnId),
      acpTurnId: 'atomic-goal-boundary',
      items: [
        {
          type: 'goal',
          threadId: 'atomic-goal',
          objective: 'Preserve this goal',
          status: 'active',
        },
        { type: 'text', text: 'start' },
      ],
    });
    const input = {
      targetAssistantEntryId: turnId,
      operationIds: ['atomic-goal-append'],
      contents: [{ type: 'text' as const, text: '🙂' }],
    };
    const original = RoostNativeClient.prototype.request;
    let committed = false;
    const lost = vi
      .spyOn(RoostNativeClient.prototype, 'request')
      .mockImplementation(async function (...args) {
        const result = await original.apply(this, args);
        const command = args[0];
        if (!committed && command.method === 'writeBatch' && command.derivedIndexes) {
          const commit = result as Awaited<
            ReturnType<import('@loro-dev/roost-node').RoostNodeStream['writeBatch']>
          >;
          expect(commit.derivedIndexesApplied).toBe(true);
          const host = this.stream(command.stream);
          expect(await readGoalProjection(host, commit.through, 2)).toMatchObject({
            turnId,
            position: 1,
            goal: { threadId: 'atomic-goal', status: 'active' },
          });
          const receipts = command.indexPuts.map((put) => ({
            table: put.table,
            key: Buffer.from(put.keyHex, 'hex'),
          }));
          expect((await host.readIndex(receipts)).map((value) => value && [...value])).toEqual(
            command.indexPuts.map((put) => [...Buffer.from(put.valueHex, 'hex')])
          );
          committed = true;
          // Lose the real Native reply before the SDK adopts its checkpoint.
          throw new RoostHostError('unknownOutcome');
        }
        return result;
      });
    try {
      await expect(fixture.backend.applyAgentBatch(input)).rejects.toMatchObject({
        code: 'unknownOutcome',
      });
    } finally {
      lost.mockRestore();
    }
    expect(committed).toBe(true);
    await fixture.backend.applyAgentBatch(input);
    const complete = await fixture.backend.readHistory();
    expect(complete[1]?.items).toEqual([
      { type: 'goal', threadId: 'atomic-goal', objective: 'Preserve this goal', status: 'active' },
      { type: 'text', text: 'start🙂' },
    ]);
    expect(
      await fixture.backend.replaceEditableTail({
        expectedUserTurnId: 'atomic-goal-u',
        expectedForkTurnId: 'atomic-goal-boundary',
        replacement: nativeUser('atomic-goal-replacement') as never,
      })
    ).toMatchObject({ status: 'rejected', reason: { code: 'active_goal' } });
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await fixture.backend.readHistory()).toEqual(complete);
    await fixture.backend.applyAgentBatch(input);
    expect(await fixture.backend.readHistory()).toEqual(complete);
  });

  it('requires authoritative refresh for an uncertified commit and recovers its receipt without duplicating text', async () => {
    const fixture = await nativeFixture();
    const turnId = 'uncertified-append';
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant(turnId),
      items: [{ type: 'text', text: 'start' }],
    });
    const input = {
      targetAssistantEntryId: turnId,
      operationIds: ['uncertified-operation'],
      contents: [{ type: 'text' as const, text: '🙂' }],
    };
    const commit = RoostHistoryGeneration.prototype.commitPatches;
    const uncertified = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementationOnce(async function (...args) {
        return { ...(await commit.apply(this, args)), metadataAttached: false };
      });
    const reread = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
      .mockRejectedValue(new Error('Synthetic authoritative refresh failure'));
    try {
      await expect(fixture.backend.applyAgentBatch(input)).rejects.toThrow(
        'Synthetic authoritative refresh failure'
      );
    } finally {
      uncertified.mockRestore();
      reread.mockRestore();
    }
    await fixture.backend.applyAgentBatch(input);
    expect(await fixture.backend.readTurn(turnId)).toMatchObject({
      state: 'ready',
      turn: { items: [{ type: 'text', text: 'start🙂' }] },
    });
  });

  it('seals an installed primary without rereading the window and preserves its signed parent for the next turn', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const finish = NodeLodyHistory.prototype.finish;
    let restoreWindow: (() => void) | undefined;
    const seal = vi
      .spyOn(NodeLodyHistory.prototype, 'finish')
      .mockImplementationOnce(async function (...args) {
        await finish.apply(this, args);
        const blocked = vi
          .spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage')
          .mockRejectedValue(new Error('Synthetic window reread unavailable'));
        restoreWindow = () => blocked.mockRestore();
      });
    try {
      await fixture.backend.appendHistoryTurn({
        ...nativeAssistant('single-seal'),
        finished: true,
        items: [{ type: 'text', text: 'sealed 🙂' }],
      });
    } finally {
      restoreWindow?.();
      seal.mockRestore();
    }
    await fixture.backend.appendHistoryTurn(nativeUser('after-single-seal'));
    const complete = await fixture.backend.readHistory();
    expect(complete.map((entry) => entry.id)).toEqual(['single-seal', 'after-single-seal']);
    expect(complete[0]).toMatchObject({
      finished: true,
      items: [{ type: 'text', text: 'sealed 🙂' }],
    });
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await fixture.backend.readHistory()).toEqual(complete);
  });

  it('reloads foreign branch work that arrives while sealing an installed primary', async () => {
    const fixture = await nativeFixture();
    const peer = await nativeFixture(fixture.doc.sessionId);
    const finish = NodeLodyHistory.prototype.finish;
    const seal = vi
      .spyOn(NodeLodyHistory.prototype, 'finish')
      .mockImplementationOnce(async function (...args) {
        await finish.apply(this, args);
        await peer.backend.appendHistoryTurn(nativeUser('foreign-after-seal'));
      });
    try {
      await fixture.backend.appendHistoryTurn({
        ...nativeAssistant('local-seal'),
        finished: true,
        items: [{ type: 'text', text: 'local content' }],
      });
      expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
        'local-seal',
        'foreign-after-seal',
      ]);
      await fixture.backend.appendHistoryTurn(nativeAssistant('local-after-foreign'));
      expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
        'local-seal',
        'foreign-after-seal',
        'local-after-foreign',
      ]);
    } finally {
      seal.mockRestore();
      await peer.close();
    }
  });

  it('transmits native streaming edits without resending an unchanged large tool result', async () => {
    const fixture = await coldHistoryHandlerFixture(1);
    const id = [...fixture.docs.keys()][0]!;
    try {
      await fixture.ready(id);
      const tool = {
        type: 'tool_call' as const,
        toolCallId: 'synthetic-large-tool',
        status: 'completed' as const,
        rawOutput: { text: 'unchanged tool result '.repeat(16384) },
      };
      const turn = {
        ...nativeAssistant('rpc-stream'),
        items: [tool, { type: 'text' as const, text: 'a🙂bc🚀d' }],
      };
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(id, 'append', { entry: turn })
      ).toMatchObject({ success: true });
      const page = await fixture.rpc.readSessionHistoryForRpc(id, {
        kind: 'readLatestPage',
        limit: 40,
        withCheckpoint: true,
      });
      let checkpoint = (page.result as { checkpoint: string }).checkpoint;
      let reconstructed = page.pageTurns![0]!;
      let patchBytes = 0;
      let completeBytes = 0;
      for (let step = 0; step < 32; step++) {
        const items = [tool, { type: 'text' as const, text: `a🙂XYZ🚀d${'尾'.repeat(step + 1)}` }];
        expect(
          await fixture.rpc.writeSessionHistoryForRpc(id, 'apply_action', {
            action: { kind: 'assistant-items', turnId: turn.id, mode: 'replace', items },
          })
        ).toMatchObject({ success: true });
        const query = { checkpoint, includeBodiesFrom: 0 };
        const legacy = await fixture.rpc.readSessionHistoryForRpc(id, {
          kind: 'readChanges',
          ...query,
        });
        const response = await fixture.rpc.readSessionHistoryForRpc(
          id,
          step % 2
            ? { kind: 'watchChanges', waitMs: 0, ...query, withPatches: true }
            : { kind: 'readChanges', ...query, withPatches: true }
        );
        expect(response.success).toBe(true);
        const changes = SessionHistoryChangesSchema.parse(response.result);
        if (changes.state !== 'ready' || !changes.patches)
          throw new Error('Expected native patches');
        expect(changes.patches.baseCheckpoint).toBe(checkpoint);
        expect(changes.patches.turns.map((row) => row.turnId)).toEqual([turn.id]);
        expect(changes.bodies).toEqual({ changed: [], suffix: [] });
        reconstructed = applySessionHistoryPatches(
          reconstructed,
          changes.patches.turns[0]!.operations
        );
        const complete = SessionHistoryChangesSchema.parse(legacy.result);
        if (complete.state !== 'ready') throw new Error('Expected legacy complete response');
        expect(complete.patches).toBeUndefined();
        expect(complete.bodies?.changed).toEqual([reconstructed]);
        expect(reconstructed.items).toEqual(items);
        checkpoint = changes.checkpoint;
        patchBytes += Buffer.byteLength(JSON.stringify(response));
        completeBytes += Buffer.byteLength(JSON.stringify(legacy));
      }
      expect(patchBytes).toBeLessThan(32 * 4096);
      expect(patchBytes).toBeLessThan(completeBytes / 50);
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(id, 'apply_action', {
          action: { kind: 'finish-assistant', turnId: turn.id, endedAt: 42 },
        })
      ).toMatchObject({ success: true });
      const sealed = SessionHistoryChangesSchema.parse(
        (
          await fixture.rpc.readSessionHistoryForRpc(id, {
            kind: 'readChanges',
            checkpoint,
            includeBodiesFrom: 0,
            withPatches: true,
          })
        ).result
      );
      expect(sealed).toMatchObject({
        state: 'ready',
        bodies: { changed: [{ finished: true, endedAt: 42 }] },
      });
      if (sealed.state !== 'ready') throw new Error('Expected sealed fallback');
      expect(sealed.patches).toBeUndefined();
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(id, 'apply_action', {
          action: {
            kind: 'assistant-items',
            turnId: turn.id,
            mode: 'replace',
            items: [tool, { type: 'text', text: 'late state correction' }],
          },
        })
      ).toMatchObject({ success: true });
      const state = SessionHistoryChangesSchema.parse(
        (
          await fixture.rpc.readSessionHistoryForRpc(id, {
            kind: 'readChanges',
            checkpoint: sealed.checkpoint,
            includeBodiesFrom: 0,
            withPatches: true,
          })
        ).result
      );
      expect(state).toMatchObject({
        state: 'ready',
        bodies: { changed: [{ items: [tool, { type: 'text', text: 'late state correction' }] }] },
      });
      if (state.state !== 'ready') throw new Error('Expected state fallback');
      expect(state.patches).toBeUndefined();
      expect(
        (
          await fixture.rpc.readSessionHistoryForRpc(id, {
            kind: 'readChanges',
            checkpoint: 'unrecognized-checkpoint',
            withPatches: true,
          })
        ).result
      ).toMatchObject({ state: 'reset' });
    } finally {
      await fixture.close();
    }
  });

  it('recovers coalesced patches after reopen and projects derived fields through complete reads', async () => {
    let fixture = await nativeFixture();
    const initial = {
      ...nativeAssistant('reopened-patches'),
      items: [
        { type: 'text' as const, text: 'a🙂bc🚀d' },
        { type: 'text' as const, text: 'remove' },
      ],
    };
    await fixture.backend.appendHistoryTurn(initial);
    const checkpoint = await fixture.backend.history.getCheckpoint!();
    for (const items of [
      [{ type: 'text' as const, text: 'a🙂XYZ🚀d' }],
      [
        { type: 'text' as const, text: 'a🙂XYZ🚀d尾' },
        { type: 'text' as const, text: 'added' },
      ],
    ])
      await fixture.backend.applyHistoryAction({
        kind: 'assistant-items',
        turnId: initial.id,
        mode: 'replace',
        items,
      });
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    fixture = await nativeFixture(sessionId);
    const changes = await fixture.backend.history.readChanges!(checkpoint, { withPatches: true });
    if (changes.state !== 'ready' || !changes.patches)
      throw new Error('Expected reopened native patches');
    const expected = applySessionHistoryPatches(initial, changes.patches.turns[0]!.operations);
    expect(await fixture.backend.readTurn(initial.id)).toEqual({ state: 'ready', turn: expected });
    await fixture.backend.applyHistoryAction({
      kind: 'assistant-file-diff',
      turnId: initial.id,
      change: { kind: 'clear' },
    });
    const derived = await fixture.backend.history.readChanges!(changes.checkpoint, {
      withPatches: true,
    });
    expect(derived).toMatchObject({ state: 'ready', ids: [initial.id] });
    if (derived.state !== 'ready') throw new Error('Expected derived-field changes');
    expect(derived.patches).toBeUndefined();
    expect(await fixture.backend.readTurn(initial.id)).toMatchObject({
      state: 'ready',
      turn: { fileDiff: [] },
    });
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

  it('reads legacy whole-message states across reopen and converts only the next mutation', async () => {
    let fixture = await nativeFixture();
    const turn = {
      ...nativeAssistant('legacy-state'),
      finished: true,
      items: [{ type: 'text' as const, text: 'sealed body' }],
    };
    await fixture.backend.appendHistoryTurn(turn);
    const legacy = { ...turn, items: [{ type: 'text' as const, text: 'legacy correction' }] };
    const batch = NodeLodyHistory.prototype.commitHistoryBatch;
    const previous = vi
      .spyOn(NodeLodyHistory.prototype, 'commitHistoryBatch')
      .mockImplementation(async function (batchId, commands, options) {
        return batch.call(
          this,
          batchId,
          commands.map((command) =>
            command.type === 'accept' && command.identity.segmentId.startsWith('state:')
              ? { ...command, content: encodeRoostContent(legacy) }
              : command
          ),
          options
        );
      });
    try {
      await fixture.backend.applyHistoryAction({
        kind: 'assistant-items',
        turnId: turn.id,
        mode: 'replace',
        items: legacy.items,
      });
    } finally {
      previous.mockRestore();
    }
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    fixture = await nativeFixture(sessionId);
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({ state: 'ready', turn: legacy });
    const items = [{ type: 'text' as const, text: 'next correction 🙂' }];
    await fixture.backend.applyHistoryAction({
      kind: 'assistant-items',
      turnId: turn.id,
      mode: 'replace',
      items,
    });
    await fixture.close();
    fixture = await nativeFixture(sessionId);
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { ...legacy, items },
    });
  });

  it('keeps post-seal state updates bounded and recovers a lost first-state reply', async () => {
    const fixture = await nativeFixture();
    const untouched = 'sealed synthetic tool body '.repeat(16384);
    const tool = {
      type: 'tool_call' as const,
      toolCallId: 'large-tool',
      status: 'completed' as const,
      title: 'Synthetic tool',
      rawOutput: { text: untouched },
    };
    const turn = {
      ...nativeAssistant('sealed-state-budget'),
      items: [tool, { type: 'text' as const, text: 'base🙂' }],
    };
    let primaryId: Uint8Array | undefined;
    const accept = NodeLodyHistory.prototype.acceptToView;
    const capture = vi
      .spyOn(NodeLodyHistory.prototype, 'acceptToView')
      .mockImplementation(async function (...args) {
        const result = await accept.apply(this, args);
        if (args[0].input.businessId === turn.id) primaryId = result.turnId.slice();
        return result;
      });
    try {
      await fixture.backend.appendHistoryTurn(turn);
    } finally {
      capture.mockRestore();
    }
    if (!primaryId) throw new Error('Expected primary');
    await fixture.backend.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: turn.id,
      endedAt: 42,
    });
    const updates = async () => {
      const dbPath = join(nativeDirectory, 'history.db');
      const seed = await loadRoostOwnerSeedLegacy(dbPath);
      const reader = new RoostNativeClient({
        dbPath,
        seed,
        allowedOwners: [Identity.fromSeed(seed).owner()],
        maxQueuedRequests: 32,
        maxQueuedBytes: 8 * 1024 * 1024,
      });
      try {
        await reader.ready;
        const stream = reader.stream(`lody-session:${fixture.doc.sessionId}`);
        const headers = await stream.latestTurnHeaders(256n);
        expect(headers.length).toBeLessThan(256);
        const rows: { key: Buffer; value: Buffer }[] = [];
        for (const header of headers) {
          expect(header.nextSeq).toBeLessThan(4096n);
          for (let seq = 0n; seq < header.nextSeq; seq++) {
            const value = Buffer.from(await stream.exportUpdates(header.turnId, seq, 1n));
            expect(decodeBatch(value)).toHaveLength(1);
            const key = Buffer.alloc(24);
            key.set(header.turnId);
            key.writeBigUInt64BE(seq, 16);
            rows.push({ key, value });
          }
        }
        return rows;
      } finally {
        await reader.close();
      }
    };
    const before = new Map((await updates()).map((row) => [row.key.toString('hex'), row.value]));
    expect(before.size).toBeGreaterThan(0);
    let items = turn.items;
    const batch = NodeLodyHistory.prototype.commitHistoryBatch;
    const lost = vi
      .spyOn(NodeLodyHistory.prototype, 'commitHistoryBatch')
      .mockImplementationOnce(async function (...args) {
        await batch.apply(this, args);
        throw new Error('Lost first-state reply');
      });
    items = [tool, { type: 'text', text: 'base🙂🚀' }];
    try {
      await expect(
        fixture.backend.applyHistoryAction({
          kind: 'assistant-items',
          turnId: turn.id,
          mode: 'replace',
          items,
        })
      ).rejects.toThrow('Lost first-state reply');
    } finally {
      lost.mockRestore();
    }
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items },
    });
    for (let step = 1; step < 32; step++) {
      items = [tool, { type: 'text', text: `base🙂${'🚀'.repeat(step + 1)}` }];
      await fixture.backend.applyHistoryAction({
        kind: 'assistant-items',
        turnId: turn.id,
        mode: 'replace',
        items,
      });
    }
    await fixture.backend.flushLocalWrites();
    const after = await updates();
    for (const row of after) {
      const old = before.get(row.key.toString('hex'));
      if (old) expect(row.value.equals(old)).toBe(true);
    }
    expect(after.filter((row) => before.has(row.key.toString('hex'))).length).toBe(before.size);
    const added = after.filter((row) => !before.has(row.key.toString('hex')));
    expect(added.length).toBeGreaterThan(0);
    expect(added.reduce((sum, row) => sum + row.value.length, 0)).toBeLessThan(128 * 1024);
    for (const row of added) {
      expect(row.key.subarray(0, 16).equals(Buffer.from(primaryId))).toBe(false);
      expect(row.value.length).toBeLessThan(16 * 1024);
    }
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(sessionId);
    expect(await reopened.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items, finished: true, endedAt: 42 },
    });
    expect((await reopened.backend.readHistory()).length).toBe(1);
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

  it.each([1, 3])(
    'never replays an applied append after %i publication CAS failures',
    async (failures) => {
      const fixture = await nativeFixture();
      await fixture.backend.appendHistoryTurn({
        ...nativeAssistant('publish-once'),
        finished: true,
        items: [{ type: 'text', text: 'base' }],
      });
      const publish = RoostHistoryHead.prototype.publish;
      let remaining = failures;
      const spy = vi.spyOn(RoostHistoryHead.prototype, 'publish').mockImplementation(function (
        ...args
      ) {
        if (remaining-- > 0)
          return Promise.reject(
            Object.assign(new Error('Synthetic publication race'), { code: 'stale' })
          );
        return publish.apply(this, args);
      });
      try {
        const append = fixture.backend.applyHistoryAction({
          kind: 'assistant-items',
          turnId: 'publish-once',
          mode: 'append',
          items: [{ type: 'text', text: 'once' }],
        });
        if (failures === 1) await append;
        else await expect(append).rejects.toMatchObject({ code: 'publication_stale' });
      } finally {
        spy.mockRestore();
      }
      const read = await fixture.backend.readTurn('publish-once');
      if (read.state !== 'ready') throw new Error('Committed body unavailable');
      expect(
        read.turn.items
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('')
      ).toBe('baseonce');
      expect(await fixture.backend.history.getPublication!()).toMatchObject({ historyCount: 1 });
    }
  );

  it('invalidates an older loaded page after another owner changes it without reading that page again', async () => {
    const id = `outside-window-${ordinal++}`;
    const root = `lody-session:${id}`;
    const hint = Promise.withResolvers<void>();
    let after: bigint | undefined;
    let native!: RoostNativeClient;
    let tapped = false;
    const onChanges = RoostNativeClient.prototype.onChanges;
    const tap = vi
      .spyOn(RoostNativeClient.prototype, 'onChanges')
      .mockImplementation(function (stream, listener, options) {
        if (stream !== root || tapped) return onChanges.call(this, stream, listener, options);
        tapped = true;
        native = this;
        return onChanges.call(
          this,
          stream,
          (cursor, indexChange) => {
            listener(cursor, indexChange);
            if (after !== undefined && cursor !== null && cursor > after) hint.resolve();
          },
          options
        );
      });
    const source = await nativeFixture(id);
    tap.mockRestore();
    for (let i = 0; i < 45; i++) await source.backend.appendHistoryTurn(nativeUser(`outside-${i}`));
    await source.backend.history.readRange(0, 1);
    const changes: { kind: string; from?: number; ids?: readonly string[] }[] = [];
    const observation = source.backend.history.observe((change) => changes.push(change));
    await observation.initial;
    const events = await native.stream(root).eventsAfter(0n, 1000n);
    after = events.at(-1)?.cursor ?? 0n;
    const peer = await nativeFixture(id);
    try {
      await peer.backend.applyHistoryAction({
        kind: 'user-status',
        turnId: 'outside-0',
        status: 'seen',
      });
      await hint.promise;
      await source.backend.flushLocalWrites();
      expect(
        changes.some((change) =>
          change.kind === 'changed' ? change.ids?.includes('outside-0') : change.from === 0
        )
      ).toBe(true);
      expect(await source.backend.readTurn('outside-0')).toMatchObject({
        state: 'ready',
        turn: { status: 'seen' },
      });
    } finally {
      observation.unsubscribe();
      await peer.close();
      await source.close();
    }
  });

  it('does not replay an ordinary command after a committed content reply is superseded', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('commit-once'),
      items: [{ type: 'text', text: 'base' }],
    });
    const commit = RoostHistoryGeneration.prototype.commitPatches;
    const spy = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementationOnce(async function (...args) {
        await commit.apply(this, args);
        throw Object.assign(new Error('Synthetic projection supersession'), { code: 'stale' });
      });
    try {
      await expect(
        fixture.backend.applyHistoryAction({
          kind: 'assistant-items',
          turnId: 'commit-once',
          mode: 'append',
          items: [{ type: 'text', text: 'once' }],
        })
      ).rejects.toMatchObject({ code: 'write_stale' });
    } finally {
      spy.mockRestore();
    }
    const read = await fixture.backend.readTurn('commit-once');
    if (read.state !== 'ready') throw new Error('Committed body unavailable');
    expect(
      read.turn.items
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('')
    ).toBe('baseonce');
  });

  it('republishes a committed history correction after its Native head write fails', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('cursor-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('cursor-a'));
    const before = await fixture.backend.history.getPublication!();
    const spy = vi
      .spyOn(RoostHistoryHead.prototype, 'publish')
      .mockRejectedValueOnce(new Error('Injected head failure'));
    await expect(
      fixture.backend.applyHistoryAction({
        kind: 'user-status',
        turnId: 'cursor-u',
        status: 'seen',
      })
    ).rejects.toThrow('Injected head failure');
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
    expect((await fixture.backend.history.getPublication!()).historyRevision).toBeGreaterThan(
      before.historyRevision
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

  it('reads a persisted old goal without history bodies and returns an isolated goal', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const goal = {
      type: 'goal' as const,
      threadId: 'old',
      objective: 'Retain',
      status: 'active' as const,
    };
    await fixture.backend.appendHistoryTurn({ ...nativeAssistant('old-goal'), items: [goal] });
    for (let i = 0; i < 45; i++) await fixture.backend.appendHistoryTurn(nativeUser(`plain-${i}`));
    await fixture.close();
    fixture = await nativeFixture(id);
    const readGoal = fixture.backend.readLatestGoal;
    if (!readGoal) throw new Error('Missing Native goal query');
    const full = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
      .mockRejectedValue(new Error('body unavailable'));
    const page = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage')
      .mockRejectedValue(new Error('body unavailable'));
    try {
      const actual = await readGoal();
      expect(actual).toEqual(goal);
      if (actual) actual.objective = 'caller mutation';
      expect(await readGoal()).toEqual(goal);
    } finally {
      full.mockRestore();
      page.mockRestore();
    }
  });

  it('scans an unknown goal projection through state overlays without retaining old bodies or publishing it', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const goal = (status: 'active' | 'paused'): SessionGoalMessage => ({
      type: 'goal',
      threadId: 'scan',
      objective: 'Retain',
      status,
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('first-goal'),
      items: [goal('active')],
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('newer-goal'),
      items: [goal('active')],
    });
    for (let i = 0; i < 45; i++)
      await fixture.backend.appendHistoryTurn(nativeUser(`scan-plain-${i}`));
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: { ...nativeAssistant('newer-goal'), items: [goal('paused')] } as never,
    });
    const reference = resolveLatestSessionGoalFromHistory(await fixture.backend.readHistory());
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'history.db'),
      seed,
      allowedOwners: [Identity.fromSeed(seed).owner()],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    await client.ready;
    const host = client.stream(`lody-session:${id}`);
    const key = { table: 'lody_goal_projection_v1', key: new Uint8Array() };
    const invalid = new TextEncoder().encode('{invalid');
    try {
      await host.writeBatch([], { indexPuts: [{ ...key, value: invalid }] });
      await fixture.close();
      fixture = await nativeFixture(id);
      const readGoal = fixture.backend.readLatestGoal;
      if (!readGoal) throw new Error('Missing Native goal query');
      const full = vi
        .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
        .mockRejectedValue(new Error('whole read forbidden'));
      try {
        expect(await readGoal()).toEqual(reference);
        expect(await host.readIndex([key])).toEqual([invalid]);
        const body = new Error('old body unavailable');
        const page = vi
          .spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage')
          .mockRejectedValue(body);
        const indexed = vi
          .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
          .mockRejectedValue(body);
        try {
          expect(await readGoal()).toEqual(reference);
          await expect(fixture.backend.history.readAt(0)).rejects.toBe(body);
          expect(await fixture.backend.history.readAt(46)).toMatchObject({
            state: 'ready',
            turn: { id: 'scan-plain-44' },
          });
        } finally {
          page.mockRestore();
          indexed.mockRestore();
        }
      } finally {
        full.mockRestore();
      }
    } finally {
      await client.close();
    }
  });

  it('preserves GC metadata fallback, non-active overrides and read failures', async () => {
    const fixture = await nativeFixture();
    const legacy: SessionGoalMessage = {
      type: 'goal',
      threadId: 'legacy',
      objective: 'Retain',
      status: 'active',
    };
    const ports = {
      workspaceDocument: {
        getOrCreateSessionDoc: async () => ({ getMetaState: async () => ({ latestGoal: legacy }) }),
      },
      getSessionBackend: async () => fixture.backend,
    };
    const receiver = ports as unknown as MessageHandler;
    expect(await MessageHandler.prototype.hasActiveGoal.call(receiver, fixture.doc.sessionId)).toBe(
      true
    );
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('cleared-goal'),
      items: [{ ...legacy, status: 'cleared' }],
    });
    expect(await MessageHandler.prototype.hasActiveGoal.call(receiver, fixture.doc.sessionId)).toBe(
      false
    );
    const failure = new Error('goal read failed');
    const failed = {
      ...ports,
      getSessionBackend: async () => ({
        readLatestGoal: async () => {
          throw failure;
        },
      }),
    } as unknown as MessageHandler;
    await expect(
      MessageHandler.prototype.hasActiveGoal.call(failed, fixture.doc.sessionId)
    ).rejects.toBe(failure);
    const rpc = {
      ...ports,
      getSessionBackend: async () => ({
        readLatestGoal: async () => ({ ...legacy, status: 'paused' }),
      }),
    } as unknown as MessageHandler;
    expect(await MessageHandler.prototype.hasActiveGoal.call(rpc, fixture.doc.sessionId)).toBe(
      false
    );
  });

  it('keeps goal queries current after goal commands, removal, copying and reopen', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const goal = (threadId: string): SessionGoalMessage => ({
      type: 'goal',
      threadId,
      objective: 'Retain',
      status: 'active',
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('goal-older'),
      items: [goal('older')],
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('goal-newer'),
      items: [goal('newer')],
    });
    const assertCurrent = async () => {
      if (!fixture.backend.readLatestGoal) throw new Error('Missing Native goal query');
      expect(await fixture.backend.readLatestGoal()).toEqual(
        resolveLatestSessionGoalFromHistory(await fixture.backend.readHistory())
      );
    };
    await assertCurrent();
    await fixture.backend.applyHistoryAction({
      kind: 'clear-goal',
      threadId: 'newer',
      updatedAt: 1,
    });
    await assertCurrent();
    expect(await fixture.backend.readLatestGoal?.()).toMatchObject({
      threadId: 'newer',
      status: 'cleared',
    });
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-goal',
      goal: { ...goal('newer'), status: 'paused' },
      fallback: nativeAssistant('fallback') as never,
    });
    await assertCurrent();
    const copy = await fixture.backend.captureForkSnapshot();
    const destination = await nativeFixture();
    await destination.backend.importForkHistory(copy, copy.history);
    expect(await destination.backend.readLatestGoal?.()).toMatchObject({
      threadId: 'newer',
      status: 'paused',
    });
    await fixture.close();
    fixture = await nativeFixture(id);
    await assertCurrent();
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'goal-newer' });
    await assertCurrent();
    expect(await fixture.backend.readLatestGoal?.()).toMatchObject({
      threadId: 'older',
      status: 'active',
    });
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'goal-older' });
    await assertCurrent();
    expect(await fixture.backend.readLatestGoal?.()).toBeNull();
  });

  it('retries goal inspection when an older goal changes in place between pages', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const goal: SessionGoalMessage = {
      type: 'goal',
      threadId: 'raced',
      objective: 'Retain',
      status: 'paused',
    };
    await fixture.backend.appendHistoryTurn({ ...nativeAssistant('raced-goal'), items: [goal] });
    for (let i = 0; i < 45; i++)
      await fixture.backend.appendHistoryTurn(nativeUser(`raced-plain-${i}`));
    await fixture.close();
    await invalidateGoalIndex(id);
    fixture = await nativeFixture(id);
    const peer = await nativeFixture(fixture.doc.sessionId);
    const readPage = RoostDispatchIndex.prototype.range;
    let changed = false;
    vi.spyOn(RoostDispatchIndex.prototype, 'range').mockImplementation(async function (...args) {
      const page = await readPage.apply(this, args);
      if (!changed) {
        changed = true;
        await peer.backend.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            ...nativeAssistant('raced-goal'),
            items: [{ ...goal, status: 'active' }],
          } as never,
        });
      }
      return page;
    });
    expect(await fixture.backend.readLatestGoal?.()).toEqual({ ...goal, status: 'active' });
    expect(changed).toBe(true);
    expect(await fixture.backend.readLatestGoal?.()).toEqual({ ...goal, status: 'active' });
  });

  it('rechecks the history generation when goal inspection races an index-only activation', async () => {
    const id = `native-goal-pointer-${ordinal++}`;
    let client: RoostNativeClient | undefined;
    const onChanges = RoostNativeClient.prototype.onChanges;
    const capture = vi.spyOn(RoostNativeClient.prototype, 'onChanges').mockImplementation(function (
      ...args
    ) {
      client = this;
      return onChanges.apply(this, args);
    });
    const fixture = await nativeFixture(id);
    capture.mockRestore();
    if (!client) throw new Error('Expected Native history owner');
    for (let i = 0; i < 45; i++)
      await fixture.backend.appendHistoryTurn(nativeUser(`goal-pointer-old-${i}`));
    const goal: SessionGoalMessage = {
      type: 'goal',
      threadId: 'activated',
      objective: 'Keep active',
      status: 'active',
    };
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const generation = new RoostHistoryGeneration(client, Identity.fromSeed(seed).owner(), id);
    await generation.replace(
      [{ ...nativeAssistant('goal-pointer-new'), items: [goal] }],
      'goal-pointer-stage'
    );
    const raw = client.stream(`lody-session:${id}`);
    const pointer = { table: 'lody_history_generation_v1', key: new TextEncoder().encode('next') };
    const [activation] = await raw.readIndex([pointer]);
    if (!activation) throw new Error('Expected staged activation');
    await raw.compareAndWriteIndex(
      [{ ...pointer, value: activation }],
      [{ ...pointer, value: null }]
    );
    await fixture.close();
    await invalidateGoalIndex(id);
    let armed = false;
    vi.spyOn(RoostNativeClient.prototype, 'onChanges').mockImplementation(
      function (stream, listener, options) {
        client = this;
        return onChanges.call(
          this,
          stream,
          (cursor, key) => {
            if (!armed) listener(cursor, key);
          },
          options
        );
      }
    );
    const reopened = await nativeFixture(id);
    await reopened.backend.flushLocalWrites();
    const readPage = NodeLodyHistory.prototype.readActiveBranchMembers;
    let switched = false;
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMembers').mockImplementation(
      async function (...args) {
        const result = await readPage.apply(this, args);
        if (armed && !switched) {
          switched = true;
          const before = await this.observedEventCursor();
          await this.stream.compareAndWriteIndex(
            [{ ...pointer, value: null }],
            [{ ...pointer, value: activation }]
          );
          expect(await this.observedEventCursor()).toBe(before);
        }
        return result;
      }
    );
    armed = true;
    try {
      expect(await reopened.backend.readLatestGoal?.()).toEqual(goal);
      expect(switched).toBe(true);
      expect(await reopened.backend.readLatestGoal?.()).toEqual(goal);
    } finally {
      armed = false;
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
    await first.backend.appendHistoryTurn({
      ...nativeAssistant('concurrent-tail-a'),
      items: [{ type: 'text', text: 'start' }],
    });
    // Prime an applied content/goal checkpoint, then race its reuse in the next
    // command. A matching cached cursor must not hide a subsequent peer event.
    await first.backend.applyAgentBatch({
      targetAssistantEntryId: 'concurrent-tail-a',
      operationIds: ['concurrent-goal-prime'],
      contents: [{ type: 'text', text: 'warm' }],
    });
    const peer = await nativeFixture(first.doc.sessionId);
    const original = RoostHistoryGeneration.prototype.commitPatches;
    let injected = false;
    const spy = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementation(async function (...args) {
        const result = await original.apply(this, args);
        if (!injected) {
          injected = true;
          expect(result.derivedIndexesApplied).toBe(true);
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
      await first.backend.applyAgentBatch({
        targetAssistantEntryId: 'concurrent-tail-a',
        operationIds: ['concurrent-goal-append'],
        contents: [{ type: 'text', text: '🙂' }],
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
      'concurrent-tail-a',
    ]);
  });

  it('refreshes the same-session prefix edit after its committed activation loses the reply', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('lost-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('lost-a'));
    const original = RoostHistoryGeneration.prototype.replaceMembers;
    const spy = vi
      .spyOn(RoostHistoryGeneration.prototype, 'replaceMembers')
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
    expect(await fixture.backend.history.getPublication!()).toMatchObject({ historyCount: 1 });
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
    const permissionCheckpoint = await fixture.backend.history.getCheckpoint!();
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
    const permissionChanges = await fixture.backend.history.readChanges!(permissionCheckpoint, {
      withPatches: true,
    });
    expect(permissionChanges.state).toBe('ready');
    if (permissionChanges.state !== 'ready') throw new Error('Expected permission changes');
    expect(permissionChanges.patches).toBeUndefined();
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
    const original = RoostNativeClient.prototype.request;
    let stages = 0;
    const spy = vi
      .spyOn(RoostNativeClient.prototype, 'request')
      .mockImplementation(async function (input, options) {
        if (input.method === 'writeBatch' && input.requireLocalInterval === true && ++stages === 2)
          throw new Error('Injected stage failure');
        return original.call(this, input, options);
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
      expect(await target.backend.history.getPublication!()).toMatchObject({ historyCount: 5 });
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

  it.each([
    { lostNativeReply: false, lostReadReplies: 0 },
    { lostNativeReply: true, lostReadReplies: 0 },
    { lostNativeReply: true, lostReadReplies: 2 },
  ])(
    'updates two independent renderer replicas through encrypted RPC without control hints (lostNativeReply=$lostNativeReply, lostReadReplies=$lostReadReplies)',
    async ({ lostNativeReply, lostReadReplies }) => {
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
      const replyStarted = Promise.withResolvers<void>();
      const releaseReply = Promise.withResolvers<void>();
      let holdNextReply = false;
      const streams: LoroStreamsJsonStreamClient = {
        ensureJsonStream: async () => undefined,
        appendJson: async (streamId, value) => {
          if (
            holdNextReply &&
            streamId.includes(':rpc:res') &&
            typeof value === 'object' &&
            value !== null &&
            'method' in value &&
            value.method === 'session/history-write'
          ) {
            holdNextReply = false;
            replyStarted.resolve();
            await releaseReply.promise;
          }
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
      let receivedContentPatches = false;
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
        const remainingReadFailures = peerDocs.map(() => 0);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        type Timer = Parameters<typeof clearTimeout>[0];
        const recoveryTimers = new Map<Timer, () => void>();
        const watchTimeouts = new Map<Timer, () => void>();
        let timerReady = Promise.withResolvers<void>();
        const setTimer = globalThis.setTimeout;
        const clearTimer = globalThis.clearTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
          const scheduled =
            // The two lost reads below need both the first and second retry.
            // Do not drive longer timers that also serve as RPC deadlines.
            args[1] === 0 || args[1] === 500 || args[1] === 1_000
              ? recoveryTimers
              : args[1] === 15_000
                ? watchTimeouts
                : undefined;
          if (!scheduled) return setTimer(...args);
          const run = () => {
            if (!scheduled.delete(timer)) return;
            clearTimer(timer);
            args[0](...args.slice(2));
          };
          const timer = setTimer(run, args[1]);
          scheduled.set(timer, run);
          if (scheduled === recoveryTimers) timerReady.resolve();
          return timer;
        });
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
          recoveryTimers.delete(timer);
          watchTimeouts.delete(timer);
          clearTimer(timer);
        });
        const driveRecoveryUntil = async (completed: Promise<unknown>) => {
          for (;;) {
            const outcome = await Promise.race([
              completed.then(() => 'completed' as const),
              (recoveryTimers.size ? Promise.resolve() : timerReady.promise).then(
                () => 'recovery' as const
              ),
            ]);
            if (outcome === 'completed') return;
            timerReady = Promise.withResolvers<void>();
            // Nested zero-delay timers can land at fake now + 1. Drive live
            // callbacks, not requested delays, without expiring RPC deadlines.
            recoveryTimers.values().next().value?.();
          }
        };
        for (const [index, peerDoc] of peerDocs.entries()) {
          const peer = createRemoteRoostSessionDataFactory({
            accountId: `synthetic-peer-${index}`,
            workspaceId,
            machineId,
            incremental: true,
            watch: true,
            patches: index === 0,
            requestHistoryRead: async (_machine, id, query) => {
              if (query.kind === 'watchChanges' || query.kind === 'readChanges')
                expect(query.withPatches).toBe(index === 0 ? true : undefined);
              const result = await client.requestSessionHistoryRead({ sessionId: id, query });
              if (!result) throw new Error('Missing history read response');
              const remaining = remainingReadFailures[index] ?? 0;
              if (query.kind === 'watchChanges' && remaining > 0) {
                remainingReadFailures[index] = remaining - 1;
                throw new Error('Synthetic history read reply loss');
              }
              if (query.kind === 'watchChanges' || query.kind === 'readChanges') {
                const changes = SessionHistoryChangesSchema.parse(result.result);
                if (changes.state === 'ready' && changes.patches) {
                  expect(index).toBe(0);
                  receivedContentPatches = true;
                }
              }
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
        await driveRecoveryUntil(parked.promise);
        expect(watchTimeouts.size).toBe(2);
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
        remainingReadFailures.fill(lostReadReplies);
        if (lostNativeReply) {
          // A committed write whose reply is lost can miss the owner wakeup.
          // Release the already parked watches through their timeout callback:
          // fake time must not leave this production recovery path frozen, and
          // advancing the global clock could expire unrelated RPC deadlines.
          [...watchTimeouts.values()].forEach((expire) => expire());
        }
        await driveRecoveryUntil(Promise.all(visible.map((result) => result.promise)));
        expect(remainingReadFailures).toEqual([0, 0]);
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
        if (!lostNativeReply) expect(receivedContentPatches).toBe(true);
        // Force a reply to overlap teardown rather than relying on native I/O timing.
        holdNextReply = true;
        const finalWrite = client.requestSessionHistoryWrite({
          sessionId,
          operation: 'apply_action',
          payload: { action: { kind: 'user-status', turnId: 'replica-user', status: 'handled' } },
        });
        await replyStarted.promise;
        stops.forEach((stop) => stop());
        peers.forEach((peer) => peer.dispose?.());
        server.stop();
        releaseReply.resolve();
        // Keep the response receiver alive until in-flight server replies settle.
        // Removing it first makes appendResponse retry on a frozen fake timer.
        await Promise.all(
          (server as unknown as { inFlightRequests: Set<Promise<void>> }).inFlightRequests
        );
        expect(await finalWrite).toMatchObject({ success: true });
        client.stop();
        vi.restoreAllMocks();
        vi.useRealTimers();
        await fixture.close();
        const reopened = await nativeFixture(sessionId);
        expect(await reopened.backend.readTurn(assistantId)).toMatchObject({
          state: 'ready',
          turn: expected,
        });
        expect(await reopened.backend.readHistoryCount()).toBe(2);
        expect(await reopened.backend.readTurn('replica-user')).toMatchObject({
          state: 'ready',
          turn: { status: 'handled' },
        });
      } finally {
        stops.forEach((stop) => stop());
        peers.forEach((peer) => peer.dispose?.());
        server.stop();
        releaseReply.resolve();
        // Keep the response receiver alive until in-flight server replies settle.
        // Removing it first makes appendResponse retry on a frozen fake timer.
        await Promise.all(
          (server as unknown as { inFlightRequests: Set<Promise<void>> }).inFlightRequests
        );
        client.stop();
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
    expect(fixture.doc.handle!.doc.getMap('roostHistoryCursor').get('operationId')).toBeUndefined();
    const progress = await fixture.backend.history.getPublication!();
    expect(progress).toMatchObject({
      historyCount: 1,
      historyChange: { kind: 'changed', ids: ['retry-a'] },
    });
    expect(progress.checkpoint).toBeTruthy();
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
    const fixture = await nativeFixture(randomUUID());
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
    const dbPath = join(nativeDirectory, 'history.db');
    const seed = await loadRoostOwnerSeedLegacy(dbPath);
    const reader = new RoostNativeClient({
      dbPath,
      seed,
      allowedOwners: [Identity.fromSeed(seed).owner()],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    try {
      await reader.ready;
      const stream = reader.stream(`lody-session:${fixture.doc.sessionId}`);
      const headers = await stream.latestTurnHeaders(256n);
      expect(headers.length).toBeLessThan(256);
      expect(headers.reduce((count, header) => count + header.nextSeq, 0n)).toBeGreaterThan(128n);
      let updateBytes = 0;
      for (const header of headers) {
        expect(header.nextSeq).toBeLessThan(4096n);
        const exported = await stream.exportUpdates(header.turnId, 0n, 4096n);
        expect(BigInt(decodeBatch(exported).length)).toBe(header.nextSeq);
        updateBytes += exported.byteLength;
      }
      // Measure decoded/exported history: compression must not conceal repeated
      // full-body updates or dropped idempotency records behind fewer SQL rows.
      expect(updateBytes).toBeGreaterThan(0);
      expect(updateBytes).toBeLessThan(1024 * 1024);
      const receipts = await stream.scanIndex(AGENT_RECEIPTS_TABLE, new Uint8Array(), 129n);
      expect(receipts).toHaveLength(128);
      expect(
        receipts.reduce((bytes, row) => bytes + row.key.byteLength + row.value.byteLength, 0)
      ).toBe(128 * 82);
    } finally {
      await reader.close();
    }
    // A second SQLite library must not open/close the live Native-owned file in
    // this process: its close() can cancel the other library's POSIX file locks.
    const projection = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { DatabaseSync } from 'node:sqlite';
           const db = new DatabaseSync(process.argv[1], { readOnly: true });
           try {
             const row = db.prepare('SELECT COUNT(*) AS count FROM roost_kv JOIN roost_spaces ON roost_spaces.id = roost_kv.space_id WHERE name LIKE ?').get('%' + process.argv[2] + '%:projection');
             process.stdout.write(JSON.stringify(row));
           } finally { db.close(); }`,
          dbPath,
          fixture.doc.sessionId,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
    ) as { count: number };
    expect(projection.count).toBeGreaterThan(0);
    expect(projection.count).toBeLessThan(1000);
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

describe('Production Roost compact agent receipts', () => {
  it('preserves exact identity and digest bytes, rejecting malformed receipts instead of falling through', async () => {
    const seed = new Uint8Array(32).fill(47);
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'receipt-encoding.db'),
      seed,
      allowedOwners: [owner],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    try {
      await client.ready;
      const generation = new RoostHistoryGeneration(client, owner, 'receipt-encoding');
      const identity: HistoryIdentity = {
        kind: 'publication',
        businessId: 'abcdef01-2345-6789-abcd-ef0123456789',
        segmentId: `agent:${'ab'.repeat(32)}`,
      };
      const identities = [
        identity,
        { ...identity, businessId: identity.businessId.toUpperCase() },
        { ...identity, businessId: `${identity.businessId}\n` },
        { ...identity, segmentId: `${identity.segmentId}\n` },
        { ...identity, segmentId: identity.segmentId.toUpperCase() },
        ...['non-uuid', '🙂', 'a\u0000b'].map((businessId) => ({
          ...identity,
          businessId,
        })),
        { ...identity, businessId: identity.businessId.replace('abcdef01', 'abcdef02') },
        { ...identity, segmentId: `agent:${'ab'.repeat(31)}ac` },
      ];
      const receipts = identities.map((id, index) =>
        agentReceiptPut(id, index.toString(16).padStart(64, '0'))
      );
      await generation.commitPatches([], receipts, undefined, []);
      for (const [index, id] of identities.entries())
        expect(await generation.lookupOperation(id)).toEqual({
          digest: index.toString(16).padStart(64, '0'),
        });
      expect(await generation.lookupOperation({ ...identity, kind: 'message' })).toBeUndefined();
      for (const businessId of ['\ud800', '\ud801'])
        expect(() => agentReceiptKey({ ...identity, businessId })).toThrow('unpaired surrogate');
      // Identity property order has never been significant in the canonical contract.
      expect(
        agentReceiptKey({
          segmentId: identity.segmentId,
          kind: identity.kind,
          businessId: identity.businessId,
        })
      ).toEqual(agentReceiptKey(identity));
      for (const digest of [
        '',
        'ab'.repeat(31),
        'AB'.repeat(32),
        `${'ab'.repeat(32)}\n`,
        'gg'.repeat(32),
      ])
        expect(() => agentReceiptPut(identity, digest)).toThrow('digest is invalid');
      const valid = agentReceiptPut(identity, 'ff'.repeat(32));
      expect(decodeAgentReceipt(valid.value)).toEqual({ digest: 'ff'.repeat(32) });
      for (const value of [
        new Uint8Array(),
        valid.value.slice(1),
        Buffer.concat([valid.value, Buffer.from([0])]),
        Buffer.concat([Buffer.from([1]), valid.value.slice(1)]),
        Buffer.from('{"version":1,"digest":"old"}'),
      ]) {
        await generation.host.writeBatch([], { indexPuts: [{ ...valid, value }] });
        await expect(generation.lookupOperation(identity)).rejects.toThrow('receipt is invalid');
      }
    } finally {
      await client.close();
    }
  });

  it.each(['agent', 'renderer-v1', 'renderer-v2'] as const)(
    'rejects old and mixed %s receipt formats before opening or mutating a session, without deleting data',
    async (kind) => {
      const dbPath = join(nativeDirectory, 'history.db');
      const seed = await loadRoostOwnerSeedLegacy(dbPath);
      const owner = Identity.fromSeed(seed).owner();
      const client = new RoostNativeClient({
        dbPath,
        seed,
        allowedOwners: [owner],
        maxQueuedRequests: 32,
        maxQueuedBytes: 8 * 1024 * 1024,
      });
      try {
        await client.ready;
        for (const mixed of [false, true]) {
          const id = randomUUID();
          const raw = client.stream(`lody-session:${id}`);
          const identity: HistoryIdentity = {
            kind: 'publication',
            businessId: id,
            segmentId: `agent:${'ab'.repeat(32)}`,
          };
          const previous =
            kind === 'agent'
              ? {
                  table: 'lody_agent_operation_receipts_v1',
                  key: Buffer.from(JSON.stringify(identity)),
                  value: Buffer.from(JSON.stringify({ version: 1, digest: 'cd'.repeat(32) })),
                }
              : {
                  table:
                    kind === 'renderer-v1'
                      ? 'lody_renderer_history_changes_v1'
                      : 'lody_renderer_history_changes_v2',
                  key: Buffer.alloc(8),
                  value: Buffer.from(
                    JSON.stringify({
                      version: 1,
                      scope: 'ab'.repeat(32),
                      nonce: id,
                      before: '0',
                      through: '0',
                      reset: false,
                      ids: [],
                    })
                  ),
                };
          const current = kind === 'agent' ? agentReceiptPut(identity, 'cd'.repeat(32)) : null;
          await raw.writeBatch([], {
            indexPuts: [previous, ...(mixed && current ? [current] : [])],
          });
          const scope = Buffer.alloc(32, 0xab);
          if (mixed && !current)
            await raw.annotateCommit(scope, 0n, {
              before: 0n,
              value: encodeRoostHistoryChange({ nonce: id, reset: false, ids: [] }),
            });
          const metadataBefore = await raw.readCommitMetadata(scope, 0n);
          const generation = new RoostHistoryGeneration(client, owner, id);
          const error = `Unsupported Roost ${kind === 'agent' ? 'agent' : 'renderer'} receipt format`;
          await expect(generation.resolve()).rejects.toThrow(error);
          await expect(generation.lookupOperation(identity)).rejects.toThrow(error);
          await expect(
            generation.commitPatches(
              [],
              [agentReceiptPut(identity, 'ef'.repeat(32))],
              undefined,
              []
            )
          ).rejects.toThrow(error);
          await expect(
            generation.replace([nativeUser('must-not-write')], 'must-not-activate')
          ).rejects.toThrow(error);
          await expect(nativeFixture(id)).rejects.toThrow(error);
          expect(await raw.readIndex([previous])).toEqual([new Uint8Array(previous.value)]);
          if (current)
            expect(await raw.readIndex([current])).toEqual([
              mixed ? new Uint8Array(current.value) : null,
            ]);
          expect(await raw.readCommitMetadata(scope, 0n)).toEqual(metadataBefore);
          expect(await raw.scanIndex('lody_history_generation_v1', new Uint8Array(), 1n)).toEqual(
            []
          );
        }
        const fresh = await nativeFixture();
        await fresh.backend.appendHistoryTurn(nativeUser('independent'));
        expect(await fresh.backend.readHistory()).toMatchObject([{ id: 'independent' }]);
      } finally {
        await client.close();
      }
    }
  );

  it('rolls back output and receipts together, then recovers a partially committed multi-chunk retry after reopen', async () => {
    let fixture = await nativeFixture(randomUUID());
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('atomic-output'),
      items: [{ type: 'text', text: '' }],
    });
    const checkpoint = await fixture.backend.history.getCheckpoint!();
    const original = RoostHistoryGeneration.prototype.commitPatches;
    const input = {
      targetAssistantEntryId: 'atomic-output',
      contents: Array.from({ length: 65 }, (_, i) => ({ type: 'text' as const, text: `🙂${i};` })),
      operationIds: Array.from({ length: 65 }, (_, i) => `atomic-${i}`),
    };
    const rollback = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementation(function (writes, receipts, cursor, changedIds) {
        const edit = writes.find((write) => write.kind === 'edit');
        if (!edit) throw new Error('Expected native content edit');
        return original.call(
          this,
          [...writes, { ...edit, expectedNextSeq: edit.expectedNextSeq + 100n }],
          receipts,
          cursor,
          changedIds
        );
      });
    await expect(fixture.backend.applyAgentBatch(input)).rejects.toThrow();
    rollback.mockRestore();
    expect(await fixture.backend.readTurn('atomic-output')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: '' }] },
    });
    const lostReply = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementationOnce(async function (...args) {
        await original.apply(this, args);
        throw new Error('Injected lost chunk reply');
      });
    await expect(fixture.backend.applyAgentBatch(input)).rejects.toThrow(
      'Injected lost chunk reply'
    );
    lostReply.mockRestore();
    const id = fixture.doc.sessionId;
    await fixture.close();
    fixture = await nativeFixture(id);
    await fixture.backend.applyAgentBatch(input);
    const before = await fixture.backend.readTurn('atomic-output');
    expect(before).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: input.contents.map((item) => item.text).join('') }] },
    });
    expect(await fixture.backend.history.readChanges!(checkpoint)).toMatchObject({
      state: 'ready',
      ids: ['atomic-output'],
    });
    await fixture.backend.applyAgentBatch({
      ...input,
      contents: input.contents.slice(25),
      operationIds: input.operationIds.slice(25),
    });
    expect(await fixture.backend.readTurn('atomic-output')).toEqual(before);
    await expect(
      fixture.backend.applyAgentBatch({
        ...input,
        contents: [{ type: 'text', text: 'conflict' }],
        operationIds: ['atomic-29'],
      })
    ).rejects.toThrow('identity conflict');
  });

  it('retains agent receipts across branch removal, generation replacement and reopen without reviving removed output', async () => {
    let fixture = await nativeFixture(randomUUID());
    await fixture.backend.appendHistoryTurn(nativeUser('branch-user'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('branch-assistant'));
    const input = {
      targetAssistantEntryId: 'branch-assistant',
      contents: [{ type: 'text' as const, text: 'once' }],
      operationIds: ['branch-output'],
    };
    await fixture.backend.applyAgentBatch(input);
    expect(
      await fixture.backend.replaceEditableTail({
        expectedUserTurnId: 'branch-user',
        expectedForkTurnId: undefined,
        replacement: nativeUser('replacement-user') as never,
      })
    ).toMatchObject({ status: 'accepted' });
    await fixture.backend.applyAgentBatch(input);
    expect((await fixture.backend.readHistory()).map((turn) => turn.id)).toEqual([
      'replacement-user',
    ]);
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'replacement-user' });
    const id = fixture.doc.sessionId;
    await fixture.close();
    fixture = await nativeFixture(id);
    await fixture.backend.applyAgentBatch(input);
    expect(await fixture.backend.readHistory()).toEqual([]);
    await expect(
      fixture.backend.applyAgentBatch({ ...input, contents: [{ type: 'text', text: 'conflict' }] })
    ).rejects.toThrow('identity conflict');
  });
});

describe('Production Roost immutable input acceptance', () => {
  const inputPort = (fixture: Awaited<ReturnType<typeof nativeFixture>>) => {
    const port = fixture.backend.inputAcceptance;
    if (!port) throw new Error('Expected immutable input acceptance');
    return port;
  };

  it('accepts the first input after reopen without hydrating older history pages', async () => {
    const fixture = await nativeFixture();
    const history = Array.from({ length: 81 }, (_, index) => ({
      ...nativeAssistant(`unrelated-old-${index}`),
      finished: true,
      items: [{ type: 'text' as const, text: 'Synthetic old output'.repeat(128) }],
    }));
    const hashes = history.map((entry) => hashHistoryEntryForVersion(entry as never, 2));
    expect(
      await fixture.backend.applyHistoryImport({
        mode: 'initialize',
        replay: {
          history: history as never,
          turnHashes: hashes,
          replayDigest: hashText(hashes.join('\n')),
          hashVersion: 2,
          droppedNotifications: 0,
        },
      })
    ).toMatchObject({ status: 'accepted' });
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(sessionId);
    const readPage = NodeLodyHistory.prototype.readActiveBranchPage;
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage').mockImplementation(
      function (id, options) {
        if (options.before) throw new Error('Unrelated old history is unavailable');
        return readPage.call(this, id, options);
      }
    );
    const input = nativeUser('first-input-after-reopen');
    const accept = inputPort(reopened).acceptAndDispatch;
    if (!accept) throw new Error('Expected combined input dispatch');
    expect(await accept(input)).toEqual({
      status: 'accepted',
      turnId: input.id,
      active: true,
    });
    expect(await inputPort(reopened).lookup(input)).toMatchObject({
      status: 'accepted',
      active: true,
    });
    expect((await reopened.doc.getMetaState())?.latestUserMsgId).toBe(input.id);
    expect(await reopened.backend.readHistoryCount()).toBe(history.length + 1);
    expect(await reopened.backend.readTurn(input.id)).toMatchObject({
      state: 'ready',
      turn: input,
    });
  });

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

const recoveryPerf = process.env.LODY_ROOST_RECOVERY_PERF === '1';
// Three 40-turn pages catch a full-history sweep without a large native import in CI.
const recoveryTurnCounts = recoveryPerf ? [2000] : [1, 120];

describe.each(recoveryTurnCounts)('Roost cache recovery with %i retained turns', (count) => {
  let preparedFixture: Awaited<ReturnType<typeof coldHistoryHandlerFixture>> | undefined;

  // Importing and sealing the unchanged prefix performs real native SQLite writes.
  // Only the opt-in scale test gets a larger setup budget; recovery stays at 30 seconds.
  beforeAll(
    async () => {
      const fixture = await coldHistoryHandlerFixture(1);
      preparedFixture = fixture;
      const sessionId = [...fixture.docs.keys()][0];
      if (!sessionId) throw new Error('Missing synthetic session');
      await fixture.ready(sessionId);
      if (count > 1) {
        const history = Array.from({ length: count - 1 }, (_, index) => ({
          ...nativeAssistant(`synthetic-prefix-${index}`),
          finished: true,
          items: [{ type: 'text' as const, text: `Unchanged synthetic prefix ${index}` }],
        }));
        const turnHashes = history.map((turn) => hashHistoryEntryForVersion(turn as never, 2));
        expect(
          await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'apply_import', {
            input: {
              mode: 'initialize',
              replay: {
                history,
                turnHashes,
                hashVersion: 2,
                replayDigest: hashText(turnHashes.join('\n')),
                droppedNotifications: 0,
              },
            },
          })
        ).toMatchObject({ success: true });
      }
    },
    recoveryPerf ? 120_000 : 30_000
  );

  afterAll(async () => {
    await preparedFixture?.close();
  });

  it('repairs a legacy refresh without replaying text or fetching unchanged pages', async () => {
    const rendererRequire = createRequire(
      new URL('../../../packages/components/package.json', import.meta.url)
    );
    const idb = rendererRequire('fake-indexeddb');
    vi.stubGlobal('indexedDB', new idb.IDBFactory());
    vi.stubGlobal('IDBKeyRange', idb.IDBKeyRange);
    const { createRoostHistoryCache } =
      await import('../../../packages/components/src/lib/roost-history-cache');
    const { createLocalRoostSessionDataFactory } =
      await import('../../../packages/components/src/lib/roost-session-bridge');
    const fixture = preparedFixture;
    if (!fixture) throw new Error('Missing prepared history fixture');
    const sessionId = [...fixture.docs.keys()][0];
    if (!sessionId) throw new Error('Missing synthetic session');
    const workspaceId = 'test-workspace' as WorkspaceId;
    const machineId = 'test-machine' as MachineId;
    const cache = createRoostHistoryCache(
      JSON.stringify(['local', workspaceId, machineId, sessionId])
    );
    let data: ReturnType<ReturnType<typeof createLocalRoostSessionDataFactory>> | undefined;
    let stop: (() => void) | undefined;
    const callbacks: (() => void)[] = [];
    const waiting: ((fn: () => void) => void)[] = [];
    const nextTimer = () => {
      const callback = callbacks.shift();
      return callback
        ? Promise.resolve(callback)
        : new Promise<() => void>((resolve) => waiting.push(resolve));
    };
    const enqueue = (fn: () => void) => {
      const waiter = waiting.shift();
      if (waiter) waiter(fn);
      else callbacks.push(fn);
    };
    try {
      const initial = {
        ...nativeAssistant('synthetic-late-cap'),
        items: [{ type: 'text' as const, text: 'base' }],
      };
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'append', { entry: initial })
      ).toMatchObject({ success: true });
      const page = await fixture.rpc.readSessionHistoryForRpc(sessionId, {
        kind: 'readLatestPage',
        limit: 40,
        withCheckpoint: true,
      });
      const checkpoint = (page.result as { checkpoint: string }).checkpoint;
      const initialRevision = page.historyRevision;
      if (initialRevision === undefined || !page.pageTurns)
        throw new Error('Missing initial page observation');
      const all = await fixture.rpc.readSessionHistoryForRpc(sessionId, { kind: 'readAll' });
      const entries = all.result as SessionHistoryInput[];
      expect(entries).toHaveLength(count);
      await cache.acceptPage(
        {
          checkpoint,
          startPosition: 0,
          totalCount: count,
          rows: entries.map((turn, position) => createRoostDirectoryRow(position, turn as never)),
          hasMoreOlder: false,
          cursor: null,
        },
        entries,
        initialRevision
      );
      const written = await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'apply_action', {
        action: {
          kind: 'assistant-items',
          turnId: initial.id,
          mode: 'replace',
          items: [{ type: 'text', text: 'baseA' }],
        },
      });
      expect(written.success).toBe(true);
      const revision = written.historyRevision;
      if (revision === undefined) throw new Error('Missing updated history revision');
      expect(revision).toBe(initialRevision + 1);
      const doc = new LoroDoc();
      const hints = doc.getMap('roostHistoryCursor');
      hints.set('cursor', String(revision));
      hints.set('historyRevision', revision);
      hints.set('historyCount', count);
      hints.set('historyChangeJson', JSON.stringify({ kind: 'changed', ids: [initial.id] }));
      doc.commit();
      const legacyCommitted = Promise.withResolvers<void>();
      const patchedCommitted = Promise.withResolvers<void>();
      const put = idb.IDBObjectStore.prototype.put;
      vi.spyOn(idb.IDBObjectStore.prototype, 'put').mockImplementation(function (
        value: unknown,
        ...args: unknown[]
      ) {
        const request = put.call(this, value, ...args);
        if (
          value &&
          typeof value === 'object' &&
          'revision' in value &&
          value.revision === revision &&
          (!('checkpoint' in value) ||
            value.checkpoint === undefined ||
            value.checkpoint === checkpoint)
        )
          this.transaction.addEventListener('complete', () => legacyCommitted.resolve(), {
            once: true,
          });
        return request;
      });
      const setTimer = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay: number,
        ...args: unknown[]
      ) => {
        if (delay === 0 || delay === 250) {
          enqueue(() => callback(...args));
          return callback as never;
        }
        return setTimer(callback, delay, ...args);
      }) as typeof setTimeout);
      let supports = false;
      let wake: (() => void) | undefined;
      data = createLocalRoostSessionDataFactory({
        workspaceId,
        machineId,
        incremental: () => supports,
        patches: () => supports,
        subscribeWake: (listener) => {
          wake = listener;
          return () => {
            wake = undefined;
          };
        },
        sendControl: async (request) => {
          if (request.type !== 'session/history-read') throw new Error('Unexpected write');
          if (supports) {
            expect(request.query.kind).toBe('readChanges');
            if (request.query.kind === 'readChanges')
              expect(request.query.withPatches).toBeUndefined();
          }
          return {
            ok: true,
            responses: [await fixture.rpc.readSessionHistoryForRpc(sessionId, request.query)],
          };
        },
      })({ sessionId, doc, backendKind: 'roost' });
      const observation = data.history.observe(() => {
        void cache.getHead().then((head) => {
          if (head?.checkpoint && head.checkpoint !== checkpoint && head.revision === revision)
            patchedCommitted.resolve();
        });
      });
      stop = observation.unsubscribe;
      await observation.initial;
      (await nextTimer())();
      await legacyCommitted.promise;
      expect(await cache.getHead()).toMatchObject({
        revision,
        checkpoint: undefined,
        recoveryCheckpoint: checkpoint,
      });
      expect((await cache.readRows(count - 1, count))?.[0]?.turn.items).toEqual([
        { type: 'text', text: 'baseA' },
      ]);
      supports = true;
      if (!wake) throw new Error('Missing capability wake subscription');
      wake();
      (await nextTimer())();
      await patchedCommitted.promise;
      const complete = await fixture.rpc.readSessionHistoryForRpc(sessionId, { kind: 'readAll' });
      expect((await cache.readRows(0, count))?.map((row) => row.turn)).toEqual(complete.result);
      expect(await cache.getHead()).toMatchObject({
        start: 0,
        count,
        recoveryCheckpoint: undefined,
      });
    } finally {
      stop?.();
      data?.dispose?.();
      cache.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});

describe('Production Roost planned content operations', () => {
  it('commits mixed markup, tool and plan updates without body readback, including resumed state', async () => {
    const fixture = await nativeFixture();
    const id = 'mixed-planned';
    await fixture.backend.appendHistoryTurn(nativeUser('mixed-user'));
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant(id),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'retained-tool',
          status: 'completed',
          rawOutput: { text: 'retained'.repeat(32768) },
        },
        { type: 'text', text: '' },
      ],
    });
    const original = RoostNativeClient.prototype.request;
    let forbidBody = false;
    vi.spyOn(RoostNativeClient.prototype, 'request').mockImplementation(async function (...args) {
      if (forbidBody && ['readTurn', 'readTurns'].includes(args[0].method))
        throw new Error('Synthetic body readback unavailable');
      return original.apply(this, args);
    });
    const events = [
      {
        sessionUpdate: 'agent_message_chunk' as const,
        content: { type: 'text' as const, text: '\n<thinking>🙂' },
      },
      {
        sessionUpdate: 'agent_message_chunk' as const,
        content: { type: 'text' as const, text: 'reasoning\n</thinking>\nanswer🚀' },
      },
      {
        sessionUpdate: 'tool_call' as const,
        toolCallId: 'new-tool',
        title: 'Synthetic',
        status: 'in_progress' as const,
        rawInput: { nested: ['a', '🙂'] },
      },
      {
        sessionUpdate: 'tool_call_update' as const,
        toolCallId: 'new-tool',
        status: 'completed' as const,
        rawOutput: { nested: [1, null, { result: '🚀' }] },
      },
      {
        sessionUpdate: 'plan' as const,
        entries: [{ content: 'first', priority: 'medium' as const, status: 'pending' as const }],
      },
      {
        sessionUpdate: 'agent_message_chunk' as const,
        content: {
          type: 'text' as const,
          text: '\n<proposed_plan>\nstep 🙂\n</proposed_plan>\nend',
        },
      },
    ];
    for (const phase of ['primary', 'resumed'] as const) {
      if (phase === 'resumed') {
        const action = {
          kind: 'finish-assistant',
          turnId: id,
          endedAt: 42,
        } as const;
        const previous = await fixture.backend.readTurn(id);
        if (previous.state !== 'ready') throw new Error('Expected turn before finish');
        const reference = applyHistoryAction([structuredClone(previous.turn)], action).turns[0];
        forbidBody = true;
        try {
          await fixture.backend.applyHistoryAction(action);
        } finally {
          forbidBody = false;
        }
        expect(await fixture.backend.readTurn(id)).toMatchObject({
          state: 'ready',
          turn: reference,
        });
        await fixture.backend.openAssistantTurn({ turnId: id, userTurnId: 'mixed-user' });
      }
      const initial = await fixture.backend.readTurn(id);
      if (initial.state !== 'ready') throw new Error('Expected planned turn');
      let reference = [initial.turn] as SessionHistoryInput[];
      for (const [index, update] of events.entries()) {
        const notification = { sessionId: 'synthetic-acp', update };
        const previous = reference;
        const next = structuredClone(reference);
        applyNotificationOnHistory(next, [notification], undefined, { targetAssistantEntryId: id });
        reference = JSON.parse(
          JSON.stringify(next.map((entry, i) => prepareReplacement(previous[i], entry)))
        ) as SessionHistoryInput[];
        forbidBody = true;
        try {
          await fixture.backend.applyAgentBatch({
            targetAssistantEntryId: id,
            notifications: [notification],
            operationIds: [`${phase}-${index}`],
          });
        } finally {
          forbidBody = false;
        }
        expect(await fixture.backend.readTurn(id)).toMatchObject({
          state: 'ready',
          turn: reference[0],
        });
      }
      const fresh = await nativeFixture(fixture.doc.sessionId);
      expect(JSON.stringify(await fresh.backend.readTurn(id))).toBe(
        JSON.stringify(await fixture.backend.readTurn(id))
      );
      await fresh.close();
    }
    const before = JSON.stringify(await fixture.backend.readTurn(id));
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: id,
      notifications: [{ sessionId: 'synthetic-acp', update: events[5] as (typeof events)[number] }],
      operationIds: ['resumed-5'],
    });
    expect(JSON.stringify(await fixture.backend.readTurn(id))).toBe(before);
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(sessionId);
    expect(JSON.stringify(await reopened.backend.readTurn(id))).toBe(before);
  });
});

describe('Production Roost dispatch projection', () => {
  it('retries when a foreign writer changes only the selected body during its dispatch observation', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('dispatch-coherent-body'));
    for (let i = 0; i < 41; i++)
      await fixture.backend.appendHistoryTurn({
        ...nativeUser(`coherent-settled-${i}`),
        status: 'handled',
        read: true,
      });
    const peer = await nativeFixture(fixture.doc.sessionId);
    const read = NodeLodyHistory.prototype.readActiveBranchMessages;
    let injected = false;
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages').mockImplementation(
      async function (...args) {
        if (!injected && args[1].length > 0) {
          injected = true;
          await peer.backend.applyHistoryAction({
            kind: 'upsert-turn',
            turn: {
              ...nativeUser('dispatch-coherent-body'),
              items: [{ type: 'text', text: 'changed by a foreign writer' }],
            },
          });
        }
        return read.apply(this, args);
      }
    );
    const selected = await fixture.backend.readDispatchSelection(
      [],
      (entries) => entries.find((entry) => entry.id === 'dispatch-coherent-body')?.id
    );
    expect(injected).toBe(true);
    expect(selected.turn).toMatchObject({
      state: 'ready',
      turn: {
        id: 'dispatch-coherent-body',
        status: 'pending',
        items: [{ type: 'text', text: 'changed by a foreign writer' }],
      },
    });
    expect(selected.history.map((entry) => entry.id)).toEqual(['dispatch-coherent-body']);
  });

  it('reads cold positional ranges after reopen without hydrating intervening history', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('position-state-user'));
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('position-state-assistant'),
      userTurnId: 'position-state-user',
      finished: true,
      items: [{ type: 'text', text: 'sealed base' }],
    });
    await fixture.backend.openAssistantTurn({
      turnId: 'position-state-assistant',
      userTurnId: 'position-state-user',
      timestamp: '2026-10-24T00:00:00.000Z',
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'position-state-assistant',
      operationIds: ['position-state-append'],
      contents: [{ type: 'text', text: ' late state' }],
    });
    await fixture.backend.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: 'position-state-assistant',
      endedAt: 42,
    });
    const turns = Array.from({ length: 65 }, (_, i) => nativeUser(`position-${i}`));
    for (const turn of turns) await fixture.backend.appendHistoryTurn(turn);
    await fixture.backend.flushLocalWrites();
    const expected = await fixture.backend.readHistory();
    const id = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(id);
    await reopened.backend.flushLocalWrites();
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranch').mockRejectedValue(
      new Error('Full branch read forbidden')
    );
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage').mockRejectedValue(
      new Error('Intervening page hydration forbidden')
    );
    expect(await reopened.backend.history.readDirectory(0, 3)).toEqual(
      expected.slice(0, 3).map((turn, position) => createRoostDirectoryRow(position, turn))
    );
    const selected = await reopened.backend.history.readRange(0, 3);
    expect(selected.map((read) => (read.state === 'ready' ? read.turn : undefined))).toEqual(
      expected.slice(0, 3)
    );
    if (selected[0]?.state !== 'ready') throw new Error('Expected old indexed turn');
    selected[0].turn.items = [];
    expect(await reopened.backend.readTurn('position-state-user')).toMatchObject({
      state: 'ready',
      turn: { id: expected[0]?.id, items: expected[0]?.items },
    });
    expect(
      (await reopened.backend.history.readRange(12, 15)).map((read) =>
        read.state === 'ready' ? read.turn : undefined
      )
    ).toEqual(expected.slice(12, 15));
  });

  it('retries a positional read when a foreign body changes during hydration', async () => {
    const fixture = await nativeFixture();
    for (let i = 0; i < 45; i++)
      await fixture.backend.appendHistoryTurn(nativeUser(`position-race-${i}`));
    await fixture.backend.flushLocalWrites();
    const id = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(id);
    const peer = await nativeFixture(id);
    const read = NodeLodyHistory.prototype.readActiveBranchMessages;
    let injected = false;
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages').mockImplementation(
      async function (...args) {
        const result = await read.apply(this, args);
        if (!injected) {
          injected = true;
          await peer.backend.applyHistoryAction({
            kind: 'user-status',
            turnId: 'position-race-0',
            status: 'handled',
          });
        }
        return result;
      }
    );
    expect(await reopened.backend.history.readRange(0, 1)).toMatchObject([
      { state: 'ready', turn: { id: 'position-race-0', status: 'handled' } },
    ]);
    expect(injected).toBe(true);
    expect(await reopened.backend.readTurn('position-race-0')).toMatchObject({
      state: 'ready',
      turn: { status: 'handled' },
    });
  });

  it('fences an index-only generation switch during positional hydration without caching the old page', async () => {
    const id = `native-position-pointer-${ordinal++}`;
    const root = `lody-session:${id}`;
    let client: RoostNativeClient | undefined;
    const onChanges = RoostNativeClient.prototype.onChanges;
    const capture = vi.spyOn(RoostNativeClient.prototype, 'onChanges').mockImplementation(function (
      ...args
    ) {
      client = this;
      return onChanges.apply(this, args);
    });
    const fixture = await nativeFixture(id);
    capture.mockRestore();
    if (!client) throw new Error('Expected Native history owner');
    for (let i = 0; i < 45; i++)
      await fixture.backend.appendHistoryTurn(nativeUser(`position-pointer-old-${i}`));
    await fixture.backend.flushLocalWrites();
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const generation = new RoostHistoryGeneration(client, Identity.fromSeed(seed).owner(), id);
    const replacement = nativeUser('position-pointer-new');
    await generation.replace([replacement], 'position-pointer-activation');
    const raw = client.stream(root);
    const pointer = { table: 'lody_history_generation_v1', key: new TextEncoder().encode('next') };
    const [activation] = await raw.readIndex([pointer]);
    if (!activation) throw new Error('Expected staged activation proof');
    // Retain a real sealed activation, but defer its pointer until the read race.
    await raw.compareAndWriteIndex(
      [{ ...pointer, value: activation }],
      [{ ...pointer, value: null }]
    );
    await fixture.close();
    const prepared = await nativeFixture(id);
    await prepared.backend.readDispatchHistory([]);
    await prepared.close();
    let armed = false;
    vi.spyOn(RoostNativeClient.prototype, 'onChanges').mockImplementation(
      function (stream, listener, options) {
        return onChanges.call(
          this,
          stream,
          (cursor, key) => {
            if (!armed) listener(cursor, key);
          },
          options
        );
      }
    );
    const reopened = await nativeFixture(id);
    await reopened.backend.flushLocalWrites();
    const read = NodeLodyHistory.prototype.readActiveBranchMessages;
    let switched = false;
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages').mockImplementation(
      async function (...args) {
        const result = await read.apply(this, args);
        if (!switched) {
          switched = true;
          const before = await this.observedEventCursor();
          await this.stream.compareAndWriteIndex(
            [{ ...pointer, value: null }],
            [{ ...pointer, value: activation }]
          );
          expect(await this.observedEventCursor()).toBe(before);
        }
        return result;
      }
    );
    armed = true;
    expect(await reopened.backend.history.readRange(0, 1)).toMatchObject([
      { state: 'ready', turn: { id: replacement.id, items: replacement.items } },
    ]);
    expect(switched).toBe(true);
    expect(await reopened.backend.history.readRange(0, 1)).toMatchObject([
      { state: 'ready', turn: { id: replacement.id, items: replacement.items } },
    ]);
    armed = false;
  });

  it.each(['missing', 'wrong-position', 'uncertified', 'partial'] as const)(
    'preserves range semantics with a %s position index without forcing a rebuild',
    async (damage) => {
      const fixture = await nativeFixture();
      for (let i = 0; i < 45; i++)
        await fixture.backend.appendHistoryTurn(nativeUser(`position-fallback-${i}`));
      await fixture.backend.flushLocalWrites();
      const id = fixture.doc.sessionId;
      await fixture.close();
      const reopened = await nativeFixture(id);
      await reopened.backend.flushLocalWrites();
      vi.spyOn(RoostDispatchIndex.prototype, 'rebuild').mockRejectedValue(
        new Error('Range reads must not force a full-index rebuild')
      );
      if (damage === 'uncertified' || damage === 'partial') {
        vi.spyOn(RoostDispatchIndex.prototype, 'checkpoint').mockResolvedValue(undefined);
      } else {
        const range = RoostDispatchIndex.prototype.range;
        vi.spyOn(RoostDispatchIndex.prototype, 'range').mockImplementationOnce(async function (
          ...args
        ) {
          await this.host.compareAndWriteIndex(
            [],
            [
              {
                table: 'lody_dispatch_positions_v1',
                key: new Uint8Array(8),
                value:
                  damage === 'missing'
                    ? null
                    : new TextEncoder().encode(JSON.stringify('position-fallback-1')),
              },
            ]
          );
          return range.apply(this, args);
        });
      }
      if (damage === 'partial') {
        const page = NodeLodyHistory.prototype.readActiveBranchPage;
        vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage').mockImplementation(
          async function (...args) {
            const result = await page.apply(this, args);
            return args[1]?.from === 0 ? { ...result, complete: false, messages: [] } : result;
          }
        );
        await expect(reopened.backend.history.readRange(0, 2)).rejects.toThrow('incomplete');
        expect(await reopened.backend.readHistoryCount()).toBe(45);
        expect(await reopened.backend.history.readRange(44, 45)).toMatchObject([
          { state: 'ready', turn: { id: 'position-fallback-44' } },
        ]);
        return;
      }
      expect(await reopened.backend.history.readRange(0, 2)).toMatchObject([
        { state: 'ready', turn: { id: 'position-fallback-0' } },
        { state: 'ready', turn: { id: 'position-fallback-1' } },
      ]);
      expect(await reopened.backend.readHistoryCount()).toBe(45);
    }
  );

  it('dispatches an old pending input after reopen without materializing historical pages', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('old-pending-dispatch'));
    for (let i = 0; i < 44; i++)
      await fixture.backend.appendHistoryTurn({
        ...nativeUser(`settled-dispatch-${i}`),
        status: 'handled',
        read: true,
      });
    await fixture.backend.appendHistoryTurn(nativeUser('new-pending-dispatch'));
    await fixture.backend.flushLocalWrites();
    const full = await fixture.backend.readHistory();
    const id = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(id);
    await reopened.backend.flushLocalWrites();
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranch').mockRejectedValue(
      new Error('Full branch read forbidden')
    );
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage').mockRejectedValue(
      new Error('Historical page hydration forbidden')
    );
    const included = ['settled-dispatch-0'];
    const selected = await reopened.backend.readDispatchHistory(included);
    expect(selected).toEqual(selectDispatchHistory(full.map(dispatchEntry), included));
    selected[0]!.status = 'canceled';
    expect(await reopened.backend.readDispatchHistory(included)).toEqual(
      selectDispatchHistory(full.map(dispatchEntry), included)
    );
    const watcher = new SessionDispatchWatcher({
      logger: getDefaultLogger(),
      machineId: 'test-machine',
      workspaceId: 'test-workspace',
      workspaceDocument: { repo: reopened.repo },
      executionService: {
        reconcileSteerHistory: async () => {},
        tryAcquireSessionRewriteConflictLease: () => () => {},
        isInboxInputCanceled: () => false,
      } as unknown as SessionExecutionService,
      userResolver: { resolve: async () => undefined, clear: () => {} },
      canUseMachine: async () => ({ outcome: 'allowed' }),
    } as never);
    const check = (
      watcher as unknown as {
        checkHistoryAndQueue(
          doc: SessionDocument,
          meta: unknown
        ): Promise<{ turn: SessionHistoryInput | null }>;
      }
    ).checkHistoryAndQueue.bind(watcher);
    const result = await check(reopened.doc, await reopened.doc.getMetaState());
    expect(result.turn).toEqual(full.find((entry) => entry.id === 'old-pending-dispatch'));
    await reopened.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'old-pending-dispatch',
      status: 'handled',
    });
    expect((await check(reopened.doc, await reopened.doc.getMetaState())).turn?.id).toBe(
      'new-pending-dispatch'
    );
  });

  it('keeps completion evidence exact across finish, reopen and late state updates', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('dispatch-completion-user'));
    await fixture.backend.openAssistantTurn({
      turnId: 'dispatch-completion-assistant',
      userTurnId: 'dispatch-completion-user',
      timestamp: '2026-10-22T00:00:00.000Z',
    });
    await fixture.backend.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: 'dispatch-completion-assistant',
      endedAt: 42,
    });
    expect(await fixture.backend.readDispatchHistory([])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'dispatch-completion-assistant',
          userTurnId: 'dispatch-completion-user',
          endedAt: 42,
        }),
      ])
    );
    await fixture.backend.openAssistantTurn({
      turnId: 'dispatch-completion-assistant',
      userTurnId: 'dispatch-completion-user',
      timestamp: '2026-10-22T00:00:00.000Z',
    });
    expect(
      (await fixture.backend.readDispatchHistory([])).some((entry) => entry.role === 'assistant')
    ).toBe(false);
    await fixture.backend.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: 'dispatch-completion-assistant',
      endedAt: 84,
    });
    expect(await fixture.backend.readDispatchHistory([])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dispatch-completion-assistant', endedAt: 84 }),
      ])
    );
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'dispatch-completion-user',
      status: 'handled',
    });
    expect(await fixture.backend.readDispatchHistory([])).toEqual([]);
    expect(await fixture.backend.readDispatchHistory(['dispatch-completion-user'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dispatch-completion-user', status: 'handled' }),
        expect.objectContaining({ id: 'dispatch-completion-assistant', endedAt: 84 }),
      ])
    );
  });

  it('repairs a missing projection with bounded pages and never revives a removed branch', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('dispatch-removed'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('dispatch-removed-output'));
    expect(
      await fixture.backend.replaceEditableTail({
        expectedUserTurnId: 'dispatch-removed',
        expectedForkTurnId: undefined,
        replacement: nativeUser('dispatch-replacement') as never,
      })
    ).toMatchObject({ status: 'accepted' });
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranch').mockRejectedValue(
      new Error('Full branch read forbidden')
    );
    const missing = vi
      .spyOn(RoostDispatchIndex.prototype, 'checkpoint')
      .mockResolvedValueOnce(undefined);
    expect(
      (await fixture.backend.readDispatchHistory(['dispatch-removed'])).map((entry) => entry.id)
    ).toEqual(['dispatch-replacement']);
    missing.mockRestore();
    expect(await fixture.backend.readTurn('dispatch-removed')).toEqual({ state: 'missing' });
    expect((await fixture.backend.readDispatchHistory([])).map((entry) => entry.id)).toEqual([
      'dispatch-replacement',
    ]);
  });

  it('rejects stale index publication, refreshes another reader and repairs an interrupted build', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('dispatch-index-fence'));
    await fixture.backend.flushLocalWrites();
    const read = RoostDispatchIndex.prototype.read;
    let owner: RoostDispatchIndex | undefined;
    const capture = vi.spyOn(RoostDispatchIndex.prototype, 'read').mockImplementation(function (
      ...args
    ) {
      owner = this;
      return read.apply(this, args);
    });
    await fixture.backend.readDispatchHistory([]);
    capture.mockRestore();
    if (!owner) throw new Error('Expected dispatch projection owner');
    const old = owner.current();
    if (!old) throw new Error('Expected complete dispatch checkpoint');
    const observer = new RoostDispatchIndex(owner.host);
    const before = await observer.checkpoint(BigInt(old.header.cursor), old.header.count);
    if (!before) throw new Error('Expected second dispatch checkpoint');
    expect((await observer.read(before, []))[0]?.id).toBe('dispatch-index-fence');
    const stalePlan = await observer.plan(before, BigInt(before.header.cursor) + 1n, 1, [
      {
        before: dispatchEntry(nativeUser('dispatch-index-fence')),
        after: { id: 'dispatch-index-fence', role: 'user', status: 'processing', read: true },
      },
    ]);
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'dispatch-index-fence',
      status: 'handled',
    });
    await expect(observer.commit(stalePlan)).rejects.toMatchObject({ code: 'stale' });
    const current = owner.current();
    if (!current) throw new Error('Expected advanced dispatch checkpoint');
    const refreshed = await observer.checkpoint(BigInt(current.header.cursor), 1);
    if (!refreshed) throw new Error('Expected refreshed observer');
    expect(await observer.read(refreshed, ['dispatch-index-fence'])).toEqual([
      expect.objectContaining({ id: 'dispatch-index-fence', status: 'handled' }),
    ]);
    const stored = await fixture.backend.readHistory();
    const row = await owner.row('dispatch-index-fence', current);
    if (!row) throw new Error('Expected persisted dispatch row');
    await expect(
      owner.rebuild(
        BigInt(current.header.cursor),
        1,
        (async function* () {
          yield [row];
        })(),
        async () => {
          throw new Error('Synthetic interrupted projection build');
        }
      )
    ).rejects.toThrow('Synthetic interrupted projection build');
    await expect(observer.range(refreshed, 0, 1)).rejects.toMatchObject({ code: 'stale' });
    observer.forget();
    expect(await observer.checkpoint(BigInt(current.header.cursor), 1)).toBeUndefined();
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranch').mockRejectedValue(
      new Error('Full branch repair forbidden')
    );
    expect(await fixture.backend.readDispatchHistory([])).toEqual([]);
    expect(await fixture.backend.readDispatchHistory(['dispatch-index-fence'])).toEqual([
      expect.objectContaining({ id: 'dispatch-index-fence', status: 'handled' }),
    ]);
    const rebuilt = await observer.checkpoint(BigInt(current.header.cursor), 1);
    if (!rebuilt) throw new Error('Expected rebuilt positional checkpoint');
    expect(await observer.range(rebuilt, 0, 1)).toEqual([row]);
    vi.restoreAllMocks();
    expect(await fixture.backend.readHistory()).toEqual(stored);
  });
});

it('keeps rooted directory cursors, metadata selection and bounded replay equivalent to complete history', async () => {
  const fixture = await nativeFixture();
  for (let index = 0; index < 48; index++)
    await fixture.backend.appendHistoryTurn({
      ...nativeUser(`rooted-${index}`),
      userId: index === 2 ? 'earlier-author' : 'author',
      items: [{ type: 'text', text: index === 0 ? 'prefix'.repeat(50000) : `question ${index}` }],
      ...(index === 3
        ? {
            scheduleRun: {
              scheduleId: 'schedule',
              turnId: 'scheduled-turn',
              title: 'Synthetic run',
            },
          }
        : {}),
    });
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'rooted-17' });
  const expected = await fixture.backend.readHistory();
  const full = vi
    .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
    .mockRejectedValue(new Error('whole history forbidden'));
  const all = vi
    .spyOn(fixture.backend.history, 'readAll')
    .mockRejectedValue(new Error('whole history forbidden'));
  try {
    const ids: string[] = [];
    let page = await fixture.backend.history.readLatestDirectoryPage!(7);
    for (;;) {
      ids.unshift(...page.rows.map((row) => row.turnId!));
      if (!page.hasMoreOlder || !page.cursor) break;
      page = await fixture.backend.history.readOlderDirectoryPage!(page.cursor, 7);
    }
    expect(ids).toEqual(expected.map((row) => row.id));
    const body = NodeLodyHistory.prototype.readActiveBranchMessages;
    const selected = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
      .mockImplementation(function (viewId, requested) {
        if (requested.some((id) => !['rooted-45', 'rooted-46', 'rooted-47'].includes(id)))
          throw new Error('unrelated body forbidden');
        return body.call(this, viewId, requested);
      });
    try {
      const transcript = toSessionTranscriptEntries(expected);
      expect(await readSessionTranscript(fixture.backend, { limit: 3 })).toEqual({
        total: transcript.length,
        entries: selectSessionTranscriptEntries(transcript, { limit: 3 }),
      });
      const query = await fixture.backend.readHistoryQuery();
      expect(query.map((row) => row.id)).toEqual(ids);
    } finally {
      selected.mockRestore();
    }
    const builder = await fixture.backend.foldHistory(
      () => createReplayPromptBuilder({ maxChars: 511 }),
      (state, entry) => state.add(entry)
    );
    expect(builder.finish()).toEqual(
      buildReplayPromptFromHistory({ history: expected, maxChars: 511 })
    );
  } finally {
    all.mockRestore();
    full.mockRestore();
  }
});

it.each([undefined, 1, 2])(
  'keeps CLI metadata, transcript and replay usable while streaming (inspection v%s)',
  async (version) => {
    const fixture = await coldHistoryHandlerFixture(1);
    const sessionId = [...fixture.docs.keys()][0]!;
    let client: Awaited<ReturnType<SessionBackendFactory>> | undefined;
    try {
      await fixture.ready(sessionId);
      await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'append', {
        entry: {
          ...nativeUser('rpc-prefix'),
          inputConfig: { modelId: 'synthetic-model', modeId: 'ask' },
          items: [{ type: 'text', text: 'prefix'.repeat(50000) }],
        },
      });
      const doc = fixture.docs.get(sessionId)!;
      const owner = await createSessionBackend(doc);
      for (let index = 0; index < 50; index++)
        await owner.appendHistoryTurn({
          ...nativeUser(`rpc-row-${index}`),
          status: 'handled',
          read: true,
        });
      await owner.openAssistantTurn({
        turnId: 'rpc-live',
        userTurnId: 'rpc-row-49',
        timestamp: '2026-10-31T00:00:00Z',
      });
      const capabilities: Record<string, number> = { ...CURRENT_MACHINE_PROTOCOL_CAPABILITIES };
      if (version === undefined) delete capabilities.sessionHistoryInspection;
      else capabilities.sessionHistoryInspection = version;
      await fixture.repo.upsertDocMeta(getMachineRoomId('test-machine'), {
        id: 'test-machine',
        protocolCapabilities: capabilities,
      });
      let update = 0;
      const factory = createCommandSessionHistoryFactory(
        () => ({ repo: fixture.repo }) as LoroDocumentManager,
        { userId: 'test-user', machineId: 'test-machine', token: 'synthetic-token' } as AuthContext,
        'test-workspace',
        async (_target, run) =>
          run({
            requestSessionHistoryRead: async (request: {
              sessionId: SessionId;
              query: SessionHistoryReadQuery;
            }) => {
              const query = SessionHistoryReadQuerySchema.parse(request.query);
              if (version === 2 ? query.kind === 'readAll' : query.kind !== 'readAll')
                throw new Error('History read used the wrong negotiated protocol');
              await owner.applyHistoryAction({
                kind: 'assistant-items',
                turnId: 'rpc-live',
                mode: 'replace',
                items: Array.from({ length: (++update % 2) + 1 }, (_, index) => ({
                  type: 'text' as const,
                  text: `stream-${update}-${index}`,
                })),
              });
              return fixture.rpc.readSessionHistoryForRpc(request.sessionId, query);
            },
          } as never)
      );
      client = await factory(doc, await doc.getMetaState());
      const metadata = await readSessionHistoryMetadata(client.history);
      expect(resolveActiveAssistantTurnId(metadata)).toBe('rpc-live');
      expect(metadata[0]).toMatchObject({
        id: 'rpc-prefix',
        inputConfig: { modeId: 'ask', modelId: 'synthetic-model' },
      });
      const query = await client.readHistoryQuery();
      expect(query.at(-1)).toMatchObject({ id: 'rpc-live', role: 'assistant' });
      expect(await client.readLatestGoal()).toBeNull();
      expect(await client.readHistoryEntry?.('rpc-row-7')).toMatchObject({
        id: 'rpc-row-7',
        status: 'handled',
      });
      for (const options of [
        { all: false, limit: 50 },
        { reverse: true, limit: 3 },
      ]) {
        const transcript = await readSessionTranscript(client, options);
        const afterTranscript = toSessionTranscriptEntries(await owner.readHistory());
        expect(transcript).toEqual({
          total: afterTranscript.length,
          entries: selectSessionTranscriptEntries(afterTranscript, options),
        });
      }
      const replay = await client.readHistoryReplay?.('rpc-prefix');
      expect(replay).toEqual(
        buildReplayPromptFromHistory({
          history: await owner.readHistory(),
          excludeTurnId: 'rpc-prefix',
        })
      );
    } finally {
      await client?.dispose();
      await fixture.close();
    }
  }
);

it('reselects the latest row when metadata changes between the two owner requests', async () => {
  const fixture = await coldHistoryHandlerFixture(1);
  const sessionId = [...fixture.docs.keys()][0]!;
  let client: Awaited<ReturnType<SessionBackendFactory>> | undefined;
  try {
    await fixture.ready(sessionId);
    await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'append', {
      entry: nativeUser('first-choice'),
    });
    const doc = fixture.docs.get(sessionId)!;
    const owner = await createSessionBackend(doc);
    await fixture.repo.upsertDocMeta(getMachineRoomId('test-machine'), {
      id: 'test-machine',
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    });
    let changed = false;
    const factory = createCommandSessionHistoryFactory(
      () => ({ repo: fixture.repo }) as LoroDocumentManager,
      { userId: 'test-user', machineId: 'test-machine', token: 'synthetic-token' } as AuthContext,
      'test-workspace',
      async (_target, run) =>
        run({
          requestSessionHistoryRead: async (request: {
            sessionId: SessionId;
            query: SessionHistoryReadQuery;
          }) => {
            const query = SessionHistoryReadQuerySchema.parse(request.query);
            if (query.kind === 'readAll')
              throw new Error('Whole-history fallback is forbidden for this owner');
            if (query.kind === 'readSelection' && !changed) {
              changed = true;
              await owner.appendHistoryTurn(nativeUser('new-choice'));
            }
            return fixture.rpc.readSessionHistoryForRpc(request.sessionId, query);
          },
        } as never)
    );
    client = await factory(doc, await doc.getMetaState());
    expect(await client.readHistorySelection((rows) => [rows.length - 1])).toEqual([
      nativeUser('new-choice'),
    ]);
  } finally {
    await client?.dispose();
    await fixture.close();
  }
});

async function assertOwnerInspection(fixture: Awaited<ReturnType<typeof nativeFixture>>) {
  const full = await fixture.backend.readHistory();
  for (const reverse of [false, true]) {
    const response = await fixture.backend.readHistoryInspection!({
      kind: 'readTranscript',
      limit: 3,
      reverse,
    });
    expect(response.success).toBe(true);
    const result = response.result as {
      total: number;
      positions: number[];
      entries: SessionHistoryInput[];
    };
    const visible = full.flatMap((entry, position) =>
      toSessionTranscriptEntries([entry]).length ? [position] : []
    );
    const selected = visible.slice(-3);
    if (reverse) selected.reverse();
    expect(result.total).toBe(visible.length);
    expect(result.positions).toEqual(selected);
    expect(result.entries).toEqual(selected.map((position) => full[position]));
  }
  const first = await fixture.backend.readHistoryInspection!({
    kind: 'readQuerySnapshot',
    transcriptVisibility: true,
  });
  const second = await fixture.backend.readHistoryInspection!({
    kind: 'readQuerySnapshot',
    transcriptVisibility: true,
  });
  expect(second.result).toEqual(first.result);
  expect(second.historyRevision).toBe(first.historyRevision);
  const replay = await fixture.backend.readHistoryInspection!({ kind: 'readReplayPrompt' });
  expect(replay.result).toEqual(buildReplayPromptFromHistory({ history: full }));
}

it('visibility changes, state programs, sparse aliases and reopen', async () => {
  let fixture = await nativeFixture();
  const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
  const owner = Identity.fromSeed(seed).owner();
  const client = new RoostNativeClient({
    dbPath: join(nativeDirectory, 'history.db'),
    seed,
    allowedOwners: [owner],
    maxQueuedRequests: 32,
    maxQueuedBytes: 8 * 1024 * 1024,
  });
  try {
    await client.ready;
    await new RoostHistoryGeneration(client, owner, fixture.doc.sessionId).replace(
      [
        {
          ...nativeAssistant('future-item'),
          finished: true,
          items: [{ type: 'future-item-type', opaque: 'synthetic' }],
        } as never,
      ],
      'unknown-stored-seed'
    );
  } finally {
    await client.close();
  }
  await fixture.backend.flushLocalWrites();
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('visibility-user'),
    status: 'handled',
    read: true,
    items: [{ type: 'text', text: ' ' }],
  });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('visibility-assistant'),
    items: [{ type: 'text', text: ' \n ' }],
  });
  await assertOwnerInspection(fixture);
  await fixture.backend.applyAgentBatch({
    targetAssistantEntryId: 'visibility-assistant',
    contents: [{ type: 'text', text: 'visible 😀 text' }],
    operationIds: ['visibility-fragment'],
  });
  await assertOwnerInspection(fixture);
  const setText = async (text: string) => {
    const read = await fixture.backend.readTurn('visibility-assistant');
    if (read.state !== 'ready') throw new Error('Missing assistant');
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: { ...read.turn, items: [{ type: 'text', text }] } as SessionHistoryInput,
    });
    await assertOwnerInspection(fixture);
  };
  await setText('');
  await setText('A😀B');
  await fixture.backend.applyHistoryAction({
    kind: 'finish-assistant',
    turnId: 'visibility-assistant',
    endedAt: 42,
  });
  await setText('long sealed state 😀 replacement');
  await setText(' \n ');
  await setText('state visible again');
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('visibility-images'),
    status: 'handled',
    read: true,
    items: [
      {
        type: 'image_group',
        images: [{ imageId: 'synthetic-image', mimeType: 'image/png', sizeBytes: 1 }],
      },
    ],
  });
  await assertOwnerInspection(fixture);
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'visibility-user' });
  await assertOwnerInspection(fixture);
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'visibility-assistant' });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('visibility-assistant'),
    items: [{ type: 'text', text: 'reinserted physical alias' }],
  });
  await assertOwnerInspection(fixture);
  const id = fixture.doc.sessionId;
  await fixture.close();
  fixture = await nativeFixture(id);
  await assertOwnerInspection(fixture);
});

it('external text change supersedes cached visibility and body selection', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('foreign-visible'),
    status: 'handled',
    read: true,
  });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('foreign-hidden'),
    finished: true,
    items: [{ type: 'text', text: ' ' }],
  });
  await assertOwnerInspection(fixture);
  const peer = await nativeFixture(fixture.doc.sessionId);
  const original = NodeLodyHistory.prototype.readActiveBranchMessages;
  let injected = false;
  const selected = vi
    .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
    .mockImplementation(async function (...args) {
      if (!injected) {
        injected = true;
        await peer.backend.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            ...nativeAssistant('foreign-hidden'),
            finished: true,
            items: [{ type: 'text', text: 'foreign state is now visible' }],
          },
        });
      }
      return original.apply(this, args);
    });
  try {
    const response = await fixture.backend.readHistoryInspection!({
      kind: 'readTranscript',
      limit: 3,
    });
    expect(injected).toBe(true);
    expect(response.success).toBe(true);
    expect(
      (response.result as { entries: SessionHistoryInput[] }).entries.map((row) => row.id)
    ).toEqual(['foreign-visible', 'foreign-hidden']);
  } finally {
    selected.mockRestore();
  }
  await assertOwnerInspection(fixture);
});

it.each(['indexRead', 'indexCompareWrite'])(
  'optional visibility cache %s failure preserves reads',
  async (method) => {
    let fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeUser('cache-fault-u'),
      status: 'handled',
      read: true,
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('cache-fault-a'),
      items: [{ type: 'text', text: 'unchanged visible body' }],
    });
    await fixture.backend.readHistoryQuery();
    const savedId = fixture.doc.sessionId;
    await fixture.close();
    fixture = await nativeFixture(savedId);
    const original = RoostNativeClient.prototype.request;
    let injected = false;
    RoostNativeClient.prototype.request = function (...args) {
      const command = args[0] as unknown as {
        method: string;
        keys?: { table: string }[];
        changes?: { table: string }[];
      };
      if (
        command.method === method &&
        (command.keys ?? command.changes ?? []).some(
          (row) => row.table === 'lody_transcript_visibility_v1'
        )
      ) {
        injected = true;
        return Promise.reject(new RoostHostError('storage'));
      }
      return original.apply(this, args);
    };
    try {
      await assertOwnerInspection(fixture);
      expect(injected).toBe(true);
    } finally {
      RoostNativeClient.prototype.request = original;
    }
  }
);

it('reopening after an older writer ignores stale visibility', async () => {
  let fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('legacy-writer-u'),
    status: 'handled',
    read: true,
  });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('legacy-writer-a'),
    items: [{ type: 'text', text: ' ' }],
  });
  await assertOwnerInspection(fixture);
  const original = RoostDispatchIndex.prototype.plan;
  RoostDispatchIndex.prototype.plan = async function (...args) {
    const plan = await original.apply(this, args);
    plan.puts = plan.puts.filter((row) => row.table !== 'lody_transcript_visibility_v1');
    delete (plan as unknown as { nextVisibility?: unknown }).nextVisibility;
    return plan;
  };
  try {
    const read = await fixture.backend.readTurn('legacy-writer-a');
    if (read.state !== 'ready') throw new Error('Missing prior');
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: {
        ...read.turn,
        items: [{ type: 'text', text: 'older writer made this visible' }],
      } as SessionHistoryInput,
    });
  } finally {
    RoostDispatchIndex.prototype.plan = original;
  }
  const id = fixture.doc.sessionId;
  await fixture.close();
  fixture = await nativeFixture(id);
  await assertOwnerInspection(fixture);
});

it.each(['active', 'paused', 'cleared'] as const)(
  'certified goal %s matches the complete projection',
  async (status) => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeUser(`goal-user-${status}`),
      status: 'handled',
      read: true,
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant(`goal-assistant-${status}`),
      finished: true,
      items: [
        { type: 'goal', threadId: 'certified-goal', objective: 'Synthetic goal objective', status },
      ],
    });
    const expected = resolveLatestSessionGoalFromHistory(await fixture.backend.readHistory());
    expect(
      (await fixture.backend.readHistoryInspection!({ kind: 'readLatestGoal' })).result
    ).toEqual(expected);
    expect(await fixture.backend.readLatestGoal()).toEqual(expected);
    const id = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(id);
    expect(
      (await reopened.backend.readHistoryInspection!({ kind: 'readLatestGoal' })).result
    ).toEqual(expected);
    expect(await reopened.backend.readLatestGoal()).toEqual(expected);
  }
);

it('serves certified goals and replay when the unrelated field index is unavailable', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn(nativeUser('independent-user'));
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('independent-goal'),
    finished: true,
    items: [
      { type: 'goal', threadId: 'independent', objective: 'Synthetic objective', status: 'active' },
    ],
  });
  const complete = await fixture.backend.readHistory();
  vi.spyOn(RoostDispatchIndex.prototype, 'checkpoint').mockResolvedValue(undefined);
  vi.spyOn(RoostDispatchIndex.prototype, 'rebuild').mockRejectedValue(
    new Error('Unrelated field index unavailable')
  );
  expect(await fixture.backend.readLatestGoal()).toEqual(
    resolveLatestSessionGoalFromHistory(complete)
  );
  expect((await fixture.backend.readHistoryInspection!({ kind: 'readLatestGoal' })).result).toEqual(
    resolveLatestSessionGoalFromHistory(complete)
  );
  const replay = buildReplayPromptFromHistory({ history: complete });
  expect(await fixture.backend.readHistoryReplay?.()).toEqual(replay);
  expect(
    (await fixture.backend.readHistoryInspection!({ kind: 'readReplayPrompt' })).result
  ).toEqual(replay);
  expect(
    (
      await fixture.backend.foldHistory(
        () => createReplayPromptBuilder(),
        (builder, entry) => builder.add(entry)
      )
    ).finish()
  ).toEqual(replay);
});

it.each(
  (['replay', 'fold'] as const).flatMap((operation) =>
    (['page', 'first-body', 'last-body'] as const).map((pauseAt) => ({ operation, pauseAt }))
  )
)(
  'stops $operation after the pending $pauseAt read settles on close and drains accepted writes',
  async ({ operation, pauseAt }) => {
    const fixture = await nativeFixture();
    const entries = [nativeUser('close-user'), nativeAssistant('close-assistant')];
    for (const entry of entries) await fixture.backend.appendHistoryTurn(entry);
    const original = await fixture.backend.readHistory();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closingStarted = Promise.withResolvers<void>();
    const members = NodeLodyHistory.prototype.readActiveBranchMembers;
    const messages = NodeLodyHistory.prototype.readActiveBranchMessages;
    let paused = false;
    const pause = async () => {
      if (paused) return;
      paused = true;
      entered.resolve();
      await release.promise;
    };
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMembers').mockImplementation(
      async function (...args) {
        const page = await members.apply(this, args);
        if (pauseAt === 'page' && args[1]?.from === 0) await pause();
        return page;
      }
    );
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages').mockImplementation(
      async function (...args) {
        const page = await messages.apply(this, args);
        const target = pauseAt === 'first-body' ? entries[0]!.id : entries[1]!.id;
        if (pauseAt !== 'page' && args[1].includes(target)) await pause();
        return page;
      }
    );
    const dispose = fixture.backend.dispose!.bind(fixture.backend);
    vi.spyOn(fixture.backend, 'dispose').mockImplementation(async () => {
      const closing = dispose();
      closingStarted.resolve();
      await closing;
    });
    const visited: string[] = [];
    const read = (
      operation === 'replay'
        ? fixture.backend.readHistoryReplay!()
        : fixture.backend.foldHistory(
            () => visited,
            (ids, entry) => {
              ids.push(entry.id);
            }
          )
    ).then(
      (value) => ({ status: 'ready' as const, value }),
      (error: unknown) => ({ status: 'failed' as const, error })
    );
    let closing: Promise<void> | undefined;
    let write: Promise<void> | undefined;
    let closed = false;
    const appended = nativeUser('close-accepted-write');
    try {
      await entered.promise;
      write = fixture.backend.appendHistoryTurn(appended);
      closing = disposeSessionBackend(fixture.doc).then(() => {
        closed = true;
      });
      await closingStarted.promise;
      expect(closed).toBe(false);
      release.resolve();
      const result = await read;
      expect(result).toMatchObject({
        status: 'failed',
        error: new Error('Roost session backend is disposed'),
      });
      if (operation === 'fold')
        expect(visited).toEqual(pauseAt === 'last-body' ? [entries[0]!.id] : []);
      await write;
      await closing;
      expect(closed).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([read, ...(write ? [write] : []), ...(closing ? [closing] : [])]);
      vi.restoreAllMocks();
      await fixture.close();
    }
    const reopened = await nativeFixture(fixture.doc.sessionId);
    expect(await reopened.backend.readHistory()).toEqual([...original, appended]);
    await reopened.close();
  }
);

it('reuses unchanged transcript visibility while recalculating a written tail', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn({
    ...nativeUser('visibility-prefix'),
    status: 'handled',
    read: true,
  });
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('visibility-live'),
    items: [{ type: 'text', text: ' ' }],
  });
  const before = await fixture.backend.readHistoryQuery({ transcriptVisibility: true });
  const original = NodeLodyHistory.prototype.lookupMember;
  vi.spyOn(NodeLodyHistory.prototype, 'lookupMember').mockImplementation(function (identity) {
    if (identity.businessId === 'visibility-prefix')
      throw new Error('Unchanged visibility unavailable');
    return original.call(this, identity);
  });
  await fixture.backend.applyAgentBatch({
    targetAssistantEntryId: 'visibility-live',
    contents: [{ type: 'text', text: 'now visible' }],
    operationIds: ['visible-tail-write'],
  });
  const response = await fixture.backend.readHistoryInspection!({
    kind: 'readTranscript',
    limit: 1,
  });
  expect(response.result).toMatchObject({
    total: 2,
    positions: [1],
    entries: [{ id: 'visibility-live', items: [{ type: 'text', text: ' now visible' }] }],
  });
  const after = await fixture.backend.readHistoryQuery({ transcriptVisibility: true });
  expect(after[0]).toEqual(before[0]);
  expect(after[1]?.items?.[0]).toMatchObject({ _textNonBlank: true });
});

it('retains state overlays while reusing the field projection after membership changes', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn(nativeUser('retained-status'));
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('retained-finish'),
    userTurnId: 'retained-status',
  });
  await fixture.backend.applyHistoryAction({
    kind: 'user-status',
    turnId: 'retained-status',
    status: 'handled',
  });
  await fixture.backend.applyHistoryAction({
    kind: 'finish-assistant',
    turnId: 'retained-finish',
    endedAt: 84,
  });
  for (let index = 0; index < 65; index++)
    await fixture.backend.appendHistoryTurn({
      ...nativeUser(`membership-${index}`),
      status: 'handled',
    });
  const before = await fixture.backend.readHistory();
  await fixture.backend.readHistoryQuery();
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'membership-3' });
  const rediscovery = vi
    .spyOn(RoostDispatchIndex.prototype, 'rebuild')
    .mockRejectedValue(new Error('Repeated field discovery unavailable'));
  const rows = await readSessionHistoryMetadata(fixture.backend.history);
  expect(rows.map((row) => row.id)).toEqual(
    before.filter((row) => row.id !== 'membership-3').map((row) => row.id)
  );
  expect(rows[0]).toMatchObject({ id: 'retained-status', status: 'handled' });
  expect(rows[1]).toMatchObject({ id: 'retained-finish', finished: true, endedAt: 84 });
  expect(await fixture.backend.readDispatchHistory(['retained-status'])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'retained-status', status: 'handled' }),
      expect.objectContaining({ id: 'retained-finish', endedAt: 84 }),
    ])
  );
  rediscovery.mockRestore();
  vi.spyOn(RoostDispatchIndex.prototype, 'checkpoint').mockResolvedValueOnce(undefined);
  expect(await readSessionHistoryMetadata(fixture.backend.history)).toEqual(rows);
  expect((await fixture.backend.readHistory()).slice(0, 2)).toMatchObject([
    { id: 'retained-status', status: 'handled' },
    { id: 'retained-finish', finished: true, endedAt: 84 },
  ]);
});

it('rediscovers fields after an external write interrupts structural projection reuse', async () => {
  const fixture = await nativeFixture();
  await fixture.backend.appendHistoryTurn(nativeUser('rebase-user'));
  await fixture.backend.appendHistoryTurn({
    ...nativeAssistant('rebase-output'),
    items: [{ type: 'text', text: 'before' }],
  });
  await fixture.backend.appendHistoryTurn(nativeUser('rebase-remove'));
  await fixture.backend.readHistoryQuery();
  const peer = await nativeFixture(fixture.doc.sessionId);
  const original = RoostDispatchIndex.prototype.rebuild;
  let injected = false;
  vi.spyOn(RoostDispatchIndex.prototype, 'rebuild').mockImplementation(
    async function (cursor, count, pages, verify) {
      const interleaved = async function* () {
        for await (const page of pages) {
          if (!injected) {
            injected = true;
            await peer.backend.applyHistoryAction({
              kind: 'user-status',
              turnId: 'rebase-user',
              status: 'handled',
            });
          }
          yield page;
        }
      };
      return original.call(this, cursor, count, interleaved(), verify);
    }
  );
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'rebase-remove' });
  expect(injected).toBe(true);
  const rows = await readSessionHistoryMetadata(fixture.backend.history);
  expect(rows.map((row) => row.id)).toEqual(['rebase-user', 'rebase-output']);
  expect(rows[0]).toMatchObject({ status: 'handled' });
  expect(await fixture.backend.readHistory()).toEqual(await peer.backend.readHistory());
});

it.each(['local', 'owner'] as const)(
  'rechecks a certified goal after an index-only generation switch (%s)',
  async (entry) => {
    let muted = false;
    const onChanges = RoostNativeClient.prototype.onChanges;
    vi.spyOn(RoostNativeClient.prototype, 'onChanges').mockImplementation(
      function (stream, listener, options) {
        return onChanges.call(
          this,
          stream,
          (cursor, key) => {
            if (!muted) listener(cursor, key);
          },
          options
        );
      }
    );
    const fixture = await nativeFixture();
    const goal: SessionGoalMessage = {
      type: 'goal',
      threadId: 'generation-goal',
      objective: 'Synthetic objective',
      status: 'active',
    };
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('before-generation'),
      finished: true,
      items: [goal],
    });
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'history.db'),
      seed,
      allowedOwners: [owner],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    try {
      await client.ready;
      muted = true;
      const generation = new RoostHistoryGeneration(client, owner, fixture.doc.sessionId);
      await generation.replace(
        [
          {
            ...nativeAssistant('after-generation'),
            finished: true,
            items: [{ ...goal, status: 'cleared' }],
          },
        ],
        'certified-goal-switch'
      );
      const raw = client.stream(`lody-session:${fixture.doc.sessionId}`);
      const pointer = {
        table: 'lody_history_generation_v1',
        key: new TextEncoder().encode('next'),
      };
      const [activation] = await raw.readIndex([pointer]);
      if (!activation) throw new Error('Missing activation');
      await raw.compareAndWriteIndex(
        [{ ...pointer, value: activation }],
        [{ ...pointer, value: null }]
      );
      expect(await fixture.backend.readLatestGoal()).toEqual(goal);
      const observed = NodeLodyHistory.prototype.observedEventCursor;
      let switched = false;
      vi.spyOn(NodeLodyHistory.prototype, 'observedEventCursor').mockImplementation(
        async function () {
          const cursor = await observed.call(this);
          if (!switched) {
            switched = true;
            await raw.compareAndWriteIndex(
              [{ ...pointer, value: null }],
              [{ ...pointer, value: activation }]
            );
            expect(await observed.call(this)).toBe(cursor);
          }
          return cursor;
        }
      );
      const result =
        entry === 'local'
          ? await fixture.backend.readLatestGoal()
          : (await fixture.backend.readHistoryInspection!({ kind: 'readLatestGoal' })).result;
      expect(result).toEqual({ ...goal, status: 'cleared' });
      expect(switched).toBe(true);
    } finally {
      muted = false;
      await client.close();
    }
  }
);

it('retries a fallback range when a foreign append changes the page count', async () => {
  const fixture = await nativeFixture();
  for (let i = 0; i < 45; i++) await fixture.backend.appendHistoryTurn(nativeUser(`p2-range-${i}`));
  const peer = await nativeFixture(fixture.doc.sessionId);
  await fixture.backend.flushLocalWrites();
  await peer.backend.flushLocalWrites();
  const read = NodeLodyHistory.prototype.readActiveBranchPage;
  let injected = false;
  vi.spyOn(RoostDispatchIndex.prototype, 'checkpoint').mockResolvedValueOnce(undefined);
  vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage').mockImplementation(
    async function (viewId, input) {
      if (!injected && input?.from === 0) {
        injected = true;
        await peer.backend.appendHistoryTurn(nativeUser('p2-foreign-append'));
      }
      return read.call(this, viewId, input);
    }
  );
  const result = await fixture.backend.history.readRange(0, 1);
  expect(injected).toBe(true);
  expect(result[0]).toMatchObject({ state: 'ready', turn: { id: 'p2-range-0' } });
});

it('uses body-page cursors in member pages before and after sparse membership changes', async () => {
  const fixture = await nativeFixture();
  for (let i = 0; i < 48; i++)
    await fixture.backend.appendHistoryTurn(nativeUser(`p2-cursor-${i}`));
  let owner: NodeLodyHistory | undefined;
  const read = NodeLodyHistory.prototype.readActiveBranchMembers;
  const hook = vi
    .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMembers')
    .mockImplementation(function (...args) {
      owner = this;
      return read.apply(this, args);
    });
  await fixture.backend.history.readLatestDirectoryPage!(7);
  hook.mockRestore();
  if (!owner) throw new Error('Missing Native owner');
  for (const sparse of [false, true]) {
    if (sparse)
      await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'p2-cursor-17' });
    const latest = await owner.readActiveBranchPage(fixture.doc.sessionId, {
      latest: true,
      limit: 7,
    });
    expect(latest.cursor).toBeDefined();
    const bodies = await owner.readActiveBranchPage(fixture.doc.sessionId, {
      before: latest.cursor!,
      limit: 7,
    });
    const fields = await owner.readActiveBranchMembers(fixture.doc.sessionId, {
      before: latest.cursor!,
      limit: 7,
    });
    expect(fields.startPosition).toBe(bodies.startPosition);
    expect(fields.totalCount).toBe(bodies.totalCount);
    expect(
      fields.members.map((m) => [m.businessId, m.segmentId, Buffer.from(m.turnId).toString('hex')])
    ).toEqual(
      bodies.messages.map((m) => [m.businessId, m.segmentId, Buffer.from(m.turnId).toString('hex')])
    );
  }
});
