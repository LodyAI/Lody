import { signExecutionIntent } from '@lody/e2ee-core/protocol';
import { E2EE_INTENT_KIND, encodeE2eeIntentRecord, turnExecutionDigest } from '@lody/shared';
import { envelopeFixture } from '../../../packages/e2ee-core/test/keys/fixture';
import { makeVerifiedExecutionIntent } from '../src/lib/e2ee/execution-intent-verification';
import { prepareReplacement } from '@lody/shared/history-writer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { LoroRepo } from 'loro-repo';
import { LoroDoc } from 'loro-crdt';
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
import {
  createSessionBackend,
  routeRemoteOwnedSessionHistory,
} from '../src/session/session-backend';
import { NodeLodyHistory, type HistoryIdentity } from '@loro-dev/roost/lody-history';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  applyNotificationOnHistory,
  SessionHistoryReadResponseSchema,
  SessionHistoryWriteResponseSchema,
  getMachineRoomId,
  getSessionRoomId,
  SessionStatusFactory,
  type SessionId,
  type SessionHistoryInput,
  type SessionHistoryReadResponse,
  SessionHistoryChangesSchema,
  type SessionHistoryWriteResponse,
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
  hashHistoryEntryForVersion,
  hashText,
  applyHistoryAction,
} from '@lody/shared/session-data';
import { Identity } from '@loro-dev/roost';
import { RoostNativeClient, RoostHostError } from '@loro-dev/roost-node';
import { describeRoostHistoryFailure } from '../src/session/roost-history-diagnostics';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { encodeRoostHistoryChange } from '../src/session/roost-history-change-codec';
import {
  agentReceiptKey,
  agentReceiptPut,
  decodeAgentReceipt,
} from '../src/session/roost-content-patches';
import { findNextDispatchableUserTurn } from '../src/session/session-dispatch-logic';
import type { SessionMeta } from '@lody/shared';
import { ROOST_HEAD_KEY } from '../src/session/roost-history-head';
import { loadRoostOwnerSeedLegacy } from '../src/session/roost-writer-identity';
import { defineSessionBackendContract } from './session-backend-contract';
import {
  coldHistoryHandlerFixture,
  nativeAssistant,
  nativeContractFixture,
  nativeDirectory,
  nativeFixture,
  nativeUser,
  nextOrdinal,
  registerRoostNativeBackendSuite,
} from './roost-session-backend-test-helpers';

registerRoostNativeBackendSuite();
defineSessionBackendContract('Production Roost SQLite', nativeContractFixture);

