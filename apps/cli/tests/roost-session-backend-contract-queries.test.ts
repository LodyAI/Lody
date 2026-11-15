import {
  readSessionTranscript,
  toSessionTranscriptEntries,
  selectSessionTranscriptEntries,
} from '../src/commands/session';
import { buildReplayPromptFromHistory, createReplayPromptBuilder } from '@lody/shared';
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LoroDoc } from 'loro-crdt';
import { Effect } from 'effect';
import {
  LoroStreamsMachineRpcClient,
  LoroStreamsMachineRpcServer,
  type LoroJsonLiveBatchHandler,
  type LoroStreamsJsonStreamClient,
} from '@lody/loro-streams-rpc';
import { createRemoteRoostSessionDataFactory } from '../../../packages/components/src/lib/roost-session-bridge';
import {
  getSessionHistoryRpcRejection,
  putSessionHistoryRpcRejection,
} from '../src/session/session-history-rpc-rejections';
import { SessionDocument } from '../src/lib/loro/doc';
import {
  createSessionBackend,
  disposeSessionBackend,
  type SessionBackendFactory,
} from '../src/session/session-backend';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  resolveActiveAssistantTurnId,
  SessionHistoryReadQuerySchema,
  SessionHistoryReadResponseSchema,
  getMachineRoomId,
  resolveLatestSessionGoalFromHistory,
  type SessionGoalMessage,
  type SessionId,
  type SessionHistoryInput,
  type SessionHistoryReadQuery,
  SessionHistoryChangesSchema,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { getDefaultLogger } from '../src/utils/logger';
import { createCommandSessionHistoryFactory, type AuthContext } from '../src/lib/command-runtime';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import {
  createRoostDirectoryRow,
  readSessionHistoryMetadata,
  applyHistoryAction,
} from '@lody/shared/session-data';
import { decodeBatch, Identity } from '@loro-dev/roost';
import { RoostNativeClient, RoostHostError } from '@loro-dev/roost-node';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { RoostDispatchIndex } from '../src/session/roost-dispatch-index';
import { dispatchEntry, selectDispatchHistory } from '../src/session/session-dispatch-history';
import { SessionDispatchWatcher } from '../src/session/session-dispatch-watcher';
import type { SessionExecutionService } from '../src/session/session-execution-service';
import { AGENT_RECEIPTS_TABLE } from '../src/session/roost-content-patches';
import { loadRoostOwnerSeedLegacy } from '../src/session/roost-writer-identity';
import {
  coldHistoryHandlerFixture,
  nativeAssistant,
  nativeDirectory,
  nativeFixture,
  nativeUser,
  nextOrdinal,
  registerRoostNativeBackendSuite,
} from './roost-session-backend-test-helpers';

registerRoostNativeBackendSuite();

describe('Production Roost history semantics (replica sync and bounded stream)', () => {
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
      const refusalPath = join(nativeDirectory, `replica-refusals-${nextOrdinal()}.db`);
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
        authorizeSessionHistoryRead: async () => true,
        authorizeSessionHistoryWrite: async () => ({ expiresAt: Date.now() + 60_000 }),
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
    const id = `native-position-pointer-${nextOrdinal()}`;
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
