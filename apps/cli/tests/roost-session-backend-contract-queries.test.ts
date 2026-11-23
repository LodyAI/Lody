import {
  LoroStreamsMachineRpcClient,
  LoroStreamsMachineRpcServer,
  type LoroJsonLiveBatchHandler,
  type LoroStreamsJsonStreamClient,
} from '@lody/loro-streams-rpc';
import {
  SessionHistoryChangesSchema,
  SessionHistoryReadResponseSchema,
  type MachineId,
  type SessionHistoryDirectoryPage,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { createRoostDirectoryRow } from '@lody/shared/session-data';
import { decodeBatch, Identity } from '@loro-dev/roost';
import { RoostNativeClient } from '@loro-dev/roost-node';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import { Effect } from 'effect';
import { LoroDoc } from 'loro-crdt';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createRoostHistoryCache } from '../../../packages/components/src/lib/roost-history-cache';
import { createRemoteRoostSessionDataFactory } from '../../../packages/components/src/lib/roost-session-bridge';
import { AGENT_RECEIPTS_TABLE } from '../src/session/roost-content-patches';
import { RoostHistoryCatchup } from '../src/session/roost-history-catchup';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { loadRoostOwnerSeedLegacy } from '../src/session/roost-writer-identity';
import { createSessionBackend } from '../src/session/session-backend';
import {
  getSessionHistoryRpcRejection,
  putSessionHistoryRpcRejection,
} from '../src/session/session-history-rpc-rejections';
import { getDefaultLogger } from '../src/utils/logger';
import {
  coldHistoryHandlerFixture,
  nativeAssistant,
  nativeDirectory,
  nativeFixture,
  nativeUser,
  nextOrdinal,
  registerRoostNativeBackendSuite,
} from './roost-session-backend-test-helpers';

function installRendererCache() {
  // The renderer package owns its browser test dependency.
  const require = createRequire(
    new URL('../../../packages/components/package.json', import.meta.url)
  );
  const idb = require('fake-indexeddb') as {
    IDBFactory: new () => IDBFactory;
    IDBKeyRange: typeof IDBKeyRange;
  };
  vi.stubGlobal('indexedDB', new idb.IDBFactory());
  vi.stubGlobal('IDBKeyRange', idb.IDBKeyRange);
}