describe('Production Roost history semantics', () => {
  it('isolates simultaneous encrypted and ordinary owner histories with identical session IDs', async () => {
    const id = 'same-session';
    const paths = ['encrypted-a', 'encrypted-b'].map((name) => join(nativeDirectory, name));
    const sessions = await Promise.all(
      [undefined, ...paths].map((dir) => nativeFixture(id, false, undefined, dir))
    );
    try {
      for (const [index, session] of sessions.entries())
        await session.backend.appendHistoryTurn(nativeUser('private-' + index));
      await sessions[1]!.close();
      sessions[1] = await nativeFixture(id, false, undefined, paths[0]);
      for (const [index, session] of sessions.entries())
        expect((await session.backend.readHistory()).map((turn) => turn.id)).toEqual([
          'private-' + index,
        ]);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
  });
  it('cancels parked history observers without cancelling a writer waiting for the same owner', async () => {
    const fixture = await coldHistoryHandlerFixture(1);
    const id = [...fixture.docs.keys()][0]!;
    const replies: unknown[] = [];
    const watching = fixture.handler.handleMessage(
      {
        type: 'session/history-subscription',
        workspaceId: 'test-workspace' as WorkspaceId,
        machineId: 'test-machine' as MachineId,
        sessionId: id,
        subscription: { action: 'open', id: crypto.randomUUID() },
      },
      { source: 'local', send: (response) => replies.push(response) }
    );
    const writing = fixture.rpc.writeSessionHistoryForRpc(id, 'append', {
      entry: nativeUser('writer-survives-observer-stop'),
    });
    try {
      await fixture.observing(2);
      fixture.handler.cancelPendingHistorySubscriptions();
      await watching;
      expect(replies).toEqual([expect.objectContaining({ event: 'closed' })]);
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
      vi.spyOn(watchedBackend.history, 'waitForChanges').mockImplementation((cursor, signal) => {
        watchSignal = signal;
        const pending = wait(cursor, signal);
        parked.resolve();
        return pending;
      });
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
        type: 'session/history-subscription',
        sessionId: watchedId,
        workspaceId: 'test-workspace' as WorkspaceId,
        machineId: 'test-machine' as MachineId,
        subscription: { action: 'open', id: crypto.randomUUID(), checkpoint },
      });
      await parked.promise;
      closing = runtime.cleanup();
      // Cancellation is synchronous, before the drain can wait on the observer.
      // No native I/O guard or ACP batch timer is advanced to make shutdown pass.
      expect(watchSignal?.aborted).toBe(true);
      expect(await watching).toMatchObject([
        { type: 'session/history-subscription_response', event: 'publication' },
        { type: 'session/history-subscription_response', event: 'closed' },
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
      fixture.handler.cancelPendingHistorySubscriptions();
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

  it('retains an admitted edit proof past the original RPC deadline and rejects renewed envelopes after reopen', async () => {
    const filename = join(nativeDirectory, `rpc-claim-${nextOrdinal()}.sqlite3`);
    const request: SessionHistoryRpcRequest = {
      jsonrpc: '2.0',
      id: 'claimed-edit',
      rpcVersion: '1',
      workspaceId: 'synthetic-workspace' as never,
      machineId: 'synthetic-machine' as never,
      replyTo: 'reply',
      method: 'session/history-write',
      sentAt: 1,
      expiresAt: 30_001,
      params: await encryptCodeCollabV2RpcPayload('session', {
        sessionId: 'session',
        operation: 'append',
        payload: {},
      }),
    };
    const claim = {
      code: 'session_history_write_already_claimed',
      message: 'Outcome may be unknown.',
    } as const;
    await Effect.runPromise(putSessionHistoryRpcRejection(filename, request, claim, 1, 60_001));
    expect(
      await Effect.runPromise(getSessionHistoryRpcRejection(filename, request, 31_001))
    ).toEqual(claim);
    await expect(
      Effect.runPromise(
        getSessionHistoryRpcRejection(
          filename,
          { ...request, sentAt: 31_001, expiresAt: 61_001 },
          31_001
        )
      )
    ).rejects.toMatchObject({ code: 'rpc_request_identity_mismatch' });
    expect(
      await Effect.runPromise(getSessionHistoryRpcRejection(filename, request, 60_001))
    ).toBeNull();
  });

  it('retains rejected RPC identity across SQLite reopen, isolates targets, and removes expired refusals', async () => {
    const filename = join(nativeDirectory, `rpc-refusals-${nextOrdinal()}.sqlite3`);
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
    const blocked = join(nativeDirectory, `blocked-rpc-refusals-${nextOrdinal()}`);
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
      const sessionId = `metadata-${phase}-${nextOrdinal()}` as SessionId;
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

  it('keeps encrypted attachment manifests and their authenticated source session through Roost fork and edit', async () => {
    const { SessionForkService } = await import('../src/session/session-fork-service');
    const { uploadEncryptedAttachment, readEncryptedAttachment } = await import('@lody/shared');
    const directory = join(nativeDirectory, 'attachment-workspace');
    const source = await nativeFixture('attachment-source', false, undefined, directory);
    const { SessionEditAndResendService } =
      await import('../src/session/session-edit-and-resend-service');
    const targetId = 'attachment-fork' as SessionId;
    const target = new SessionDocument(
      source.repo,
      targetId,
      (room) => source.repo.unloadDoc(room),
      undefined,
      undefined,
      directory
    );
    const workspaceDocument = {
      repo: source.repo,
      isEncryptedWorkspace: () => true,
      getOrCreateSessionDoc: async (id: SessionId) => {
        if (id === source.doc.sessionId) return source.doc;
        if (id !== targetId) throw new Error('Unknown session');
        if (!target.handle) {
          target.handle = await source.repo.openPersistedDoc(getSessionRoomId(id));
          target.composeSessionData(target.handle.doc, undefined, { historyBackend: 'roost' });
        }
        return target;
      },
      getAgentConfigById: async () => ({}),
      signMachineInput: async () => 'B'.repeat(131),
      persistPendingChanges: async () => {},
    };
    const agentClient = {
      prepareReplacementSession: async () => ({ sessionId: 'edited-acp' }),
      adoptPreparedSession: () => {},
      closeDetachedSession: async () => true,
    };
    const sessionManager = {
      createSession: async () => {},
      getSession: (id: string) => ({
        acpSessionId: id === targetId ? 'target-acp' : 'source-acp',
        agentClient,
      }),
    };
    const deps = {
      workspaceDocument,
      sessionManager,
      workspaceId: 'workspace',
      machineId: 'test-machine',
      userResolver: { resolve: async () => ({ name: 'User', email: '' }) },
      logger: getDefaultLogger(),
    };
    const plain = new TextEncoder().encode('synthetic attachment');
    const parts = new Map<string, Uint8Array>();
    const workspaceId = 'workspace';
    try {
      const { encryption, sha256 } = await uploadEncryptedAttachment({
        workspaceId,
        sessionId: source.doc.sessionId,
        kind: 'file',
        fileName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: plain.length,
        read: async () => plain.slice(),
        upload: async (bytes, index) => {
          const key = 'part-' + index;
          parts.set(key, bytes.slice());
          return key;
        },
      });
      const file = {
        type: 'file' as const,
        fileId: encryption.parts[0]!,
        encryption,
        fileName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: plain.length,
        sha256,
        textPreview: false,
        transport: 'r2' as const,
        uploadedAt: 1,
      };
      const signed = {
        ...nativeUser('input'),
        e2eeIntent: 'A'.repeat(131),
        inputConfig: { inputBlocks: [file] },
        items: [file],
      };
      await source.backend.inputAcceptance!.accept(signed);
      expect(await source.backend.readTurn('input')).toMatchObject({
        turn: { e2eeIntent: signed.e2eeIntent },
      });
      await source.backend.appendHistoryTurn({ ...nativeAssistant('finished'), finished: true });
      await source.repo.upsertDocMeta(getSessionRoomId(source.doc.sessionId), {
        agentConfigId: 'agent',
        acpSessionId: 'source-acp',
        cliType: 'builtin',
        agentType: 'codex',
      });
      const service = new SessionForkService({ ...deps, isSourceBusy: () => false } as never);
      const forked = await service.fork({
        sourceSessionId: source.doc.sessionId,
        sourceTurnId: 'finished',
        targetSessionId: targetId,
        requestedByUserId: 'test-user',
      });
      expect(forked, JSON.stringify(forked)).toMatchObject({ success: true });
      const backend = await createSessionBackend(target);
      const [copied] = await backend.readHistory();
      const block = copied?.inputConfig?.inputBlocks?.[0];
      if (block?.type !== 'file' || !block.encryption || !block.storageSessionId)
        throw new Error('Lost file namespace');
      expect(copied?.items?.[0]).toMatchObject({
        storageSessionId: source.doc.sessionId,
        encryption,
      });
      const edit = new SessionEditAndResendService({
        ...deps,
        enqueueDispatch: () => {},
        executionService: {
          tryAcquireSessionRewriteBarrier: () => () => {},
          getExecutionSnapshot: () => ({}),
          acceptInboxHumanInput: async () => {},
        },
      } as never);
      const edited = await edit.editAndResend({
        sessionId: targetId,
        expectedUserTurnId: 'input',
        replacementUserTurnId: 'edited',
        requestedByUserId: 'test-user',
        timestamp: signed.timestamp,
        inputConfig: { inputBlocks: [block] },
      });
      expect(edited, JSON.stringify(edited)).toMatchObject({ success: true });
      expect(await backend.readTurn('edited')).toMatchObject({
        turn: { e2eeIntent: 'B'.repeat(131), inputConfig: { inputBlocks: [block] } },
      });
      const decoded = [];
      for await (const bytes of readEncryptedAttachment({
        workspaceId,
        sessionId: block.storageSessionId,
        encryption: block.encryption,
        fetchPart: async (id) => new Response(Uint8Array.from(parts.get(id)!)),
      }))
        decoded.push(...bytes);
      expect(decoded).toEqual([...plain]);
      expect(parts.get('part-0')).not.toEqual(plain);
      expect(target.handle!.doc.getList('history').length).toBe(0);
    } finally {
      await target.destroy({ preserveStatus: true });
      await source.close();
    }
  });
  it('routes encrypted remote owner reads and input acceptance through the feature channel', async () => {
    const ledger = envelopeFixture(1);
    const workspaceId = 'test-workspace';
    const machineId = 'fixture-machine';
    const requesterDevice = Buffer.from(ledger.owner.raw).toString('hex');
    const owner = await coldHistoryHandlerFixture(1, {
      machineId,
      resolveVerifiedExecutionOriginal: makeVerifiedExecutionIntent({
        workspaceId,
        genesis: ledger.context.genesis,
        selfDevice: Buffer.from(ledger.phone.raw).toString('hex'),
        ledger: ledger.ledger,
        refreshLedger: Effect.void,
        isClosed: () => false,
        readIncoming: () => Effect.succeed(null),
        openDispatch: () => Effect.die('unexpected dispatch'),
      }),
    });
    const doc = [...owner.docs.values()][0]!;
    await owner.ready(doc.sessionId);
    await owner.repo.upsertDocMeta(getMachineRoomId(machineId), {
      id: machineId,
      protocolCapabilities: { ...CURRENT_MACHINE_PROTOCOL_CAPABILITIES, e2eeRoostHistory: 1 },
    });
    const context = {
      requestId: 'verified-request',
      requesterDevice,
      expiresAt: Number.MAX_SAFE_INTEGER,
      signal: new AbortController().signal,
      authority: { signal: new AbortController().signal, isCurrent: () => true },
      requester: { accountId: 'test-user', executionUserId: 'test-user' },
    };
    const manager = {
      repo: owner.repo,
      isEncryptedWorkspace: () => true,
      requestEncryptedFeature: async (
        request: import('@lody/shared/local-machine-rpc').LocalMachineRpcRequest
      ) => {
        if (request.method === 'session/history-write')
          return owner.handler.handleLocalMachineRpc(request, context.signal, context);
        if (request.method !== 'session/history-read') throw new Error('unexpected owner request');
        return {
          ok: true,
          result: await owner.rpc.readSessionHistoryForRpc(doc.sessionId, request.params.query),
        };
      },
    };
    const factory = createCommandSessionHistoryFactory(
      () => manager as never,
      { machineId: 'remote', userId: 'test-user' } as AuthContext,
      'test-workspace',
      async () => {
        throw new Error('unexpected plaintext request');
      }
    );
    const route = routeRemoteOwnedSessionHistory('remote', factory);
    const remote = await route(doc, await doc.getMetaState());
    try {
      const entry = {
        ...nativeUser('signed-turn'),
        inputConfig: { prompt: 'signed content', cliType: 'builtin', agentType: 'codex' },
      };
      const signature = await Effect.runPromise(
        signExecutionIntent({
          kind: E2EE_INTENT_KIND.memberInput,
          genesis: ledger.context.genesis,
          workspaceId,
          targetMachineId: machineId,
          scope: doc.sessionId,
          messageId: entry.id,
          contentDigest: Buffer.from(turnExecutionDigest(entry)!, 'hex'),
          signer: ledger.owner.signer,
        })
      );
      entry.e2eeIntent = encodeE2eeIntentRecord({
        kind: E2EE_INTENT_KIND.memberInput,
        signer: ledger.owner.raw,
        signature: signature.toBytes(),
      });
      await expect(
        remote.inputAcceptance!.accept({
          ...entry,
          inputConfig: { ...entry.inputConfig, prompt: 'altered' },
        })
      ).rejects.toThrow();
      expect(await remote.readTurn(entry.id)).toMatchObject({ state: 'missing' });
      await expect(remote.inputAcceptance!.accept(entry)).resolves.toMatchObject({
        status: 'accepted',
        turnId: entry.id,
      });
      await expect(remote.readTurn(entry.id)).resolves.toMatchObject({
        state: 'ready',
        turn: { id: entry.id, e2eeIntent: entry.e2eeIntent },
      });
      await owner.repo.upsertDocMeta(getMachineRoomId(machineId), {
        id: machineId,
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      });
      await expect(route(doc, await doc.getMetaState())).rejects.toThrow(
        'Update the owner machine'
      );
    } finally {
      await remote.dispose();
      await owner.close();
    }
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
        () =>
          ({
            repo: owner.repo,
            isEncryptedWorkspace: () => false,
            waitUntilMetaSynced: async () => true,
          }) as LoroDocumentManager,
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
    // The owner applies concurrent appends in arrival order; only the seed turn's place is fixed.
    const [seed, ...added] = before.map(({ id, userId, author }) => ({ id, userId, author }));
    expect([seed, ...added.sort((a, b) => a.id.localeCompare(b.id))]).toEqual([
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
      () =>
        ({
          repo: owned.repo,
          isEncryptedWorkspace: () => false,
          waitUntilMetaSynced: async () => true,
        }) as LoroDocumentManager,
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
    const id = `immutable-input-${nextOrdinal()}`;
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
    const id = `immutable-generation-${nextOrdinal()}`;
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
