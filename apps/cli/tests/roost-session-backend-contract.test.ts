import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoroRepo } from 'loro-repo';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import Database from 'better-sqlite3';
import {
  encryptCodeCollabV2RpcPayload,
  type SessionHistoryRpcRequest,
} from '@lody/loro-streams-rpc';
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
import { createSessionBackend, type SessionBackendFactory } from '../src/session/session-backend';
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
  type SessionHistoryWriteResponse,
} from '@lody/shared';
import { MessageHandler } from '../src/lib/message-handler';
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
      writeSessionHistoryForRpc(
        id: SessionId,
        operation: 'append',
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
    const original = NodeLodyHistory.prototype.commitHistoryBatch;
    let injected = false;
    const spy = vi
      .spyOn(NodeLodyHistory.prototype, 'commitHistoryBatch')
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

  it('deduplicates durable per-item retries and retains identical output with different identities', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('retry-a'),
      items: [{ type: 'text', text: 'start:' }],
    });
    const original = NodeLodyHistory.prototype.commitHistoryBatch;
    const spy = vi
      .spyOn(NodeLodyHistory.prototype, 'commitHistoryBatch')
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
});

describe('Production Roost immutable input acceptance', () => {
  const inputPort = (fixture: Awaited<ReturnType<typeof nativeFixture>>) => {
    const port = fixture.backend.inputAcceptance;
    if (!port) throw new Error('Expected immutable input acceptance');
    return port;
  };

  it('keeps committed inputs dispatchable in history order independently of reply observation and later activation pointers', async () => {
    const fixture = await nativeFixture();
    const first = nativeUser('first-input'), second = nativeUser('second-input');
    await inputPort(fixture).accept(first); await inputPort(fixture).accept(second);
    const found = await fixture.repo.getDocMeta(getSessionRoomId(fixture.doc.sessionId));
    const meta = { ...found?.meta, latestUserMsgId: second.id } as SessionMeta;
    expect(findNextDispatchableUserTurn(await fixture.backend.readHistory(), meta)?.id).toBe(first.id);
    await fixture.backend.applyHistoryAction({ kind: 'user-status', turnId: first.id, status: 'handled' });
    expect(findNextDispatchableUserTurn(await fixture.backend.readHistory(), meta)?.id).toBe(second.id);
    await fixture.backend.applyHistoryAction({ kind: 'user-status', turnId: second.id, status: 'handled' });
    expect(findNextDispatchableUserTurn(await fixture.backend.readHistory(), { ...meta, lastHandledUserMsgId: second.id })).toBeNull();
    expect(await inputPort(fixture).accept(first)).toEqual({ status: 'accepted', turnId: first.id, active: true });
    expect((await fixture.backend.readHistory()).map(turn => [turn.id, turn.status])).toEqual([[first.id, 'handled'], [second.id, 'handled']]);
  });

  it.each(['retry-first', 'replacement-first', 'removed-after-original'] as const)(
    'converges a delayed original and the same immutable retry: %s', async scenario => {
      const source = await nativeFixture();
      await source.backend.appendHistoryTurn(nativeUser('baseline'));
      const peer = await nativeFixture(source.doc.sessionId);
      const input = nativeUser('delayed-original');
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const originalRequest = RoostNativeClient.prototype.request;
      let gated = false;
      const spy = vi.spyOn(RoostNativeClient.prototype, 'request').mockImplementation(async function(request, options) {
        if (!gated && request.method === 'writeBatch' && request.stream === `lody-session:${source.doc.sessionId}` &&
            request.indexPuts?.some(put => put.table === 'lody_history_branch_operations_v1')) {
          gated = true; entered.resolve(); await release.promise;
        }
        return originalRequest.call(this, request, options);
      });
      const initial = inputPort(source).accept(input);
      void initial.catch(() => {});
      try {
        await entered.promise;
        expect(await inputPort(peer).lookup(input)).toEqual({ status: 'unobserved' });
        if (scenario === 'removed-after-original') {
          release.resolve(); await initial;
          await peer.backend.applyHistoryAction({ kind: 'remove-turn', turnId: input.id });
          expect(await inputPort(peer).accept(input)).toEqual({ status: 'accepted', turnId: input.id, active: false });
          expect((await peer.backend.readHistory()).map(turn => turn.id)).toEqual(['baseline']);
        } else {
          if (scenario === 'replacement-first') await peer.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'baseline' });
          expect(await inputPort(peer).accept(input)).toEqual({ status: 'accepted', turnId: input.id, active: true });
          release.resolve();
          expect(await initial).toEqual({ status: 'accepted', turnId: input.id, active: true });
          const expected = scenario === 'replacement-first' ? [input.id] : ['baseline', input.id];
          expect((await source.backend.readHistory()).map(turn => turn.id)).toEqual(expected);
          expect((await peer.backend.readHistory()).map(turn => turn.id)).toEqual(expected);
        }
        await source.close(); await peer.close();
        const reopened = await nativeFixture(source.doc.sessionId);
        expect(await inputPort(reopened).lookup(input)).toEqual({ status: 'accepted', turnId: input.id, active: scenario !== 'removed-after-original' });
      } finally { release.resolve(); await initial.catch(() => {}); spy.mockRestore(); }
    }
  );

  it('recovers the original input receipt after state changes and owner reopen without another history append', async () => {
    const id = `immutable-input-${ordinal++}`;
    let fixture = await nativeFixture(id);
    const input = nativeUser('immutable-user');
    expect(await inputPort(fixture).lookup(input)).toEqual({ status: 'unobserved' });
    expect(await fixture.backend.readHistory()).toEqual([]);
    expect(await inputPort(fixture).accept(input)).toEqual({ status: 'accepted', turnId: input.id, active: true });
    await fixture.backend.applyHistoryAction({ kind: 'user-status', turnId: input.id, status: 'handled' });
    await fixture.backend.appendHistoryTurn(nativeAssistant('later-assistant'));
    const before = await fixture.backend.readHistory();
    expect(await inputPort(fixture).accept(input)).toEqual({ status: 'accepted', turnId: input.id, active: true });
    expect(await fixture.backend.readHistory()).toEqual(before);
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await inputPort(fixture).lookup(input)).toEqual({ status: 'accepted', turnId: input.id, active: true });
    expect(await fixture.backend.readHistory()).toEqual(before);
    await expect(inputPort(fixture).accept({ ...input, items: [{ type: 'text', text: 'conflicting input' }] })).rejects.toMatchObject({ code: 'conflict' });
    expect(await fixture.backend.readHistory()).toEqual(before);
    await fixture.close();
  });

  it('does not mistake unreadable accepted history for a removed input', async () => {
    const fixture = await nativeFixture();
    const input = nativeUser('unreadable-input');
    await inputPort(fixture).accept(input);
    const read = vi.spyOn(fixture.backend.history, 'readTurn').mockResolvedValue({ state: 'unavailable', reason: 'incomplete' });
    await expect(inputPort(fixture).lookup(input)).rejects.toThrow('not readable');
    read.mockRestore();
    expect(await inputPort(fixture).lookup(input)).toEqual({ status: 'accepted', turnId: input.id, active: true });
    expect((await fixture.backend.readHistory()).map(turn => turn.id)).toEqual([input.id]);
  });

  it('retains receipts across branch removal and storage-generation replacement', async () => {
    const id = `immutable-generation-${ordinal++}`;
    let fixture = await nativeFixture(id);
    const input = nativeUser('removed-input');
    await inputPort(fixture).accept(input);
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: input.id });
    expect(await fixture.backend.readHistory()).toEqual([]);
    expect(await inputPort(fixture).accept(input)).toEqual({ status: 'accepted', turnId: input.id, active: false });
    expect(await fixture.backend.readHistory()).toEqual([]);
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await inputPort(fixture).lookup(input)).toEqual({ status: 'accepted', turnId: input.id, active: false });
    expect(await inputPort(fixture).accept(input)).toEqual({ status: 'accepted', turnId: input.id, active: false });
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