function pauseFirstReceiptPage(sessionId: SessionId) {
  const delivered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const open = RoostNativeClient.prototype.stream;
  vi.spyOn(RoostNativeClient.prototype, 'stream').mockImplementation(function (id) {
    const stream = open.call(this, id);
    if (id === `lody-session:${sessionId}`) {
      const readPage = stream.commitMetadataAfter.bind(stream);
      vi.spyOn(stream, 'commitMetadataAfter').mockImplementationOnce(async (...args) => {
        const page = await readPage(...args);
        delivered.resolve();
        await release.promise;
        return page;
      });
    }
    return stream;
  });
  return { delivered: delivered.promise, release: release.resolve };
}

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
      installRendererCache();
      const fixture = await coldHistoryHandlerFixture(1);
      const sessionId = [...fixture.docs.keys()][0];
      if (!sessionId) throw new Error('Missing synthetic session');
      const host = fixture.handler as unknown as {
        beginConversationTurn(id: SessionId, userTurnId: string): string;
        enqueueACPUpdate(id: SessionId, value: import('@lody/shared').AcpSessionNotification): void;
        flushACPUpdatesNow(id: SessionId): Promise<void>;
        subscribeSessionHistory: NonNullable<
          ConstructorParameters<typeof LoroStreamsMachineRpcServer>[0]['subscribeSessionHistory']
        >;
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
        subscribeSessionHistory: (args) => {
          if (args.subscription.action === 'open') observations++;
          return host.subscribeSessionHistory(args);
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
        const wait = backend.history.waitForChanges;
        if (!wait) throw new Error('Missing native checkpoint observation');
        vi.spyOn(backend.history, 'waitForChanges').mockImplementation((checkpoint, signal) => {
          const waiting = wait(checkpoint, signal);
          if (++checkedObservations === 2) parked.resolve();
          return waiting;
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
        let timerReady = Promise.withResolvers<void>();
        const setTimer = globalThis.setTimeout;
        const clearTimer = globalThis.clearTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
          const scheduled =
            // The two lost reads below need both the first and second retry.
            // Do not drive longer timers that also serve as RPC deadlines.
            args[1] === 0 || args[1] === 500 || args[1] === 1_000 ? recoveryTimers : undefined;
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
            live: true,
            patches: index === 0,
            subscribeHistory: async (_machine, id, subscription, publish, signal) => {
              await client.requestSessionHistorySubscription({
                sessionId: id,
                readProof: 'synthetic-proof',
                subscription,
                signal,
                onPublication: (publication) => {
                  const { delta, ...checkpoint } = publication;
                  if (delta && !lostReadReplies) {
                    const change = SessionHistoryChangesSchema.parse(delta.response.result);
                    if (change.state === 'ready' && change.patches) {
                      expect(index).toBe(0);
                      receivedContentPatches = true;
                    }
                  }
                  publish(lostReadReplies ? checkpoint : publication);
                },
              });
            },
            requestHistoryRead: async (_machine, id, query) => {
              if (query.kind === 'readChanges')
                expect(query.withPatches).toBe(index === 0 ? true : undefined);
              const result = await client.requestSessionHistoryRead({ sessionId: id, query });
              if (!result) throw new Error('Missing history read response');
              const remaining = remainingReadFailures[index] ?? 0;
              if (query.kind === 'readChanges' && remaining > 0) {
                remainingReadFailures[index] = remaining - 1;
                throw new Error('Synthetic history read reply loss');
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
        expect(observations).toBe(2);
        remainingReadFailures.fill(lostReadReplies);
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

  it('keeps every catch-up page and changed body readable after the owner advances', async ({
    onTestFinished,
  }) => {
    const fixture = await coldHistoryHandlerFixture(2);
    const [sessionId, otherSessionId] = [...fixture.docs.keys()];
    if (!sessionId || !otherSessionId) throw new Error('Missing synthetic sessions');
    const paused = pauseFirstReceiptPage(sessionId);
    onTestFinished(paused.release);
    try {
      await fixture.ready(sessionId);
      await fixture.ready(otherSessionId);
      const write = (operation: 'append' | 'apply_action', payload: Record<string, unknown>) =>
        fixture.rpc.writeSessionHistoryForRpc(sessionId, operation, payload);
      expect(await write('append', { entry: nativeUser('cached') })).toMatchObject({
        success: true,
      });
      const base = await fixture.rpc.readSessionHistoryForRpc(sessionId, {
        kind: 'readLatestPage',
        withCheckpoint: true,
        limit: 40,
      });
      const baseCheckpoint = (base.result as { checkpoint?: string }).checkpoint;
      if (!baseCheckpoint) throw new Error('Missing base checkpoint');
      const doc = fixture.docs.get(sessionId);
      if (!doc) throw new Error('Missing synthetic document');
      const backend = await createSessionBackend(doc);
      await backend.applyHistoryAction({
        kind: 'user-status',
        turnId: 'cached',
        status: 'handled',
      });
      for (let index = 0; index < 500; index++) {
        await backend.appendHistoryTurn(nativeUser(`missing-${index}`));
      }
      const active = nativeAssistant('still-writing');
      await backend.appendHistoryTurn({
        ...active,
        items: [{ type: 'text', text: 'captured' }],
      });
      const edit = async (text: string) => {
        expect(
          await write('apply_action', {
            action: {
              kind: 'assistant-items',
              mode: 'replace',
              turnId: active.id,
              items: [{ type: 'text', text }],
            },
          })
        ).toMatchObject({ success: true });
      };
      let writeDuringPage: Promise<unknown> | undefined;
      const hydrate = NodeLodyHistory.prototype.readActiveBranchMessages;
      vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages').mockImplementation(
        async function (view, ids) {
          if (!writeDuringPage && ids.length === 500 && ids[0] === 'missing-0') {
            writeDuringPage = Promise.all([
              backend.applyHistoryAction({
                kind: 'user-status',
                turnId: 'missing-0',
                status: 'handled',
              }),
              backend.applyAgentBatch({
                targetAssistantEntryId: active.id,
                operationIds: ['publication-during-hydration'],
                notifications: [
                  {
                    sessionId,
                    update: {
                      sessionUpdate: 'agent_message_chunk',
                      content: { type: 'text', text: ' and capture' },
                    },
                  },
                ],
              }),
              backend.appendHistoryTurn(nativeUser('appended-during-hydration')),
            ]);
            void writeDuringPage.catch(() => {});
          }
          return hydrate.call(this, view, ids);
        }
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const reading = fixture.rpc.readSessionHistoryForRpc(sessionId, {
        kind: 'readChanges',
        checkpoint: baseCheckpoint,
        includeBodiesFrom: 0,
      });
      await Promise.race([
        paused.delivered,
        reading.then(() => {
          throw new Error('Expected paged receipt scan');
        }),
      ]);
      await edit('captured during scan');
      paused.release();
      const plan = await reading;
      if (!writeDuringPage) throw new Error('Expected a write during body capture');
      await writeDuringPage;
      const published = await backend.history.getPublication?.();
      expect(plan).toMatchObject({
        success: true,
        historyCount: 503,
        historyRevision: published?.historyRevision,
      });
      const changes = SessionHistoryChangesSchema.parse(plan.result);
      expect(changes).toMatchObject({
        state: 'ready',
        checkpoint: published?.checkpoint,
        from: 1,
        ids: expect.arrayContaining(['cached', active.id]),
      });
      if (changes.state !== 'ready') throw new Error('Expected exact catch-up interval');
      expect(changes.bodies).toBeUndefined();
      const range = (from: number, to: number) => ({
        kind: 'readRange' as const,
        from,
        to,
        atCheckpoint: changes.checkpoint,
      });
      await edit('new before first page');
      const first = await fixture.rpc.readSessionHistoryForRpc(sessionId, range(1, 501));
      expect(first).toMatchObject({ success: true, historyRevision: plan.historyRevision });
      expect(first.result).toHaveLength(500);
      expect((first.result as unknown[])[0]).toMatchObject({
        state: 'ready',
        turn: { id: 'missing-0', status: 'handled' },
      });
      await edit('new before last page');
      const last = await fixture.rpc.readSessionHistoryForRpc(sessionId, range(501, 503));
      expect(last).toMatchObject({
        success: true,
        historyRevision: plan.historyRevision,
        result: [
          {
            state: 'ready',
            turn: { id: active.id, items: [{ text: 'captured during scan and capture' }] },
          },
          { state: 'ready', turn: { id: 'appended-during-hydration' } },
        ],
      });
      expect(
        await fixture.rpc.readSessionHistoryForRpc(sessionId, {
          kind: 'readTurn',
          turnId: 'cached',
          atCheckpoint: changes.checkpoint,
        })
      ).toMatchObject({
        success: true,
        historyRevision: plan.historyRevision,
        result: { state: 'ready', turn: { id: 'cached', status: 'handled' } },
      });
      expect(
        await fixture.rpc.readSessionHistoryForRpc(otherSessionId, range(1, 501))
      ).toMatchObject({ success: false, retryReason: 'superseded' });
      expect(await fixture.rpc.readSessionHistoryForRpc(sessionId, range(0, 1))).toMatchObject({
        success: false,
        retryReason: 'superseded',
      });
      const observe = {
        kind: 'readChanges' as const,
        checkpoint: baseCheckpoint,
        includeBodiesFrom: 0,
        inlineOnly: true as const,
      };
      const advertised = await fixture.rpc.readSessionHistoryForRpc(sessionId, observe);
      expect(advertised.success).toBe(true);
      const advertisedChanges = SessionHistoryChangesSchema.parse(advertised.result);
      expect(advertisedChanges.state).toBe('ready');
      await edit('after the observation');
      expect(
        await fixture.rpc.readSessionHistoryForRpc(sessionId, {
          ...range(1, 501),
          atCheckpoint: advertisedChanges.checkpoint,
        })
      ).toMatchObject({ success: false, retryReason: 'superseded' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await fixture.rpc.readSessionHistoryForRpc(sessionId, range(501, 502))).toMatchObject({
        success: false,
        retryReason: 'superseded',
      });
    } finally {
      paused.release();
      vi.useRealTimers();
      await fixture.close();
    }
  }, 120_000);

  it('resumes body preparation after every reader times out and the owner publishes', async () => {
    const fixture = await coldHistoryHandlerFixture(1);
    const sessionId = [...fixture.docs.keys()][0]!;
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(release.resolve);
    try {
      await fixture.ready(sessionId);
      const active = nativeAssistant('shared-catchup-agent');
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'append', { entry: active })
      ).toMatchObject({ success: true });
      const backend = await createSessionBackend(fixture.docs.get(sessionId)!);
      const initial = await backend.history.getPublication?.();
      if (!initial) throw new Error('Expected the initial owner checkpoint');
      for (let index = 0; index < 501; index++)
        await backend.appendHistoryTurn(nativeUser(`shared-missed-${index}`));

      // Hold the final receipt scan outside the writer queue after staging the pages.
      const prepare = RoostHistoryCatchup.prototype.prepare;
      vi.spyOn(RoostHistoryCatchup.prototype, 'prepare').mockImplementation(function (args) {
        return prepare.call(this, {
          ...args,
          finish: async (capture, signal) => {
            staged.resolve();
            await release.promise;
            return args.finish(capture, signal);
          },
        });
      });
      const hydrate = NodeLodyHistory.prototype.readActiveBranchMessages;
      let firstPageReads = 0;
      vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages').mockImplementation(
        async function (view, ids) {
          if (ids.length === 500 && ids[0] === 'shared-missed-0') firstPageReads++;
          return hydrate.call(this, view, ids);
        }
      );
      const query = {
        kind: 'readChanges' as const,
        checkpoint: initial.checkpoint,
        includeBodiesFrom: 0,
      };
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const firstAbort = new AbortController();
      const timeout = new Error('Synthetic 30-second history read timeout');
      setTimeout(() => firstAbort.abort(timeout), 30_000);
      const first = fixture.rpc.readSessionHistoryForRpc(sessionId, query, firstAbort.signal);
      const secondAbort = new AbortController();
      const second = fixture.rpc.readSessionHistoryForRpc(sessionId, query, secondAbort.signal);
      await Promise.race([
        staged.promise,
        first.then(() => {
          throw new Error('Expected detached history preparation');
        }),
      ]);
      const disconnected = new Error('Synthetic reader timed out during body preparation');
      secondAbort.abort(disconnected);
      expect(await second).toMatchObject({ success: false, error: disconnected.message });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await first).toMatchObject({ success: false, error: timeout.message });

      await backend.applyAgentBatch({
        targetAssistantEntryId: active.id,
        operationIds: ['output-during-retry'],
        notifications: [
          {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Agent output after the timeout' },
            },
          },
        ],
      });
      const published = await backend.history.getPublication?.();
      const retry = fixture.rpc.readSessionHistoryForRpc(sessionId, query);
      release.resolve();

      const plan = await retry;
      expect(plan).toMatchObject({
        success: true,
        historyCount: 502,
        historyRevision: published?.historyRevision,
      });
      const changes = SessionHistoryChangesSchema.parse(plan.result);
      expect(changes).toMatchObject({
        state: 'ready',
        checkpoint: published?.checkpoint,
        ids: expect.arrayContaining([active.id]),
      });
      const [firstPage, lastPage, agent] = await Promise.all([
        fixture.rpc.readSessionHistoryForRpc(sessionId, {
          kind: 'readRange',
          from: 1,
          to: 501,
          atCheckpoint: changes.checkpoint,
        }),
        fixture.rpc.readSessionHistoryForRpc(sessionId, {
          kind: 'readRange',
          from: 501,
          to: 502,
          atCheckpoint: changes.checkpoint,
        }),
        fixture.rpc.readSessionHistoryForRpc(sessionId, {
          kind: 'readTurn',
          turnId: active.id,
          atCheckpoint: changes.checkpoint,
        }),
      ]);
      expect(firstPage.result).toHaveLength(500);
      expect(lastPage.result).toMatchObject([{ turn: { id: 'shared-missed-500' } }]);
      expect(agent.result).toMatchObject({
        state: 'ready',
        turn: { items: [{ text: 'Agent output after the timeout' }] },
      });
      expect(firstPageReads).toBe(1);
    } finally {
      release.resolve();
      vi.useRealTimers();
      await fixture.close();
    }
  }, 120_000);

  it('commits Agent output while a cancelled history read is between receipt pages', async ({
    onTestFinished,
  }) => {
    const fixture = await coldHistoryHandlerFixture(1);
    const sessionId = [...fixture.docs.keys()][0];
    const doc = sessionId && fixture.docs.get(sessionId);
    if (!sessionId || !doc) throw new Error('Missing synthetic session');
    const paused = pauseFirstReceiptPage(sessionId);
    onTestFinished(paused.release);
    try {
      await fixture.ready(sessionId);
      const active = nativeAssistant('writing-during-history-read');
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'append', { entry: active })
      ).toMatchObject({ success: true });
      const backend = await createSessionBackend(doc);
      const checkpoint = await backend.history.getCheckpoint?.();
      if (!checkpoint) throw new Error('Missing owner checkpoint');
      for (let index = 0; index < 130; index++)
        await backend.appendHistoryTurn(nativeUser(`missed-${index}`));
      const abort = new AbortController();
      const reading = fixture.rpc.readSessionHistoryForRpc(
        sessionId,
        {
          kind: 'readChanges',
          checkpoint,
          includeBodiesFrom: 0,
          withPatches: true,
        },
        abort.signal
      );
      await Promise.race([
        paused.delivered,
        reading.then(() => {
          throw new Error('Expected paged receipt scan');
        }),
      ]);
      abort.abort(new Error('Synthetic reader disconnected'));
      await backend.applyAgentBatch({
        targetAssistantEntryId: active.id,
        operationIds: ['output-during-cancelled-read'],
        notifications: [
          {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'committed' },
            },
          },
        ],
      });
      expect(await backend.history.readTurn(active.id)).toMatchObject({
        state: 'ready',
        turn: { items: [{ text: 'committed' }] },
      });
      paused.release();
      expect(await reading).toMatchObject({
        success: false,
        error: 'Synthetic reader disconnected',
      });
    } finally {
      paused.release();
      await fixture.close();
    }
  });

  it('preserves a reconnecting reader’s cached prefix under another session’s capture pressure', async () => {
    installRendererCache();
    const fixture = await coldHistoryHandlerFixture(2);
    const [busyId, sessionId] = [...fixture.docs.keys()];
    const busyDoc = busyId && fixture.docs.get(busyId);
    const doc = sessionId && fixture.docs.get(sessionId);
    if (!busyId || !sessionId || !busyDoc || !doc) throw new Error('Missing synthetic sessions');
    let disposeReader = () => {};
    try {
      await fixture.ready(busyId);
      await fixture.ready(sessionId);
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(busyId, 'append', {
          entry: nativeAssistant('busy-agent'),
        })
      ).toMatchObject({ success: true });
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'append', {
          entry: nativeUser('cached-before-disconnect'),
        })
      ).toMatchObject({ success: true });
      const accountId = 'synthetic-cache-pressure';
      const workspaceId = 'test-workspace' as WorkspaceId;
      const machineId = 'test-machine' as MachineId;
      const cache = createRoostHistoryCache(
        JSON.stringify([accountId, workspaceId, machineId, sessionId])
      );
      const before = await fixture.rpc.readSessionHistoryForRpc(sessionId, {
        kind: 'readLatestPage',
        limit: 40,
        withCheckpoint: true,
      });
      if (!before.success || before.historyRevision === undefined || !before.pageTurns)
        throw new Error('Missing initial history page');
      expect(
        await cache.acceptPage(
          before.result as SessionHistoryDirectoryPage,
          before.pageTurns,
          before.historyRevision
        )
      ).toBe(true);
      const busy = await createSessionBackend(busyDoc);
      const backend = await createSessionBackend(doc);
      const busyCheckpoint = await busy.history.getCheckpoint?.();
      if (!busyCheckpoint) throw new Error('Missing owner checkpoint');
      for (let index = 0; index < 501; index++)
        await Promise.all([
          busy.appendHistoryTurn(nativeUser(`busy-missed-${index}`)),
          backend.appendHistoryTurn(nativeUser(`missed-${index}`)),
        ]);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let oldestCapture: string | undefined;
      for (let index = 0; index < 16; index++) {
        await busy.applyHistoryAction({
          kind: 'assistant-items',
          mode: 'replace',
          turnId: 'busy-agent',
          items: [{ type: 'text', text: `Agent output ${index}` }],
        });
        const reply = await fixture.rpc.readSessionHistoryForRpc(busyId, {
          kind: 'readChanges',
          checkpoint: busyCheckpoint,
          includeBodiesFrom: 0,
        });
        expect(reply.success).toBe(true);
        const changes = SessionHistoryChangesSchema.parse(reply.result);
        expect(changes.state).toBe('ready');
        oldestCapture ??= changes.checkpoint;
      }
      // The first capture is still retained after all sixteen owner publications.
      expect(
        await fixture.rpc.readSessionHistoryForRpc(busyId, {
          kind: 'readRange',
          atCheckpoint: oldestCapture,
          from: 1,
          to: 2,
        })
      ).toMatchObject({ success: true });

      const target = await backend.history.getCheckpoint?.();
      if (!target) throw new Error('Missing recovery target');
      const committed = Promise.withResolvers<void>();
      let online = true;
      const reader = createRemoteRoostSessionDataFactory({
        accountId,
        workspaceId,
        machineId,
        incremental: true,
        patches: true,
        requestHistoryRead: async (_machine, id, query) => {
          if (!online) throw new Error('Synthetic reader offline');
          return fixture.rpc.readSessionHistoryForRpc(id, query);
        },
        requestHistoryWrite: async () => {
          throw new Error('Unexpected write');
        },
      })({ sessionId, doc: new LoroDoc(), backendKind: 'roost' });
      const observation = reader.history.observe(() => {
        void cache.getHead().then((head) => {
          if (head?.checkpoint === target) committed.resolve();
        }, committed.reject);
      });
      disposeReader = () => {
        observation.unsubscribe();
        reader.dispose?.();
      };
      await observation.initial;
      await vi.advanceTimersByTimeAsync(0);
      await committed.promise;
      online = false;
      expect(await cache.getHead()).toMatchObject({ checkpoint: target, start: 0, count: 502 });
      expect(await reader.history.readTurn('cached-before-disconnect')).toMatchObject({
        state: 'ready',
      });
      expect(await reader.history.readTurn('missed-500')).toMatchObject({ state: 'ready' });
    } finally {
      disposeReader();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      await fixture.close();
    }
  }, 120_000);

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
});
