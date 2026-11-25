import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { createRoostHistoryCache } from '../src/lib/roost-history-cache';
import { createRoostDirectoryRow, readSessionHistoryMetadata } from '@lody/shared/session-data';
import type { SessionHistoryInput, SessionHistoryReadResponse } from '@lody/shared';
import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { Identity, IndexedDbStorage, Store } from '@loro-dev/roost';
import { fromApplicationJson, LodyHistory } from '@loro-dev/roost/lody-history';
import {
  ROOST_HISTORY_BUCKET_ID,
  roostCloudHistoryStreamId,
  roostHistoryAuthorKey,
  roostHistorySourceId,
  RoostCloudHistoryRequestError,
} from '@lody/shared';
import { createRoostHistoryReplica } from '../src/lib/roost-history-replica';

import type { SessionId, MachineId, RoostHistorySyncState, WorkspaceId } from '@lody/shared';
import { createConversationSession } from '../src/lib/conversation-view/create-conversation-session';
import {
  createLocalRoostSessionDataFactory,
  createRemoteRoostSessionDataFactory,
  createRoostSessionDataFactoryForMachine,
} from '../src/lib/roost-session-bridge';

import {
  createLoroStreamsJsonStreamClient,
  encryptCodeCollabV2RpcPayload,
  HISTORY_INPUT_RESPONSE_RECOVERY_MS,
  LoroStreamsLiveModePolicy,
  LoroStreamsMachineRpcClient,
  LoroStreamsRpcResponseDispatcher,
} from '@lody/loro-streams-rpc';

import { createConversationViewFromReader } from '../src/lib/conversation-view/create-conversation-view-from-reader';
import { resolveLocalSessionControlTimeoutMs } from '../../../apps/electron/src/main/services/local-session-control-budget';
import type { SessionDataChange } from '@lody/shared/session-data';

function limitReplicaStorage(isFull: () => boolean) {
  const put = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (isFull() && this.transaction.db.name.startsWith('lody-roost-replica-'))
      throw new DOMException('Replica storage quota exceeded', 'QuotaExceededError');
    return put.apply(this, args);
  });
}

describe('createConversationSession backend seam', () => {
  it.each([
    { status: 401, hint: true },
    { status: 403, hint: true },
    { status: 403, hint: false },
    { status: 404, hint: true },
    { status: 410, hint: true },
  ])(
    'keeps a cloud refusal terminal (HTTP $status, publication hint: $hint)',
    async ({ status, hint }) => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const workspaceId = 'workspace' as WorkspaceId;
      const machineId = 'machine' as MachineId;
      const sessionId = 'session' as SessionId;
      const doc = new LoroDoc();
      const ownerRead = async (): Promise<never> => {
        throw new Error('unexpected owner read');
      };
      let requests = 0;
      let sync: RoostHistorySyncState | undefined;
      const data = createRemoteRoostSessionDataFactory({
        workspaceId,
        machineId,
        requestHistoryRead: ownerRead,
        requestHistoryWrite: ownerRead,
        onHistorySync: (next) => {
          sync = next;
        },
        cloudHistory: () =>
          createRoostHistoryReplica({
            workspaceId,
            machineId,
            sessionId,
            replicaNamespace: `refusal-${status}`,
            getBinding: () =>
              hint ? { generation: 'root', ownerPublicKey: 'A'.repeat(43) } : undefined,
            observeBinding: () => () => {},
            requestGrant: async () => {
              requests++;
              throw new RoostCloudHistoryRequestError(status);
            },
          }),
      })({ doc, sessionId, backendKind: 'roost' });
      const observation = data.history.observe(() => {});
      void observation.initial.catch(() => {});
      try {
        await expect(observation.initialPage).rejects.toMatchObject({ status });
        await expect(data.history.readAll()).rejects.toMatchObject({ status });
        expect(sync).toMatchObject({ source: 'streams', phase: 'refused', httpStatus: status });
        expect(requests).toBe(1);
      } finally {
        observation.unsubscribe();
        data.dispose();
        doc.free();
        vi.unstubAllGlobals();
      }
    }
  );

  it.each(['unavailable', 'requires owner authorization', 'exceeds local storage quota'] as const)(
    'keeps a cached history private when the cloud %s and the machine denies access',
    async (cloud) => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const workspaceId = 'workspace' as WorkspaceId;
      const machineId = 'machine' as MachineId;
      const sessionId = 'denied-owner-cache' as SessionId;
      const binding = { generation: 'root', ownerPublicKey: 'A'.repeat(43) };
      const storage =
        cloud === 'exceeds local storage quota' ? limitReplicaStorage(() => true) : undefined;
      vi.stubGlobal('fetch', async () => {
        throw new Error('Unexpected history transport');
      });
      const cache = createRoostHistoryCache(
        JSON.stringify(['local', workspaceId, machineId, sessionId])
      );
      const oldTurn: SessionHistoryInput = {
        id: 'previously-authorized',
        role: 'user',
        timestamp: '2026-11-01T00:00:00Z',
        items: [{ type: 'text', text: 'Previously readable history' }],
      };
      const doc = new LoroDoc();
      let sync: RoostHistorySyncState | undefined;
      const data = createRemoteRoostSessionDataFactory({
        workspaceId,
        machineId,
        requestHistoryRead: async () => ({
          type: 'session/history-read_response',
          sessionId,
          success: false,
          error: 'session_history_read_denied',
        }),
        requestHistoryWrite: async () => {
          throw new Error('Unexpected history write');
        },
        onHistorySync: (next) => {
          sync = next;
        },
        cloudHistory: () =>
          createRoostHistoryReplica({
            workspaceId,
            machineId,
            sessionId,
            replicaNamespace: 'denied-owner-cache',
            getBinding: () => binding,
            observeBinding: () => () => {},
            requestGrant: async () => {
              if (cloud === 'requires owner authorization') return { state: 'owner-required' };
              if (cloud === 'unavailable') throw new RoostCloudHistoryRequestError(503);
              const streamId = roostCloudHistoryStreamId(
                workspaceId,
                machineId,
                sessionId,
                binding
              );
              return {
                state: 'published',
                binding,
                streamUrl: `https://streams.example.test/ds/${ROOST_HISTORY_BUCKET_ID}/${encodeURIComponent(streamId)}`,
                token: 'synthetic-read-grant',
                expiresIn: 60,
                newerVersionPending: false,
              };
            },
          }),
      })({ doc, sessionId, backendKind: 'roost' });
      try {
        await cache.acceptPage(
          {
            rows: [createRoostDirectoryRow(0, oldTurn)],
            startPosition: 0,
            totalCount: 1,
            hasMoreOlder: false,
            cursor: null,
          },
          [oldTurn],
          1
        );
        await expect(data.history.readLatestDirectoryPage!(40)).rejects.toMatchObject({
          name: 'RoostHistoryError',
        });
        expect(sync?.source).toBe('streams');
      } finally {
        data.dispose();
        cache.dispose();
        doc.free();
        storage?.mockRestore();
        vi.unstubAllGlobals();
      }
    }
  );

  it.each([
    'published',
    'published without a hint',
    'append during metadata',
    'earlier metadata changes',
    'publication notice',
    'publication without notice',
    'grant 503',
    'Streams reverse read 503',
    'published grant 503',
    'published replica exceeds local storage quota',
    'published grant 503 then refusal',
    'published grant 503 then Streams recovers first',
    'published grant 503 then Streams refuses first',
    'published grant 503 without an observer',
    'published grant 503 with both sources unavailable',
    'published grant 503 with a pending machine page when Streams recovers',
    'published grant 503 with a pending machine page when Streams refuses',
    'published grant 503 with a pending machine page when the conversation closes',
    'published grant 503 with an older page across two source switches',
    'published grant 503 then conversation closes',
    'published live 503',
    'published stream replaced while a machine page is pending',
    'published stream replaced while a machine page is pending and the old token expired',
    'published grant refused before a cached read',
    'owner authorization required until the conversation is shared',
  ])(
    'opens Roost on the correct reader and resumes Streams with its owner offline (%s)',
    { timeout: 30_000 },
    async (startingState) => {
      const appendDuringMetadata = startingState === 'append during metadata';
      const editDuringMetadata = startingState === 'earlier metadata changes';
      const updateDuringMetadata = appendDuringMetadata || editDuringMetadata;
      const rotating = startingState.startsWith('published stream replaced');
      const checkingCachedGrant = startingState === 'published grant refused before a cached read';
      const needsOwner =
        startingState === 'owner authorization required until the conversation is shared';
      const liveOutage = startingState === 'published live 503' || rotating;
      const paginating =
        startingState === 'published grant 503 with an older page across two source switches';
      const machinePagePending = startingState.startsWith(
        'published grant 503 with a pending machine page'
      );
      const refuseDuringPage = machinePagePending && startingState.endsWith('Streams refuses');
      const closeDuringPage = machinePagePending && startingState.endsWith('conversation closes');
      const streamsRefusesFirst =
        startingState === 'published grant 503 then Streams refuses first';
      const withoutObserver = startingState === 'published grant 503 without an observer';
      const bothUnavailable = startingState === 'published grant 503 with both sources unavailable';
      const closing = startingState === 'published grant 503 then conversation closes';
      const slowOwner =
        streamsRefusesFirst ||
        withoutObserver ||
        bothUnavailable ||
        closing ||
        startingState === 'published grant 503 then Streams recovers first';
      const quotaExhausted = startingState === 'published replica exceeds local storage quota';
      const grantOutage = startingState.startsWith('published grant 503');
      const cloudOutage = liveOutage || grantOutage || quotaExhausted;
      const alreadyPublished = startingState.startsWith('published') || updateDuringMetadata;
      const discovering = ['grant 503', 'Streams reverse read 503'].includes(startingState);
      let cloudUnavailable = grantOutage || discovering;
      const pendingWithoutNotice = startingState === 'publication without notice' || needsOwner;
      let awaitingPublication = !alreadyPublished && !discovering;
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const workspaceId = 'roost-cloud-workspace' as WorkspaceId;
      const sessionId = 'roost-cloud-session' as SessionId;
      const machineId = 'roost-cloud-machine' as MachineId;
      const author = Identity.fromSeed(new Uint8Array(32).fill(23));
      const storage = await IndexedDbStorage.open('roost-cloud-source');
      let entropy = 0;
      const store = new Store(storage, () => true, {
        clock: () => 1_700_000_000_000n,
        randomBytes: () => new Uint8Array(16).fill(++entropy),
      });
      const stream = store.stream(roostHistorySourceId(sessionId, 'root'));
      const writer = new LodyHistory(stream, author);
      const turn = {
        id: 'cloud-message',
        role: 'user',
        timestamp: '2026-11-01T00:00:00Z',
        items: [{ type: 'text', text: 'Synthetic Roost history' }],
      };
      const reply = {
        id: 'cloud-reply',
        role: 'assistant',
        userTurnId: turn.id,
        timestamp: '2026-11-01T00:00:01Z',
        items: [{ type: 'text', text: 'A later Roost update' }],
      };
      const append = async (
        entry: typeof turn,
        preceding?: Awaited<ReturnType<typeof writer.acceptToView>>,
        segmentId = 'primary'
      ) => {
        const parent = preceding ? await stream.readTurnHeader(preceding.turnId) : undefined;
        const parents =
          parent?.kind === 'found' && parent.turn.sealed
            ? [{ id: parent.turn.turnId, hash: parent.turn.sealed }]
            : [];
        const accepted = await writer.acceptToView({
          viewId: sessionId,
          expectedRevision: preceding?.revision ?? 0n,
          expectedHead: preceding?.newHead ?? null,
          operationId: `${entry.id}:${segmentId}`,
          input: {
            kind: 'message',
            businessId: entry.id,
            segmentId,
            parents,
            content: fromApplicationJson(entry),
          },
        });
        await writer.finish(accepted.turnId, 1n);
        return accepted;
      };
      const exportHistory = async () =>
        stream.exportTurns(
          (await stream.readStream()).flatMap((record) =>
            record.kind === 'found' ? [record.turn.turnId] : []
          )
        );
      let accepted = await append(turn);
      const precedingIds = [turn.id];
      if (updateDuringMetadata) {
        for (let index = 1; index < 42; index++) {
          const id = `synthetic-turn-${index}`;
          accepted = await append({ ...turn, id }, accepted);
          precedingIds.push(id);
        }
      }
      const bytes = await exportHistory();
      if (editDuringMetadata) {
        const edited = { ...turn, inputConfig: { modelId: 'revised-model' } };
        await append(edited, accepted, 'late:edit-metadata');
      } else await append(reply, accepted);
      const incremental = await exportHistory();

      const binding = {
        generation: 'root' as const,
        ownerPublicKey: roostHistoryAuthorKey(author.owner()),
      };
      const physical = roostCloudHistoryStreamId(workspaceId, machineId, sessionId, binding);
      const urlFor = (streamId: string) =>
        `https://streams.invalid/ds/${ROOST_HISTORY_BUCKET_ID}/${encodeURIComponent(streamId)}`;
      const url = urlFor(physical);
      const nextBinding = { ...binding, generation: '0197a600-0000-7000-8000-000000000001' };
      const nextUrl = urlFor(
        roostCloudHistoryStreamId(workspaceId, machineId, sessionId, nextBinding)
      );
      const replacementTurn = { ...turn, id: 'replacement-message' };
      let replacement = new Uint8Array();
      if (rotating) {
        const nextStream = store.stream(roostHistorySourceId(sessionId, nextBinding.generation));
        const nextWriter = new LodyHistory(nextStream, author);
        const accepted = await nextWriter.acceptToView({
          viewId: sessionId,
          expectedRevision: 0n,
          expectedHead: null,
          operationId: replacementTurn.id,
          input: {
            kind: 'message',
            businessId: replacementTurn.id,
            segmentId: 'primary',
            parents: [],
            content: fromApplicationJson(replacementTurn),
          },
        });
        await nextWriter.finish(accepted.turnId, 1n);
        replacement = new Uint8Array(await nextStream.exportTurns([accepted.turnId]));
      }
      await store.close();
      await storage.close();
      let oldStreamUnavailable = false;
      let publishedReplacement = false;
      const startOffset = String(bytes.length);
      const tail = String(bytes.length + incremental.length);
      const applied = Promise.withResolvers<void>();
      const switched = Promise.withResolvers<void>();
      const recovered = Promise.withResolvers<void>();
      const returnedToOwner = Promise.withResolvers<void>();
      const readingLive = Promise.withResolvers<void>();
      const breakLive = Promise.withResolvers<void>();
      const machineReading = Promise.withResolvers<void>();
      let liveReadFailed = false;
      let usedOwnerDuringOutage = false;
      let requestsToTail = 0;
      let headOffset = startOffset;
      let failHead = false;
      vi.stubGlobal('fetch', (input: string | Request, init?: RequestInit) => {
        const read = new URL(input instanceof Request ? input.url : input);
        const { pathname, origin } = new URL(url);
        if (read.href.startsWith(nextUrl) && publishedReplacement) {
          const offset = String(replacement.byteLength);
          const isHead = init?.method === 'HEAD';
          const backwards = read.searchParams.get('direction') === 'backward';
          return Promise.resolve(
            new Response(backwards ? replacement : null, {
              status: isHead || backwards ? 200 : 204,
              headers: {
                'content-type': 'application/octet-stream',
                'stream-next-offset': offset,
                'stream-up-to-date': 'true',
                ...(backwards && {
                  'stream-prev-offset': '0',
                  'stream-end-offset': offset,
                  'stream-tail-offset': offset,
                  'stream-at-start': 'true',
                  'stream-message-spans': JSON.stringify([
                    {
                      rel_start: 0,
                      rel_end: replacement.byteLength,
                      message_start: '0',
                      message_end: offset,
                      message_len: offset,
                      msg_offset: '0',
                    },
                  ]),
                }),
              },
            })
          );
        }
        if (read.origin !== origin || read.pathname !== pathname)
          throw new Error('Unexpected cloud history transport');
        if (publishedReplacement)
          return Promise.resolve(
            new Response(null, {
              status: startingState.endsWith('old token expired') ? 401 : 404,
            })
          );
        if (oldStreamUnavailable) return Promise.resolve(new Response(null, { status: 503 }));
        if ((init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'HEAD') {
          if (failHead) {
            failHead = false;
            return Promise.resolve(new Response(null, { status: 503 }));
          }
          return Promise.resolve(
            new Response(null, {
              headers: {
                'content-type': 'application/octet-stream',
                'stream-next-offset': headOffset,
              },
            })
          );
        }
        if (read.searchParams.get('direction') === 'backward') {
          if (startingState === 'Streams reverse read 503' && cloudUnavailable)
            return Promise.resolve(new Response(null, { status: 503 }));
          return Promise.resolve(
            new Response(new Uint8Array(bytes), {
              headers: {
                'content-type': 'application/octet-stream',
                'stream-prev-offset': '0',
                'stream-end-offset': startOffset,
                'stream-tail-offset': startOffset,
                'stream-at-start': 'true',
                'stream-message-spans': JSON.stringify([
                  {
                    rel_start: 0,
                    rel_end: bytes.length,
                    message_start: '0',
                    message_end: startOffset,
                    message_len: startOffset,
                    msg_offset: '0',
                  },
                ]),
              },
            })
          );
        }
        const next = (body: Uint8Array<ArrayBuffer> | null, offset: string) =>
          new Response(body, {
            status: body ? 200 : 204,
            headers: {
              'content-type': 'application/octet-stream',
              'stream-next-offset': offset,
              'stream-up-to-date': 'true',
            },
          });
        const offset = read.searchParams.get('offset');
        if (liveOutage && !liveReadFailed && read.searchParams.has('live')) {
          liveReadFailed = true;
          readingLive.resolve();
          return breakLive.promise.then(() => new Response(null, { status: 503 }));
        }
        if (offset === startOffset && !read.searchParams.has('live'))
          return Promise.resolve(
            headOffset === tail ? next(new Uint8Array(incremental), tail) : next(null, startOffset)
          );
        if (offset === startOffset && !updateDuringMetadata && !discovering) {
          requestsToTail++;
          headOffset = tail;
          return Promise.resolve(next(new Uint8Array(incremental), tail));
        }
        if (offset === tail || ((updateDuringMetadata || discovering) && offset === startOffset)) {
          if (!read.searchParams.has('live')) return Promise.resolve(next(null, tail));
          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        throw new Error(`Unexpected resumed position ${offset}`);
      });
      const offline = async (): Promise<never> => {
        throw new Error('Synthetic owner is offline');
      };
      let replicaFull = quotaExhausted;
      const quota = quotaExhausted ? limitReplicaStorage(() => replicaFull) : undefined;
      let cachedBinding: typeof binding | undefined =
        alreadyPublished && startingState !== 'published without a hint' ? binding : undefined;
      const publicationWakes = new Set<() => void>();
      let replica: ReturnType<typeof createRoostHistoryReplica>;
      let sync: RoostHistorySyncState | undefined;
      const reportedPending = Promise.withResolvers<void>();
      const open = (
        requestGrant: Parameters<typeof createRoostHistoryReplica>[0]['requestGrant'],
        owner: Parameters<
          typeof createRemoteRoostSessionDataFactory
        >[0]['requestHistoryRead'] = offline
      ) =>
        createRemoteRoostSessionDataFactory({
          workspaceId,
          machineId,
          onCloudHistoryRoute: (active) => {
            if (active) {
              if (usedOwnerDuringOutage) recovered.resolve();
            } else if (cloudOutage) {
              if (usedOwnerDuringOutage) returnedToOwner.resolve();
              usedOwnerDuringOutage = true;
            }
          },
          onHistorySync: (next) => {
            sync = next;
            if (next.phase === 'pending' || next.phase === 'owner-required')
              reportedPending.resolve();
            if (next.source === 'streams' && next.phase === 'ready') switched.resolve();
            if (next.source === 'machine' && next.httpStatus === 503) machineReading.resolve();
          },
          cloudHistory: () =>
            (replica = createRoostHistoryReplica({
              workspaceId,
              machineId,
              sessionId,
              replicaNamespace: startingState,
              getBinding: () => cachedBinding,
              observeBinding: (wake) => {
                publicationWakes.add(wake);
                return () => publicationWakes.delete(wake);
              },
              requestGrant,
              onSyncState: (state) => {
                if ('checkpoint' in state && JSON.parse(state.checkpoint)[2] === tail)
                  applied.resolve();
              },
            })),
          requestHistoryRead: owner,
          requestHistoryWrite: offline,
        })({ sessionId, doc: new LoroDoc(), backendKind: 'roost' });
      const timedOut: Parameters<
        typeof createRemoteRoostSessionDataFactory
      >[0]['requestHistoryRead'] = async () => ({
        type: 'session/history-read_response',
        sessionId,
        success: false,
        error: 'Synthetic owner is offline',
        rpcFailure: {
          source: 'transport',
          code: 'response_timeout',
          requestId: 'synthetic-owner-read',
          machineId,
        },
      });
      const ownerTurn = quotaExhausted ? { ...turn, id: 'machine-message' } : turn;
      const ownerRead: Parameters<
        typeof createRemoteRoostSessionDataFactory
      >[0]['requestHistoryRead'] = async (_machine, _session, query) => ({
        type: 'session/history-read_response',
        sessionId,
        success: true,
        historyCount: paginating ? 2 : 1,
        historyRevision: 1,
        result:
          query.kind === 'count'
            ? paginating
              ? 2
              : 1
            : query.kind === 'readLatestPage'
              ? {
                  startPosition: paginating ? 1 : 0,
                  totalCount: paginating ? 2 : 1,
                  hasMoreOlder: paginating,
                  cursor: paginating ? 'machine-older' : null,
                  rows: [createRoostDirectoryRow(paginating ? 1 : 0, ownerTurn)],
                }
              : { state: 'ready', turn: ownerTurn },
        pageTurns: [ownerTurn],
      });
      const ownerStarted = Promise.withResolvers<void>();
      const ownerReply = Promise.withResolvers<Awaited<ReturnType<typeof ownerRead>>>();
      const delayedRequest = slowOwner
        ? 'count'
        : machinePagePending || rotating
          ? 'readLatestPage'
          : paginating
            ? 'readOlderPage'
            : undefined;
      const requestOwner: typeof ownerRead = (machine, session, query) => {
        if (query.kind !== delayedRequest || (rotating && !oldStreamUnavailable))
          return ownerRead(machine, session, query);
        ownerStarted.resolve();
        return ownerReply.promise;
      };
      let readGrants = 0;
      let accessWithdrawn = false;
      const requestGrant = async () => {
        readGrants++;
        if (
          cloudUnavailable &&
          startingState !== 'Streams reverse read 503' &&
          (!withoutObserver || readGrants === 1)
        )
          throw new RoostCloudHistoryRequestError(503);
        if (
          accessWithdrawn ||
          startingState === 'published grant 503 then refusal' ||
          streamsRefusesFirst ||
          refuseDuringPage
        )
          throw new RoostCloudHistoryRequestError(403);
        if (awaitingPublication)
          return { state: needsOwner ? 'owner-required' : 'pending' } as const;
        return {
          state: 'published' as const,
          newerVersionPending: startingState === 'publication notice',
          binding: publishedReplacement ? nextBinding : binding,
          streamUrl: publishedReplacement ? nextUrl : url,
          token: 'synthetic-read-grant',
          expiresIn: 60,
        };
      };
      const first = open(
        requestGrant,
        discovering ? timedOut : alreadyPublished && !cloudOutage ? offline : requestOwner
      );
      if (discovering || pendingWithoutNotice || cloudOutage || checkingCachedGrant)
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let closed = false;
      try {
        if (slowOwner) {
          const observation = withoutObserver ? undefined : first.history.observe(() => {});
          void observation?.initial.catch(() => {});
          const page = observation?.initialPage ?? first.history.readLatestDirectoryPage!(40);
          void page.catch(() => {});
          await ownerStarted.promise;
          if (closing) {
            first.dispose();
            closed = true;
            await expect(page).rejects.toMatchObject({ name: 'AbortError' });
          } else if (bothUnavailable) {
            ownerReply.resolve(await timedOut(machineId, sessionId, { kind: 'count' }));
            await expect(page).rejects.toMatchObject({
              failure: { source: 'transport', code: 'response_timeout' },
            });
            cloudUnavailable = false;
            await expect(first.history.readLatestDirectoryPage!(40)).resolves.toMatchObject({
              rows: [{ turnId: turn.id }],
            });
          } else {
            cloudUnavailable = false;
            await vi.advanceTimersByTimeAsync(0);
            if (streamsRefusesFirst) {
              await expect(page).rejects.toMatchObject({ status: 403 });
              expect(sync).toMatchObject({ source: 'streams', phase: 'refused', httpStatus: 403 });
            } else {
              await expect(page).resolves.toMatchObject({ rows: [{ turnId: turn.id }] });
              expect(sync).toMatchObject({ source: 'streams', phase: 'ready' });
            }
          }
          ownerReply.resolve(await ownerRead(machineId, sessionId, { kind: 'count' }));
          await vi.advanceTimersByTimeAsync(0);
          expect(usedOwnerDuringOutage).toBe(false);
          observation?.unsubscribe();
          return;
        }
        const observation = first.history.observe(() => {});
        void observation.initial.catch(() => {});
        if (checkingCachedGrant) {
          await observation.initialPage;
          observation.unsubscribe();
          await expect(first.history.readTurn(turn.id)).resolves.toMatchObject({
            state: 'ready',
            turn,
          });
          accessWithdrawn = true;
          vi.setSystemTime(Date.now() + 56_000);
          await expect(first.history.readTurn(turn.id)).rejects.toMatchObject({ status: 403 });
          expect(sync).toMatchObject({ source: 'streams', phase: 'refused', httpStatus: 403 });
          return;
        }
        if (rotating) {
          await expect(observation.initialPage).resolves.toMatchObject({
            rows: [{ turnId: turn.id }],
          });
          await vi.advanceTimersByTimeAsync(0);
          await readingLive.promise;
          oldStreamUnavailable = true;
          breakLive.resolve();
          await ownerStarted.promise;
          await machineReading.promise;
          await vi.advanceTimersByTimeAsync(0);
          const page = first.history.readLatestDirectoryPage!(40);
          void page.catch(() => {});
          publishedReplacement = true;
          await vi.advanceTimersByTimeAsync(1_000);
          await expect(page).resolves.toMatchObject({ rows: [{ turnId: replacementTurn.id }] });
          expect(sync).toMatchObject({ source: 'streams', phase: 'ready' });
          ownerReply.resolve(
            await ownerRead(machineId, sessionId, { kind: 'readLatestPage', limit: 40 })
          );
          await vi.advanceTimersByTimeAsync(0);
          await expect(first.history.readTurn(replacementTurn.id)).resolves.toMatchObject({
            state: 'ready',
            turn: replacementTurn,
          });
          observation.unsubscribe();
          return;
        }
        if (machinePagePending || paginating) {
          const initialPage = observation.initialPage!;
          const oldCursor = paginating ? (await initialPage).cursor! : undefined;
          const request = oldCursor
            ? first.history.readOlderDirectoryPage!(oldCursor, 40)
            : initialPage;
          void request.catch(() => {});
          await ownerStarted.promise;
          expect(sync).toMatchObject({ source: 'machine', phase: 'retrying', httpStatus: 503 });
          if (closeDuringPage) {
            first.dispose();
            closed = true;
            await expect(request).rejects.toMatchObject({ name: 'AbortError' });
          } else {
            cloudUnavailable = false;
            await vi.advanceTimersByTimeAsync(1_000);
            await recovered.promise;
            if (refuseDuringPage) {
              await expect(request).rejects.toMatchObject({ status: 403 });
            } else if (oldCursor) {
              await expect(request).rejects.toThrow('Roost history source changed');
              failHead = true;
              await expect(replica.prepareLatestWindow()).rejects.toMatchObject({ status: 503 });
              await returnedToOwner.promise;
              const latest = await first.history.readLatestDirectoryPage!(40);
              expect(latest.cursor).toBeTruthy();
              expect(latest.cursor).not.toBe(oldCursor);
              await expect(first.history.readOlderDirectoryPage!(oldCursor, 40)).rejects.toThrow(
                'Roost history source changed'
              );
            } else {
              await expect(request).resolves.toMatchObject({ rows: [{ turnId: turn.id }] });
              const retiredTurn = { ...turn, id: 'retired-machine-turn' };
              ownerReply.resolve({
                ...(await ownerRead(machineId, sessionId, { kind: 'readLatestPage', limit: 40 })),
                result: {
                  startPosition: 0,
                  totalCount: 1,
                  hasMoreOlder: false,
                  cursor: null,
                  rows: [createRoostDirectoryRow(0, retiredTurn)],
                },
                pageTurns: [retiredTurn],
              });
              await vi.advanceTimersByTimeAsync(0);
              expect(sync).toMatchObject({ source: 'streams', phase: 'ready' });
              await expect(first.history.readLatestDirectoryPage!(40)).resolves.toMatchObject({
                rows: [{ turnId: turn.id }],
              });
            }
          }
          observation.unsubscribe();
          return;
        }
        if (cloudOutage) {
          await expect(observation.initialPage).resolves.toMatchObject({
            rows: [{ turnId: ownerTurn.id }],
          });
          if (liveOutage) {
            await vi.advanceTimersByTimeAsync(0);
            await readingLive.promise;
            expect(sync).toMatchObject({ source: 'streams', phase: 'ready' });
            breakLive.resolve();
            await machineReading.promise;
            await expect(first.history.readLatestDirectoryPage!(40)).resolves.toMatchObject({
              rows: [{ turnId: turn.id }],
            });
          }
          expect(sync?.source).toBe('machine');
          if (!quotaExhausted) expect(sync).toMatchObject({ phase: 'retrying', httpStatus: 503 });
          replicaFull = false;
          cloudUnavailable = false;
          await vi.advanceTimersByTimeAsync(1_000);
          await recovered.promise;
          if (startingState === 'published grant 503 then refusal') {
            await expect(first.history.readLatestDirectoryPage!(40)).rejects.toMatchObject({
              status: 403,
            });
            expect(sync).toMatchObject({ source: 'streams', phase: 'refused', httpStatus: 403 });
          } else {
            await expect(first.history.readLatestDirectoryPage!(40)).resolves.toMatchObject({
              rows: [{ turnId: turn.id }],
            });
            expect(sync).toMatchObject({ source: 'streams', phase: 'ready' });
          }
          observation.unsubscribe();
          return;
        }
        if (discovering) {
          await expect(observation.initialPage).rejects.toMatchObject({
            failure: { source: 'transport', code: 'response_timeout' },
          });
          expect(sync).toMatchObject({ source: 'streams', phase: 'retrying' });
          cloudUnavailable = false;
          await vi.advanceTimersByTimeAsync(1_000);
          await switched.promise;
          await expect(first.history.readLatestDirectoryPage!(40)).resolves.toMatchObject({
            rows: [{ turnId: turn.id }],
          });
          return;
        }
        const page = await observation.initialPage;
        if (updateDuringMetadata) {
          expect(page.startPosition).toBe(2);
          const readPage = LodyHistory.prototype.readActiveBranchPage;
          let intake: Promise<void> | undefined;
          let olderPageTotal: number | undefined;
          const spy = vi
            .spyOn(LodyHistory.prototype, 'readActiveBranchPage')
            .mockImplementation(async function (this: LodyHistory, ...args) {
              const page = await readPage.apply(this, args);
              if (args[1]?.latest && headOffset === startOffset) {
                headOffset = tail;
                intake = replica.prepareLatestWindow();
                void intake.catch(() => {});
              }
              if (args[1]?.before && intake) olderPageTotal ??= page.totalCount;
              return page;
            });
          try {
            const result = first.history.readMetadata!();
            if (editDuringMetadata) {
              await expect(result).rejects.toThrow('Roost history observation was superseded');
            } else {
              expect((await result).map((row) => row.id)).toEqual(precedingIds);
              expect(olderPageTotal).toBe(precedingIds.length + 1);
            }
            expect(intake).toBeDefined();
            await intake;
            const refreshed = await first.history.readMetadata!();
            if (editDuringMetadata) {
              expect(refreshed.map((row) => row.id)).toEqual(precedingIds);
              expect(refreshed[0]?.inputConfig?.modelId).toBe('revised-model');
            } else {
              expect(refreshed.map((row) => row.id)).toEqual([...precedingIds, reply.id]);
            }
          } finally {
            spy.mockRestore();
            observation.unsubscribe();
          }
          return;
        }
        expect(page.rows).toMatchObject([{ turnId: turn.id }]);
        expect(await first.history.readTurn(turn.id)).toMatchObject({ state: 'ready', turn });
        if (!alreadyPublished) {
          await reportedPending.promise;
          expect(sync).toMatchObject({
            source: 'machine',
            phase: needsOwner ? 'owner-required' : 'pending',
          });
          awaitingPublication = false;
          if (pendingWithoutNotice) {
            await vi.advanceTimersByTimeAsync(1_000);
            await switched.promise;
            await expect(first.history.readTurn(turn.id)).resolves.toMatchObject({
              state: 'ready',
              turn,
            });
            expect(sync).toMatchObject({ source: 'streams', phase: 'ready' });
            observation.unsubscribe();
            return;
          }
          cachedBinding = binding;
          for (const wake of publicationWakes) wake();
        }
        await applied.promise;
        expect(sync).toMatchObject({
          source: 'streams',
          phase: 'ready',
          newerVersionPending: startingState === 'publication notice',
        });
        expect(requestsToTail).toBe(1);
        expect(await first.history.readTurn(reply.id)).toMatchObject({
          state: 'ready',
          turn: reply,
        });
        const latest = await first.history.readLatestDirectoryPage!(1);
        expect(latest.rows).toMatchObject([{ turnId: reply.id }]);
        expect(latest.cursor).toBeTruthy();
        const older = await first.history.readOlderDirectoryPage!(latest.cursor!, 1);
        expect(older.checkpoint).toBe(latest.checkpoint);
        expect(older.rows).toMatchObject([{ turnId: turn.id }]);
        expect((await first.snapshots.capture()).history).toMatchObject([
          { id: turn.id },
          { id: reply.id },
        ]);
        observation.unsubscribe();
      } finally {
        if (!closed) first.dispose();
        quota?.mockRestore();
        if (delayedRequest)
          ownerReply.resolve(await timedOut(machineId, sessionId, { kind: 'count' }));
        if (discovering || pendingWithoutNotice || cloudOutage || checkingCachedGrant)
          vi.useRealTimers();
        if (discovering || pendingWithoutNotice || updateDuringMetadata || cloudOutage)
          vi.unstubAllGlobals();
      }
      cachedBinding = binding;
      const reopened = open(requestGrant);
      try {
        const page = await reopened.history.readLatestDirectoryPage?.(40);
        expect(page?.rows).toMatchObject([{ turnId: turn.id }, { turnId: reply.id }]);
        expect(await reopened.history.readTurn(turn.id)).toMatchObject({ state: 'ready', turn });
      } finally {
        reopened.dispose();
        vi.unstubAllGlobals();
      }
    }
  );

  it.each(
    (['local', 'remote'] as const).flatMap((transport) =>
      (['current', 'legacy', 'empty'] as const).map((format) => ({ transport, format }))
    )
  )(
    'reads offline schedule metadata from a complete $format cache over $transport',
    async ({ transport, format }) => {
      Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
      const workspaceId = 'offline-metadata-workspace' as WorkspaceId;
      const machineId = 'offline-metadata-machine' as MachineId;
      const sessionId = 'offline-metadata-session' as SessionId;
      const turns: SessionHistoryInput[] =
        format === 'empty'
          ? []
          : [
              {
                id: 'scheduled-user',
                role: 'user',
                timestamp: '2026-10-31T00:00:00Z',
                userId: 'synthetic-author',
                inputConfig: { modeId: 'ask', modelId: 'synthetic-model' },
                scheduleRun: { scheduleId: 'synthetic-schedule' },
                items: [{ type: 'text', text: 'Synthetic scheduled prompt' }],
              },
              {
                id: 'scheduled-assistant',
                role: 'assistant',
                timestamp: '2026-10-31T00:00:01Z',
                userTurnId: 'scheduled-user',
                endedAt: 1234,
                finished: true,
                items: [{ type: 'text', text: 'Synthetic scheduled result' }],
              },
            ];
      const cache = createRoostHistoryCache(
        JSON.stringify(['local', workspaceId, machineId, sessionId])
      );
      const doc = new LoroDoc();
      const options = { workspaceId, machineId, coherentInspection: true, incremental: true };
      const offline = async (): Promise<never> => {
        throw new Error('Synthetic owner offline');
      };
      const factory =
        transport === 'local'
          ? createLocalRoostSessionDataFactory({ ...options, sendControl: offline })
          : createRemoteRoostSessionDataFactory({
              ...options,
              requestHistoryRead: offline,
              requestHistoryWrite: offline,
            });
      const data = factory({ sessionId, doc, backendKind: 'roost' });
      const getAll = IDBObjectStore.prototype.getAll;
      let bulkRead: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await cache.acceptPage(
          {
            rows: turns.map((turn, position) => {
              const row = createRoostDirectoryRow(position, turn);
              if (format !== 'legacy') return row;
              const {
                metadataVersion: _version,
                userId: _user,
                inputConfig: _config,
                scheduleRun: _run,
                ...legacy
              } = row;
              return legacy;
            }),
            startPosition: 0,
            totalCount: turns.length,
            hasMoreOlder: false,
            cursor: null,
            checkpoint: 'offline-metadata-checkpoint',
          },
          turns,
          7
        );
        bulkRead = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
          ...args
        ) {
          if (this.name === 'rows') throw new Error('Metadata must not load all cached bodies');
          return getAll.apply(this, args);
        });
        const expected =
          format === 'empty'
            ? []
            : [
                {
                  id: 'scheduled-user',
                  role: 'user',
                  timestamp: turns[0]!.timestamp,
                  userId: 'synthetic-author',
                  inputConfig: { modeId: 'ask', modelId: 'synthetic-model' },
                  scheduleRun: { scheduleId: 'synthetic-schedule' },
                },
                {
                  id: 'scheduled-assistant',
                  role: 'assistant',
                  timestamp: turns[1]!.timestamp,
                  userTurnId: 'scheduled-user',
                  endedAt: 1234,
                  finished: true,
                  inputConfig: undefined,
                },
              ];
        expect(await readSessionHistoryMetadata(data.history)).toEqual(expected);
      } finally {
        bulkRead?.mockRestore();
        data.dispose();
        cache.dispose();
        doc.free();
      }
    }
  );

  it.each(['partial', 'stale', 'other-account', 'read-failed'] as const)(
    'reads owner metadata instead of using a %s cache',
    async (condition) => {
      Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
      const workspaceId = 'metadata-admission-workspace' as WorkspaceId;
      const machineId = 'metadata-admission-machine' as MachineId;
      const sessionId = 'metadata-admission-session' as SessionId;
      const turns: SessionHistoryInput[] = [0, 1].map((index) => ({
        id: `scheduled-${index}`,
        role: 'user',
        timestamp: '2026-10-31T00:00:00Z',
        inputConfig: { modeId: 'ask', modelId: 'cached-model' },
        items: [{ type: 'text', text: 'Synthetic prompt' }],
      }));
      const cache = createRoostHistoryCache(
        JSON.stringify(['local', workspaceId, machineId, sessionId])
      );
      const doc = new LoroDoc();
      const data = createLocalRoostSessionDataFactory({
        workspaceId,
        machineId,
        coherentInspection: true,
        incremental: true,
        ...(condition === 'other-account' ? { accountId: 'different-account' } : {}),
        sendControl: async (request) => {
          if (request.type !== 'session/history-read') throw new Error('Unexpected write');
          const query = request.query;
          if (query.kind !== 'readAt' && query.kind !== 'readMetadata')
            throw new Error('Metadata lookup requested transcript bodies');
          return {
            ok: true,
            responses: [
              {
                type: 'session/history-read_response',
                sessionId,
                success: true,
                historyRevision: 8,
                historyCount: turns.length,
                result:
                  query.kind === 'readAt'
                    ? { state: 'missing' }
                    : [
                        {
                          id: turns[0]!.id,
                          role: 'user',
                          timestamp: turns[0]!.timestamp,
                          inputConfig: { modelId: 'owner-model' },
                        },
                      ],
              },
            ],
          };
        },
      })({ sessionId, doc, backendKind: 'roost' });
      let cursorRead: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const start = condition === 'partial' ? 1 : 0;
        await cache.acceptPage(
          {
            rows: turns
              .slice(start)
              .map((turn, offset) => createRoostDirectoryRow(start + offset, turn)),
            startPosition: start,
            totalCount: turns.length,
            hasMoreOlder: start > 0,
            cursor: null,
          },
          turns.slice(start),
          7
        );
        if (condition === 'stale') await data.history.readAt(2);
        if (condition === 'read-failed')
          cursorRead = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(() => {
            throw new Error('Synthetic cache read failure');
          });
        expect(await readSessionHistoryMetadata(data.history)).toEqual([
          {
            id: turns[0]!.id,
            role: 'user',
            timestamp: turns[0]!.timestamp,
            inputConfig: { modelId: 'owner-model' },
          },
        ]);
      } finally {
        cursorRead?.mockRestore();
        data.dispose();
        cache.dispose();
        doc.free();
      }
    }
  );

  it('receives an existing owner acceptance through the real SDK after a silent SSE stall', async () => {
    vi.useFakeTimers();
    const connected = Promise.withResolvers<void>();
    const appended = Promise.withResolvers<void>();
    const sessionId = 'synthetic-response-recovery' as SessionId;
    const entry: SessionHistoryInput = {
      id: 'synthetic-input',
      role: 'user',
      userId: 'synthetic-user',
      timestamp: '2026-10-18T00:00:00Z',
      status: 'pending',
      items: [{ type: 'text', text: 'Synthetic input' }],
    };
    let response: unknown;
    const requests: unknown[] = [];
    const reads: Array<{ mode: string | null; offset: string | null }> = [];
    const json = createLoroStreamsJsonStreamClient({
      bucketId: 'synthetic-bucket',
      getToken: async () => 'synthetic-token',
      baseUrl: 'https://streams.example.com',
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        if (init?.method === 'PUT')
          return new Response(null, {
            status: 201,
            headers: { 'Content-Type': 'application/json', 'Stream-Next-Offset': '0' },
          });
        if (init?.method === 'HEAD')
          return new Response(null, {
            headers: { 'Content-Type': 'application/json', 'Stream-Next-Offset': '42' },
          });
        if (init?.method === 'POST') {
          const request = JSON.parse(await new Response(init.body).text());
          requests.push(request);
          response = {
            jsonrpc: '2.0',
            id: request.id,
            method: request.method,
            rpcVersion: '1',
            machineId: 'synthetic-machine',
            result: await encryptCodeCollabV2RpcPayload(sessionId, {
              type: 'session/history-write_response',
              sessionId,
              operation: 'accept_input_and_dispatch',
              success: true,
              result: { status: 'accepted', turnId: entry.id, active: true },
              historyRevision: 1,
              historyCount: 1,
              historyChange: null,
            }),
          };
          return new Response(null, { status: 204, headers: { 'Stream-Next-Offset': '1' } });
        }
        reads.push({ mode: url.searchParams.get('live'), offset: url.searchParams.get('offset') });
        if (reads.length === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: control\ndata: {"streamNextOffset":"42","upToDate":true}\n\n'
                  )
                );
                init?.signal?.addEventListener(
                  'abort',
                  () => {
                    controller.error(new DOMException('Aborted', 'AbortError'));
                  },
                  { once: true }
                );
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } }
          );
        }
        if (reads.length === 2)
          return new Response(JSON.stringify([response]), {
            headers: {
              'Content-Type': 'application/json',
              'Stream-Next-Offset': '43',
              'Stream-Up-To-Date': 'true',
            },
          });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      },
    });
    const streamClient = {
      ...json,
      readJsonLive: (...args: Parameters<typeof json.readJsonLive>) =>
        json.readJsonLive(
          args[0],
          args[1],
          async (batch) => {
            await args[2](batch);
            if (batch.upToDate) connected.resolve();
          },
          args[3]
        ),
    };
    const dispatcher = new LoroStreamsRpcResponseDispatcher({
      workspaceId: 'synthetic-workspace',
      streamClient,
      liveModePolicy: new LoroStreamsLiveModePolicy(),
    });
    const rpc = new LoroStreamsMachineRpcClient({
      workspaceId: 'synthetic-workspace',
      machineId: 'synthetic-machine',
      streamClient,
      responseDispatcher: dispatcher,
      trace: (event) => {
        if (event === 'machine rpc transport append finished') appended.resolve();
      },
    });
    const doc = new LoroDoc();
    const session = createRemoteRoostSessionDataFactory({
      workspaceId: 'synthetic-workspace' as WorkspaceId,
      machineId: 'synthetic-machine' as MachineId,
      requestHistoryRead: async () => {
        throw new Error('Acceptance must not read history back');
      },
      requestHistoryWrite: async (request) => {
        const result = await rpc.requestSessionHistoryWrite(request);
        if (!result) throw new Error('Missing acceptance response');
        return result;
      },
    })({ sessionId, doc, backendKind: 'roost' });
    try {
      let accepted = false;
      const write = session.inputAcceptance!.acceptAndDispatch!(entry).then((receipt) => {
        accepted = true;
        return receipt;
      });
      void write.catch(() => undefined);
      await Promise.all([connected.promise, appended.promise]);
      expect(accepted).toBe(false);
      await vi.advanceTimersByTimeAsync(HISTORY_INPUT_RESPONSE_RECOVERY_MS);
      await expect(write).resolves.toEqual({ status: 'accepted', turnId: entry.id, active: true });
      expect(reads.slice(0, 2)).toEqual([
        { mode: 'sse', offset: '-1' },
        { mode: 'long-poll', offset: '42' },
      ]);
      expect(requests).toHaveLength(1);
      expect(doc.getList('history').length).toBe(0);
    } finally {
      dispatcher.stop();
      session.dispose?.();
      doc.free();
      vi.useRealTimers();
    }
  });

  it.each([
    ['accept', 'accept_input'],
    ['acceptAndDispatch', 'accept_input_and_dispatch'],
  ] as const)(
    'keeps a restored owner while following local identity changes for %s and history',
    async (method, operation) => {
      const machineId = 'synthetic-restored-owner' as MachineId;
      const sessionId = 'synthetic-restored-session' as SessionId;
      const entry = {
        id: 'synthetic-restored-input',
        role: 'user' as const,
        userId: 'synthetic-user',
        timestamp: '2026-10-13T00:00:00Z',
        items: [{ type: 'text' as const, text: 'Saved input' }],
        status: 'pending' as const,
      };
      let plane: 'local' | 'cloud' = 'cloud';
      let admitted = false;
      const receipt = () =>
        admitted
          ? { status: 'accepted', turnId: entry.id, active: plane === 'local' }
          : { status: 'unobserved' };
      const factory = createRoostSessionDataFactoryForMachine({
        accountId: 'synthetic-account',
        workspaceId: 'synthetic-workspace' as WorkspaceId,
        machineId,
        resolvePlane: async (owner) => {
          expect(owner).toBe(machineId);
          return plane;
        },
        cloudHistory: () =>
          createRoostHistoryReplica({
            workspaceId: 'synthetic-workspace' as WorkspaceId,
            machineId,
            sessionId,
            replicaNamespace: 'local-routing-test',
            getBinding: () => ({ generation: 'root', ownerPublicKey: 'A'.repeat(43) }),
            observeBinding: () => () => {},
            requestGrant: async () => {
              throw new Error('Local history must not request a cloud grant');
            },
          }),
        sendControl: async (request) => {
          expect(request.machineId).toBe(machineId);
          expect(request.sessionId).toBe(sessionId);
          if (request.type === 'session/history-read') {
            return {
              ok: true,
              responses: [
                {
                  type: 'session/history-read_response',
                  sessionId,
                  success: true,
                  result:
                    request.query.kind === 'inputAcceptance' ? receipt() : admitted ? [entry] : [],
                  historyRevision: admitted ? 1 : 0,
                  historyCount: admitted ? 1 : 0,
                },
              ],
            };
          }
          if (request.type !== 'session/history-write')
            throw new Error('Unexpected input transport');
          expect(request.operation).toBe(operation);
          expect(request.payload).toEqual({ entry });
          admitted = true;
          return {
            ok: true,
            responses: [
              {
                type: 'session/history-write_response',
                sessionId,
                operation: request.operation,
                success: true,
                result: receipt(),
                historyRevision: 1,
                historyCount: 1,
                historyChange: null,
              },
            ],
          };
        },
        requestHistoryRead: async (owner, id) => {
          expect(owner).toBe(machineId);
          expect(id).toBe(sessionId);
          if (plane === 'local') throw new Error('Local history must use local control');
          return {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            result: receipt(),
            historyRevision: admitted ? 1 : 0,
            historyCount: admitted ? 1 : 0,
          };
        },
        requestHistoryWrite: async () => {
          throw new Error('An input for the now-local owner must not use cloud RPC');
        },
      });
      const doc = new LoroDoc();
      const session = factory({ doc, sessionId, backendKind: 'roost' });
      try {
        expect(await session.inputAcceptance!.lookup(entry)).toEqual({ status: 'unobserved' });
        plane = 'local';
        const accept = session.inputAcceptance?.[method];
        if (!accept) throw new Error('Expected input acceptance method');
        expect(await accept(entry)).toEqual({
          status: 'accepted',
          turnId: entry.id,
          active: true,
        });
        expect(await session.history.readAll()).toMatchObject([{ id: entry.id }]);
        expect(doc.getList('history').length).toBe(0);
        plane = 'cloud';
        expect(await session.inputAcceptance!.lookup(entry)).toEqual({
          status: 'accepted',
          turnId: entry.id,
          active: false,
        });
        expect(session.inputAcceptance!.targetMachineId).toBe(machineId);
      } finally {
        session.dispose?.();
      }
    }
  );

  it.each(['reader', 'view'] as const)(
    'makes the initial %s readable without depending on another owner round trip',
    async (consumer) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const sessionId = 'initial-owner-page' as SessionId;
      const machineId = 'synthetic-machine' as MachineId;
      const workspaceId = 'synthetic-workspace' as WorkspaceId;
      const history: SessionHistoryInput[] = Array.from({ length: 120 }, (_, index) => ({
        id: `turn-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        timestamp: '2026-10-18T00:00:00Z',
        items: [{ type: 'text', text: `Current owner body ${index}` }],
      }));
      const page = {
        startPosition: 80,
        totalCount: history.length,
        rows: history.slice(80).map((turn, index) => createRoostDirectoryRow(80 + index, turn)),
        hasMoreOlder: true,
        cursor: 'synthetic-owner-cursor',
      };
      const cache = createRoostHistoryCache(
        JSON.stringify(['local', workspaceId, machineId, sessionId])
      );
      const doc = new LoroDoc();
      let releaseDuplicate!: () => void;
      const duplicateGate = new Promise<void>((resolve) => {
        releaseDuplicate = resolve;
      });
      let duplicateStarted!: () => void;
      const duplicate = new Promise<'duplicate'>((resolve) => {
        duplicateStarted = () => resolve('duplicate');
      });
      let latestReads = 0;
      const factory = createRemoteRoostSessionDataFactory({
        workspaceId,
        machineId,
        requestHistoryRead: async (
          _machine,
          _session,
          query
        ): Promise<SessionHistoryReadResponse> => {
          if (query.kind === 'readTurn') {
            return {
              type: 'session/history-read_response',
              sessionId,
              success: true,
              historyRevision: 3,
              historyCount: history.length,
              result: { state: 'ready', turn: history[0] },
            };
          }
          if (query.kind !== 'readLatestPage') throw new Error('Unexpected history query');
          latestReads += 1;
          if (latestReads > 1) {
            duplicateStarted();
            await duplicateGate;
          }
          return {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            historyRevision: 5,
            historyCount: history.length,
            result: page,
            pageTurns: history.slice(80),
          };
        },
        requestHistoryWrite: async () => {
          throw new Error('Unexpected history write');
        },
      });
      const data = factory({ doc, sessionId, backendKind: 'roost' });
      let observation: ReturnType<typeof data.history.observe> | undefined;
      let conversation: ReturnType<typeof createConversationSession> | undefined;
      try {
        await cache.acceptPage(
          page,
          history
            .slice(80)
            .map((turn) => ({ ...turn, items: [{ type: 'text', text: 'Old cache' }] })),
          1
        );
        // An uncached foreground read has already established a newer owner.
        await data.history.readTurn(history[0]!.id);
        let readable: Promise<'readable'>;
        if (consumer === 'reader') {
          observation = data.history.observe(() => {});
          void observation.initial.catch(() => {});
          readable = observation.initialPage!.then((initialPage) => {
            expect(initialPage).toEqual(page);
            return 'readable';
          });
        } else {
          conversation = createConversationSession(doc, {
            sessionId,
            backendKind: 'roost',
            createSessionData: () => data,
            scheduleIdle: (task) => {
              let cancelled = false;
              queueMicrotask(() => {
                if (!cancelled) task({ timeRemaining: () => 50 });
              });
              return () => {
                cancelled = true;
              };
            },
            yieldToEventLoop: () => Promise.resolve(),
          });
          readable = conversation.history.ready.then(() => {
            expect(conversation!.history.turn(119)).toMatchObject(history[119]!);
            return 'readable';
          });
        }
        expect(await Promise.race([readable, duplicate])).toBe('readable');
        expect(await data.history.readTurn(history[119]!.id)).toMatchObject({
          state: 'ready',
          turn: history[119],
        });
        // The complete latest window is durable without fetching the unknown prefix.
        expect(await cache.getHead()).toMatchObject({ revision: 5, start: 80 });
      } finally {
        releaseDuplicate();
        await observation?.initialPage?.catch(() => {});
        observation?.unsubscribe();
        if (conversation) conversation.dispose();
        else data.dispose?.();
        cache.dispose();
        doc.free();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    }
  );

  it.each([false, true])(
    'keeps the committed initial snapshot coherent while an unrelated control value changes: incremental=%s',
    async (incremental) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const sessionId = 'superseded-initial-page' as SessionId;
      const doc = new LoroDoc();
      let revision = 5;
      const turn = (atRevision = revision): SessionHistoryInput => ({
        id: 'synthetic-turn',
        role: 'user',
        timestamp: '2026-10-18T00:00:00Z',
        items: [{ type: 'text', text: `Owner revision ${atRevision}` }],
      });
      const factory = createRemoteRoostSessionDataFactory({
        incremental,
        workspaceId: 'synthetic-workspace' as WorkspaceId,
        machineId: 'synthetic-machine' as MachineId,
        requestHistoryRead: async () => {
          const body = turn();
          return {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            historyRevision: revision,
            historyCount: 1,
            result: {
              ...(incremental ? { checkpoint: `checkpoint-${revision}` } : {}),
              startPosition: 0,
              totalCount: 1,
              rows: [createRoostDirectoryRow(0, body)],
              hasMoreOlder: false,
              cursor: null,
            },
            pageTurns: [body],
          };
        },
        requestHistoryWrite: async () => {
          throw new Error('Unexpected history write');
        },
      });
      const data = factory({ doc, sessionId, backendKind: 'roost' });
      const observation = data.history.observe(() => {
        if (revision !== 5) return;
        revision = 7;
        const cursor = doc.getMap('roostHistoryCursor');
        cursor.set('historyRevision', revision);
        cursor.set('historyCount', 1);
        doc.commit();
      });
      void observation.initial.catch(() => {});
      try {
        const expected = turn(5);
        const page = await observation.initialPage;
        expect(page?.rows).toEqual([createRoostDirectoryRow(0, expected)]);
        if (incremental) expect(page?.checkpoint).toBe('checkpoint-5');
        expect(await data.history.readTurn('synthetic-turn')).toMatchObject({
          state: 'ready',
          turn: expected,
        });
      } finally {
        observation.unsubscribe();
        data.dispose?.();
        doc.free();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    }
  );

  it('fails closed when Roost metadata has no renderer factory', () => {
    expect(() =>
      createConversationSession(new LoroDoc(), {
        sessionId: 'session-1' as never,
        backendKind: 'roost',
        scheduleIdle: () => () => {},
      })
    ).toThrow(/requires a renderer SessionData factory/);
  });
});

it.each([
  [120, false, false],
  [6000, false, false],
  [120, true, false],
  [6000, true, false],
  [6000, false, true],
  [6000, true, true],
] as const)(
  'patches missed changes in a %i-row durable replica without reading unchanged pages (inline=%s, tailOnly=%s)',
  async (count, inline, tailOnly) => {
    const first = tailOnly ? count - 40 : 0;
    Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
    const sessionId = 'synthetic-catchup' as SessionId;
    const workspaceId = 'synthetic-workspace' as WorkspaceId;
    const machineId = 'synthetic-machine' as MachineId;
    const entries: SessionHistoryInput[] = Array.from({ length: count }, (_, i) => ({
      id: `synthetic-${i}`,
      role: i % 2 ? 'assistant' : 'user',
      timestamp: '2026-10-16T00:00:00Z',
      items: [{ type: 'text', text: 'x'.repeat(4096) }],
    }));
    const cache = createRoostHistoryCache(
      JSON.stringify(['local', workspaceId, machineId, sessionId])
    );
    await cache.acceptPage(
      {
        checkpoint: 'synthetic-checkpoint-1',
        startPosition: first,
        totalCount: count,
        rows: entries
          .slice(first)
          .map((entry, offset) => createRoostDirectoryRow(first + offset, entry as never)),
        hasMoreOlder: first > 0,
        cursor: first > 0 ? 'synthetic-unloaded-prefix' : null,
      },
      entries.slice(first),
      1
    );
    const doc = new LoroDoc();
    let wake = () => {};
    const publish = (_revision: number) => wake();
    publish(1);
    let revision = 1;
    const reads: { kind: string; rows: number }[] = [];
    const events: { kind: string }[] = [];
    const completions = new Map<number, () => void>();
    const complete = (value: number) =>
      new Promise<void>((resolve) => completions.set(value, resolve));
    const unexpectedPageRead = Promise.withResolvers<void>();
    const factory = createLocalRoostSessionDataFactory({
      incremental: true,
      subscribeWake: (listener) => {
        wake = listener;
        return () => {
          wake = () => {};
        };
      },
      workspaceId,
      machineId,
      sendControl: async (request) => {
        if (request.type !== 'session/history-read') throw new Error('Unexpected write');
        const query = request.query;
        let result: unknown;
        let bodies = 0;
        if (query.kind === 'readChanges') {
          const ids =
            revision === 1 ? [] : revision === 3 ? [entries[count - 1]!.id] : [entries[first]!.id];
          const changed = ids.map((id) =>
            structuredClone(entries.find((entry) => entry.id === id)!)
          );
          const suffix = revision === 5 ? structuredClone(entries.slice(count)) : [];
          if (inline) bodies = changed.length + suffix.length;
          result = {
            state: 'ready',
            checkpoint: `synthetic-checkpoint-${revision}`,
            ids,
            ...(revision === 5 ? { from: count } : {}),
            ...(inline
              ? { bodies: { changed, suffix, ...(revision === 5 ? { from: count } : {}) } }
              : {}),
          };
        } else if (query.kind === 'readTurn') {
          result = {
            state: 'ready',
            turn: structuredClone(entries.find((entry) => entry.id === query.turnId)),
          };
          bodies = 1;
        } else if (query.kind === 'readRange') {
          result = entries
            .slice(query.from, query.to)
            .map((turn) => ({ state: 'ready', turn: structuredClone(turn) }));
          bodies = query.to - query.from;
        } else {
          reads.push({ kind: query.kind, rows: 40 });
          // A correct checkpoint repair never needs this body-read boundary.
          // Parking it proves that the next change can still advance the cache.
          await unexpectedPageRead.promise;
          throw new Error(`Unexpected full page read: ${query.kind}`);
        }
        reads.push({ kind: query.kind, rows: bodies });
        const response: SessionHistoryReadResponse = {
          type: 'session/history-read_response',
          sessionId,
          success: true,
          result,
          historyRevision: revision,
          historyCount: entries.length,
          historyChange: { kind: 'changed', ids: [entries.at(-1)!.id] },
        };
        return { ok: true, responses: [response] };
      },
    });
    const data = factory({ sessionId, doc, backendKind: 'roost' });
    const observation = data.history.observe((event) => {
      events.push(event);
      void cache.getHead().then((head) => {
        if (head?.start === first) completions.get(head.revision)?.();
      });
    });
    try {
      await observation.initial;
      events.length = 0;
      entries[count - 1]!.items = [{ type: 'text', text: 'updated tail' }];
      const caughtUp = complete(3);
      revision = 3;
      publish(3);
      await caughtUp;
      expect(
        new Set(reads.filter((read) => read.rows > 0).map((read) => JSON.stringify(read)))
      ).toEqual(
        new Set(
          [{ kind: inline ? 'readChanges' : 'readTurn', rows: 1 }].map((read) =>
            JSON.stringify(read)
          )
        )
      );
      expect(events.every((event) => event.kind === 'changed')).toBe(true);
      expect(await cache.getHead()).toMatchObject({
        revision: 3,
        start: first,
        count,
        checkpoint: 'synthetic-checkpoint-3',
      });
      expect(await data.history.readTurn(entries[count - 1]!.id)).toMatchObject({
        state: 'ready',
        turn: { items: [{ type: 'text', text: 'updated tail' }] },
      });
      expect(
        await data.history.readOlderDirectoryPage!(`roost-cache:1:${tailOnly ? count : 40}`, 40)
      ).toMatchObject({
        startPosition: first,
        totalCount: count,
      });
      reads.length = 0;
      entries[first]!.status = 'seen';
      entries.push({
        id: 'synthetic-new-input',
        role: 'user',
        timestamp: '2026-10-16T00:00:01Z',
        items: [{ type: 'text', text: 'new input' }],
      });
      const appended = complete(5);
      revision = 5;
      publish(5);
      await appended;
      expect(
        new Set(reads.filter((read) => read.rows > 0).map((read) => JSON.stringify(read)))
      ).toEqual(
        new Set(
          (inline
            ? [{ kind: 'readChanges', rows: 2 }]
            : [
                { kind: 'readTurn', rows: 1 },
                { kind: 'readRange', rows: 1 },
              ]
          ).map((read) => JSON.stringify(read))
        )
      );
      expect(await cache.getHead()).toMatchObject({
        revision: 5,
        start: first,
        count: count + 1,
        checkpoint: 'synthetic-checkpoint-5',
      });
      const offline = createLocalRoostSessionDataFactory({
        incremental: true,
        workspaceId,
        machineId,
        sendControl: async () => {
          throw new Error('Synthetic offline owner');
        },
      })({ sessionId, doc, backendKind: 'roost' });
      try {
        expect(await offline.history.readTurn(entries[first]!.id)).toMatchObject({
          state: 'ready',
          turn: { status: 'seen' },
        });
        expect(await offline.history.readAt(count)).toMatchObject({
          state: 'ready',
          turn: { id: 'synthetic-new-input' },
        });
        expect(await offline.history.readTurn(entries[count - 1]!.id)).toMatchObject({
          state: 'ready',
          turn: { items: [{ type: 'text', text: 'updated tail' }] },
        });
      } finally {
        offline.dispose?.();
      }
    } finally {
      observation.unsubscribe();
      data.dispose?.();
      cache.dispose();
      unexpectedPageRead.resolve();
    }
  },
  30000
);

it('retries a superseded incremental observation immediately and publishes only a coherent replacement', async () => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const sessionId = 'synthetic-supersession' as SessionId;
  const workspaceId = 'synthetic-workspace' as WorkspaceId;
  const machineId = 'synthetic-machine' as MachineId;
  const entries: SessionHistoryInput[] = ['early', 'tail'].map((id) => ({
    id,
    role: 'user',
    timestamp: '2026-10-16T00:00:00Z',
    items: [{ type: 'text', text: 'old' }],
  }));
  const cache = createRoostHistoryCache(
    JSON.stringify(['local', workspaceId, machineId, sessionId])
  );
  await cache.acceptPage(
    {
      checkpoint: 'checkpoint-1',
      startPosition: 0,
      totalCount: 2,
      rows: entries.map((entry, position) => createRoostDirectoryRow(position, entry as never)),
      hasMoreOlder: false,
      cursor: null,
    },
    entries,
    1
  );
  let revision = 3;
  const timers: { callback: () => void; delay: number }[] = [];
  const waiters: ((timer: { callback: () => void; delay: number }) => void)[] = [];
  const nextTimer = () =>
    timers.length
      ? Promise.resolve(timers.shift()!)
      : new Promise<{ callback: () => void; delay: number }>((resolve) => waiters.push(resolve));
  const setTimer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay = 0
  ) => {
    const timer = { callback, delay };
    const waiter = waiters.shift();
    if (waiter) waiter(timer);
    else timers.push(timer);
    return timer as never;
  }) as typeof setTimeout);
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  let ready!: () => void;
  const complete = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const factory = createLocalRoostSessionDataFactory({
    incremental: true,
    workspaceId,
    machineId,
    sendControl: async (request) => {
      if (request.type !== 'session/history-read') throw new Error('Unexpected write');
      const query = request.query;
      let result: unknown;
      if (query.kind === 'readChanges')
        result = {
          state: 'ready',
          checkpoint: `checkpoint-${revision}`,
          ids: entries.map((entry) => entry.id),
        };
      else if (query.kind === 'readTurn') {
        revision = 5;
        result = {
          state: 'ready',
          turn: {
            ...entries.find((entry) => entry.id === query.turnId),
            items: [{ type: 'text', text: `current ${query.turnId}` }],
          },
        };
      } else throw new Error('Full history must not be read');
      return {
        ok: true,
        responses: [
          {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            result,
            historyRevision: revision,
            historyCount: 2,
            historyChange: { kind: 'changed', ids: ['tail'] },
          },
        ],
      };
    },
  });
  const data = factory({ sessionId, doc: new LoroDoc(), backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void cache.getHead().then((head) => {
      if (head?.revision === 5) ready();
    });
  });
  try {
    await observation.initial;
    const initial = await nextTimer();
    expect(initial.delay).toBe(0);
    initial.callback();
    const retry = await nextTimer();
    expect(retry.delay).toBe(0);
    expect(await cache.getHead()).toMatchObject({ revision: 1, checkpoint: 'checkpoint-1' });
    expect((await cache.readRows(0, 2))?.map((row) => row.turn.items)).toEqual(
      entries.map((entry) => entry.items)
    );
    retry.callback();
    await complete;
    expect(await cache.getHead()).toMatchObject({ revision: 5, checkpoint: 'checkpoint-5' });
    expect((await cache.readRows(0, 2))?.map((row) => row.turn.items)).toEqual(
      ['early', 'tail'].map((id) => [{ type: 'text', text: `current ${id}` }])
    );
  } finally {
    observation.unsubscribe();
    data.dispose?.();
    cache.dispose();
    setTimer.mockRestore();
    clearTimer.mockRestore();
  }
});

it('keeps cold-open supersession out of the UI failure path', async () => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const sessionId = 'synthetic-cold-open' as SessionId;
  let superseded = true;
  const data = createLocalRoostSessionDataFactory({
    incremental: true,
    workspaceId: 'synthetic-workspace' as WorkspaceId,
    machineId: 'synthetic-machine' as MachineId,
    sendControl: async (request) => {
      if (request.type !== 'session/history-read') throw new Error('Unexpected write');
      if (superseded) {
        superseded = false;
        return {
          ok: true,
          responses: [
            {
              type: 'session/history-read_response',
              sessionId,
              success: false,
              retryReason: 'superseded',
              error: 'Synthetic normal supersession',
            },
          ],
        };
      }
      const result =
        request.query.kind === 'readChanges'
          ? { state: 'ready', checkpoint: 'synthetic-zero', ids: [] }
          : {
              checkpoint: 'synthetic-zero',
              startPosition: 0,
              totalCount: 0,
              rows: [],
              hasMoreOlder: false,
              cursor: null,
            };
      return {
        ok: true,
        responses: [
          {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            result,
            pageTurns: [],
            historyRevision: 0,
            historyCount: 0,
            historyChange: null,
          },
        ],
      };
    },
  })({ sessionId, doc: new LoroDoc(), backendKind: 'roost' });
  const observation = data.history.observe(() => {});
  try {
    expect(await observation.initial).toEqual([]);
    expect(await data.history.readAll()).toEqual([]);
  } finally {
    observation.unsubscribe();
    data.dispose?.();
  }
});

it.each([1, 2, 3])(
  'replaces an unknown checkpoint with a bounded window at revision %i and reads older pages on demand',
  async (revision) => {
    const h = await cachedRecoveryFixture(`window-reset-${revision}`, 120);
    const timers = controlledRefreshTimers();
    const latestStarted = Promise.withResolvers<void>();
    const releaseLatest = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    const entries = h.entries.map((entry) => ({
      ...entry,
      items: [{ type: 'text' as const, text: 'new generation' }],
    }));
    const data = createLocalRoostSessionDataFactory({
      incremental: true,
      subscribeWake: h.subscribeWake,
      workspaceId: h.workspaceId,
      machineId: h.machineId,
      sendControl: async (request) => {
        if (request.type !== 'session/history-read') throw new Error('Unexpected write');
        const query = request.query;
        if (query.kind === 'readChanges')
          return h.reply(revision, { state: 'reset', checkpoint: `reset-${revision}` });
        if (query.kind === 'readRange') {
          expect(query.atCheckpoint).toBe(`reset-${revision}`);
          return h.reply(
            revision,
            entries.slice(query.from, query.to).map((turn) => ({ state: 'ready', turn }))
          );
        }
        if (query.kind !== 'readLatestPage') throw new Error('Recovery must not walk older pages');
        latestStarted.resolve();
        await releaseLatest.promise;
        return h.reply(
          revision,
          {
            checkpoint: `reset-${revision}`,
            startPosition: 80,
            totalCount: 120,
            rows: entries
              .slice(80)
              .map((turn, offset) => createRoostDirectoryRow(80 + offset, turn)),
            hasMoreOlder: true,
            cursor: 'owner-80',
          },
          entries.slice(80)
        );
      },
    })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
    const observation = data.history.observe(() => {
      void h.cache.getHead().then((head) => {
        if (head?.checkpoint === `reset-${revision}`) committed.resolve();
      });
    });
    try {
      await observation.initial;
      (await timers.next()).callback();
      await latestStarted.promise;
      expect(await h.cache.getHead()).toMatchObject({
        revision: 1,
        checkpoint: 'checkpoint-1',
        start: 0,
      });
      expect((await h.cache.readRows(0, 1))?.[0]?.turn).toEqual(h.entries[0]);
      releaseLatest.resolve();
      await committed.promise;
      expect(await h.cache.getHead()).toMatchObject({
        revision,
        checkpoint: `reset-${revision}`,
        start: 80,
      });
      expect(await h.cache.readRows(0, 1)).toBeUndefined();
      expect((await h.cache.readRows(80, 120))?.map((row) => row.turn)).toEqual(entries.slice(80));
      const latest = await data.history.readLatestDirectoryPage!(40);
      const older = await data.history.readOlderDirectoryPage!(latest.cursor!, 40);
      expect(older.rows.map((row) => row.turnId)).toEqual(
        entries.slice(40, 80).map((entry) => entry.id)
      );
      expect(await data.history.readTurn(entries[40]!.id)).toMatchObject({
        state: 'ready',
        turn: entries[40],
      });
      expect(await h.cache.getHead()).toMatchObject({ start: 40, checkpoint: `reset-${revision}` });
    } finally {
      releaseLatest.resolve();
      observation.unsubscribe();
      data.dispose?.();
      h.cache.dispose();
      timers.restore();
    }
  }
);

it.each(['valid', 'wrong-base', 'invalid-path', 'failed-repair'] as const)(
  'commits content patches atomically and repairs unusable bases (%s)',
  async (mode) => {
    Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
    const sessionId = `synthetic-content-patches-${mode}` as SessionId;
    const workspaceId = 'synthetic-workspace' as WorkspaceId;
    const machineId = 'synthetic-machine' as MachineId;
    const entry: SessionHistoryInput = {
      id: 'patch-tail',
      role: 'assistant',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'a🙂bc🚀d' }],
    };
    const expected: SessionHistoryInput = {
      ...entry,
      items: [{ type: 'text', text: 'a🙂XYZ🚀d尾' }],
    };
    const scope = JSON.stringify(['local', workspaceId, machineId, sessionId]);
    const cache = createRoostHistoryCache(scope);
    await cache.acceptPage(
      {
        checkpoint: 'patch-base',
        startPosition: 0,
        totalCount: 1,
        rows: [createRoostDirectoryRow(0, entry as never)],
        hasMoreOlder: false,
        cursor: null,
      },
      [entry],
      1
    );
    const scheduled = Promise.withResolvers<() => void>();
    const backoff = Promise.withResolvers<void>();
    const setTimer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay: number
    ) => {
      scheduled.resolve(callback);
      if (delay === 500) backoff.resolve();
      return callback as never;
    }) as typeof setTimeout);
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    const committed = Promise.withResolvers<void>();
    const repairing = Promise.withResolvers<void>();
    const releaseRepair = Promise.withResolvers<void>();
    const data = createLocalRoostSessionDataFactory({
      incremental: true,
      patches: true,
      workspaceId,
      machineId,
      sendControl: async (request) => {
        if (request.type !== 'session/history-read') throw new Error('Unexpected write');
        if (request.query.kind === 'readTurn') {
          expect(mode).not.toBe('valid');
          expect(request.query).toEqual({
            kind: 'readTurn',
            turnId: entry.id,
            atCheckpoint: 'patch-next',
          });
          repairing.resolve();
          await releaseRepair.promise;
          if (mode === 'failed-repair') throw new Error('Synthetic repair transport failure');
          return {
            ok: true,
            responses: [
              {
                type: 'session/history-read_response',
                sessionId,
                success: true,
                historyRevision: 2,
                historyCount: 1,
                result: { state: 'ready', turn: expected },
              },
            ],
          };
        }
        expect(request.query).toEqual({
          kind: 'readChanges',
          checkpoint: 'patch-base',
          includeBodiesFrom: 0,
          withPatches: true,
        });
        return {
          ok: true,
          responses: [
            {
              type: 'session/history-read_response',
              sessionId,
              success: true,
              historyRevision: 2,
              historyCount: 1,
              historyChange: { kind: 'changed', ids: [entry.id] },
              result: {
                state: 'ready',
                checkpoint: 'patch-next',
                ids: [entry.id],
                bodies: { changed: [], suffix: [] },
                patches: {
                  baseCheckpoint: mode === 'wrong-base' ? 'unavailable-base' : 'patch-base',
                  turns: [
                    {
                      turnId: entry.id,
                      operations: [
                        {
                          kind: 'spliceText',
                          path: [{ key: 'items' }, { index: 0 }, { key: 'text' }],
                          index: 2,
                          delete: 2,
                          text: 'XYZ',
                        },
                        {
                          kind: 'appendText',
                          path: [
                            { key: 'items' },
                            { index: mode === 'invalid-path' || mode === 'failed-repair' ? 4 : 0 },
                            { key: 'text' },
                          ],
                          text: '尾',
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        };
      },
    })({ sessionId, doc: new LoroDoc(), backendKind: 'roost' });
    const observation = data.history.observe(() => {
      void cache.getHead().then((head) => {
        if (head?.checkpoint === 'patch-next') committed.resolve();
      });
    });
    try {
      await observation.initial;
      (await scheduled.promise)();
      if (mode !== 'valid') {
        await repairing.promise;
        expect(await cache.getHead()).toMatchObject({ checkpoint: 'patch-base', revision: 1 });
        expect((await cache.readRows(0, 1))?.[0]?.turn).toEqual(entry);
        releaseRepair.resolve();
      }
      if (mode === 'failed-repair') {
        await backoff.promise;
        expect(await cache.getHead()).toMatchObject({ checkpoint: 'patch-base', revision: 1 });
        expect((await cache.readRows(0, 1))?.[0]?.turn).toEqual(entry);
        return;
      }
      await committed.promise;
      expect(await data.history.readTurn(entry.id)).toEqual({ state: 'ready', turn: expected });
      expect(await cache.getHead()).toMatchObject({ checkpoint: 'patch-next', revision: 2 });
      const reopened = createRoostHistoryCache(scope);
      try {
        expect(await reopened.getHead()).toMatchObject({ checkpoint: 'patch-next', revision: 2 });
        expect((await reopened.readRows(0, 1))?.[0]?.turn).toEqual(expected);
      } finally {
        reopened.dispose();
      }
    } finally {
      releaseRepair.resolve();
      observation.unsubscribe();
      data.dispose?.();
      cache.dispose();
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  }
);

it('advances coherent streaming replies even while newer owner wakes keep arriving', async () => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const sessionId = 'synthetic-continuous-stream' as SessionId;
  const workspaceId = 'synthetic-workspace' as WorkspaceId;
  const machineId = 'synthetic-machine' as MachineId;
  const entry: SessionHistoryInput = {
    id: 'stream-tail',
    role: 'assistant',
    timestamp: 'synthetic',
    items: [{ type: 'text', text: 'initial' }],
  };
  const cache = createRoostHistoryCache(
    JSON.stringify(['local', workspaceId, machineId, sessionId])
  );
  await cache.acceptPage(
    {
      checkpoint: 'checkpoint-1',
      startPosition: 0,
      totalCount: 1,
      rows: [createRoostDirectoryRow(0, entry as never)],
      hasMoreOlder: false,
      cursor: null,
    },
    [entry],
    1
  );
  const doc = new LoroDoc();
  let revision = 3;
  const timers: { callback: () => void; delay: number }[] = [];
  const timerWaiters: ((timer: { callback: () => void; delay: number }) => void)[] = [];
  const nextTimer = () =>
    timers.length
      ? Promise.resolve(timers.shift()!)
      : new Promise<{ callback: () => void; delay: number }>((resolve) =>
          timerWaiters.push(resolve)
        );
  const setTimer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay = 0
  ) => {
    const timer = { callback, delay };
    const waiter = timerWaiters.shift();
    if (waiter) waiter(timer);
    else timers.push(timer);
    return timer as never;
  }) as typeof setTimeout);
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  const completions = new Map<number, () => void>();
  let wake = () => {};
  const data = createLocalRoostSessionDataFactory({
    subscribeWake: (listener) => {
      wake = listener;
      return () => {
        wake = () => {};
      };
    },
    incremental: true,
    workspaceId,
    machineId,
    sendControl: async (request) => {
      if (request.type !== 'session/history-read' || request.query.kind !== 'readChanges')
        throw new Error('Streaming must advance within one observation reply');
      const atRevision = revision;
      expect(request.query.checkpoint).toBe(`checkpoint-${atRevision - 2}`);
      expect(request.query.includeBodiesFrom).toBe(0);
      expect(request.query).not.toHaveProperty('withPatches');
      revision += 2;
      wake();
      return {
        ok: true,
        responses: [
          {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            historyRevision: atRevision,
            historyCount: 1,
            historyChange: { kind: 'changed', ids: [entry.id] },
            result: {
              state: 'ready',
              checkpoint: `checkpoint-${atRevision}`,
              ids: [entry.id],
              bodies: {
                changed: [{ ...entry, items: [{ type: 'text', text: `chunk-${atRevision}` }] }],
                suffix: [],
              },
            },
          },
        ],
      };
    },
  })({ sessionId, doc, backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void cache.getHead().then((head) => {
      if (head) completions.get(head.revision)?.();
    });
  });
  try {
    await observation.initial;
    for (const expected of [3, 5, 7, 9]) {
      const completed = new Promise<void>((resolve) => completions.set(expected, resolve));
      const timer = await nextTimer();
      expect(timer.delay).toBe(0);
      timer.callback();
      await completed;
      expect(await cache.getHead()).toMatchObject({
        revision: expected,
        checkpoint: `checkpoint-${expected}`,
      });
      expect(revision).toBe(expected + 2);
      expect(await data.history.readTurn(entry.id)).toMatchObject({
        state: 'ready',
        turn: { items: [{ type: 'text', text: `chunk-${expected}` }] },
      });
      expect(await data.history.count()).toBe(1);
    }
  } finally {
    observation.unsubscribe();
    data.dispose?.();
    cache.dispose();
    setTimer.mockRestore();
    clearTimer.mockRestore();
  }
});

it('applies owner-pushed bodies after the machine capability arrives without another history read', async () => {
  const h = await cachedRecoveryFixture('quiet-session', 1);
  const timers = controlledRefreshTimers();
  const opened = Promise.withResolvers<void>();
  const visible = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let supports = false;
  let publish!: () => void;
  const data = createLocalRoostSessionDataFactory({
    workspaceId: h.workspaceId,
    machineId: h.machineId,
    incremental: () => supports,
    live: () => supports,
    subscribeWake: h.subscribeWake,
    sendControl: async (request, onResponse) => {
      if (request.type !== 'session/history-subscription')
        throw new Error('The pushed bodies should satisfy the read');
      const { subscription } = request;
      const end = {
        type: 'session/history-subscription_response' as const,
        sessionId: h.sessionId,
        subscriptionId: subscription.id,
        event: 'closed' as const,
      };
      if (subscription.action === 'open') {
        expect(subscription).toMatchObject({ checkpoint: 'checkpoint-1', includeBodiesFrom: 0 });
        const tail = {
          ...h.entries[0]!,
          items: [{ type: 'text' as const, text: 'after owner push' }],
        };
        const response = h.reply(3, {
          state: 'ready',
          checkpoint: 'checkpoint-3',
          ids: [tail.id],
          bodies: { changed: [tail], suffix: [] },
        }).responses[0]!;
        publish = () =>
          onResponse?.({
            ...end,
            event: 'publication',
            publication: {
              checkpoint: 'checkpoint-3',
              revision: 3,
              delta: { baseCheckpoint: 'checkpoint-1', includeBodiesFrom: 0, response },
            },
          });
        opened.resolve();
        await finish.promise;
      } else finish.resolve();
      return { ok: true, responses: [end] };
    },
  })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void h.cache.getHead().then((head) => {
      if (head?.revision === 3) visible.resolve();
    });
  });
  try {
    await observation.initial;
    supports = true;
    h.publish(1);
    await opened.promise;
    publish();
    (await timers.next()).callback();
    await visible.promise;
    expect(await h.cache.readTurn(h.entries[0]!.id)).toMatchObject({
      items: [{ type: 'text', text: 'after owner push' }],
    });
    expect(await h.cache.getHead()).toMatchObject({ revision: 3, checkpoint: 'checkpoint-3' });
    expect(h.doc.toJSON().roostHistoryCursor).toBeUndefined();
  } finally {
    observation.unsubscribe();
    data.dispose?.();
    h.cache.dispose();
    finish.resolve();
    timers.restore();
  }
});

it.each([
  [undefined, 1],
  ['different-checkpoint', 1],
  ['different-checkpoint', 2],
  ['different-checkpoint', 5],
  [undefined, 5],
] as const)(
  'keeps the verified prefix when a partial page has checkpoint %s at revision %i',
  async (checkpoint, revision) => {
    const h = await cachedRecoveryFixture('late-page-binding', 120);
    const prior = (await h.cache.getHead())!;
    const tail = { ...h.entries[119]!, items: [{ type: 'text' as const, text: 'unbound page' }] };
    try {
      await h.cache.acceptPage(
        {
          startPosition: 119,
          totalCount: 120,
          rows: [createRoostDirectoryRow(119, tail)],
          hasMoreOlder: true,
          cursor: 'older',
          checkpoint,
        },
        [tail],
        revision
      );
      expect(await h.cache.getHead()).toEqual(prior);
      expect((await h.cache.readRows(119, 120))?.[0]?.turn).toEqual(h.entries[119]);
      const target = { ...tail, items: [{ type: 'text' as const, text: 'verified next' }] };
      expect(
        await h.cache.applyChanges(prior, 2, 120, 'checkpoint-2', undefined, [
          { position: 119, turn: target },
        ])
      ).toBe(true);
      expect((await h.cache.readRows(119, 120))?.[0]?.turn).toEqual(target);
    } finally {
      h.cache.dispose();
    }
  }
);

it('uses complete bodies to repair an unbound window, then resumes patches from the repaired base', async () => {
  const h = await cachedRecoveryFixture('repair-then-patch', 120);
  const tail = { ...h.entries[119]!, items: [{ type: 'text' as const, text: 'oldA' }] };
  await h.cache.updateTurns(2, 120, [tail]);
  const timers = controlledRefreshTimers();
  const repaired = Promise.withResolvers<void>();
  const patched = Promise.withResolvers<void>();
  const data = createLocalRoostSessionDataFactory({
    incremental: true,
    patches: true,
    subscribeWake: h.subscribeWake,
    workspaceId: h.workspaceId,
    machineId: h.machineId,
    sendControl: async (request) => {
      if (request.type !== 'session/history-read') throw new Error('Unexpected write');
      const query = request.query;
      if (query.kind === 'readChanges' && query.checkpoint === 'checkpoint-1') {
        expect(query.withPatches).toBeUndefined();
        return h.reply(2, {
          state: 'ready',
          checkpoint: 'checkpoint-2',
          ids: [tail.id],
          bodies: { changed: [tail], suffix: [] },
        });
      }
      if (query.kind !== 'readChanges') throw new Error('Unexpected page or body fetch');
      expect(query).toMatchObject({ checkpoint: 'checkpoint-2', withPatches: true });
      return h.reply(3, {
        state: 'ready',
        checkpoint: 'checkpoint-3',
        ids: [tail.id],
        bodies: { changed: [], suffix: [] },
        patches: {
          baseCheckpoint: 'checkpoint-2',
          turns: [
            {
              turnId: tail.id,
              operations: [
                {
                  kind: 'appendText',
                  path: [{ key: 'items' }, { index: 0 }, { key: 'text' }],
                  text: 'B',
                },
              ],
            },
          ],
        },
      });
    },
  })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void h.cache.getHead().then((head) => {
      if (head?.checkpoint === 'checkpoint-2') repaired.resolve();
      if (head?.checkpoint === 'checkpoint-3') patched.resolve();
    });
  });
  try {
    await observation.initial;
    (await timers.next()).callback();
    await repaired.promise;
    expect(await h.cache.readTurn(tail.id)).toEqual(tail);
    h.publish(3);
    (await timers.next()).callback();
    await patched.promise;
    expect((await h.cache.readTurn(tail.id))?.items).toEqual([{ type: 'text', text: 'oldAB' }]);
    expect((await h.cache.readRows(0, 119))?.map((row) => row.turn)).toEqual(
      h.entries.slice(0, 119)
    );
  } finally {
    observation.unsubscribe();
    data.dispose?.();
    h.cache.dispose();
    timers.restore();
  }
});

it.each(['v1', 'v2'])(
  'isolates persisted %s heads and concurrent old-page writes from Native publication caches',
  async (version) => {
    Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
    const scope = 'synthetic-old-tab';
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`lody:roost-history-${version}`, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('heads');
        const rows = request.result.createObjectStore('rows', {
          keyPath: ['scope', 'slot', 'position'],
        });
        rows.createIndex('turn', ['scope', 'slot', 'turnId'], { unique: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const initial: SessionHistoryInput = {
      id: 'tail',
      role: 'assistant',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'base' }],
    };
    const advanced: SessionHistoryInput = { ...initial, items: [{ type: 'text', text: 'baseA' }] };
    const legacyWrite = (turn: SessionHistoryInput) =>
      new Promise<void>((resolve, reject) => {
        const tx = legacy.transaction(['heads', 'rows'], 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.objectStore('heads').put(
          { revision: 2, count: 1, start: 0, slot: 0, checkpoint: 'checkpoint-1' },
          [scope, 'head']
        );
        tx.objectStore('rows').put({
          scope,
          slot: 0,
          position: 0,
          turnId: turn.id,
          turn,
          row: createRoostDirectoryRow(0, turn as never),
        });
      });
    const cache = createRoostHistoryCache(scope);
    try {
      await legacyWrite(advanced);
      expect(await cache.getHead()).toBeUndefined();
      await cache.acceptPage(
        {
          checkpoint: 'checkpoint-1',
          startPosition: 0,
          totalCount: 1,
          rows: [createRoostDirectoryRow(0, initial as never)],
          hasMoreOlder: false,
          cursor: null,
        },
        [initial],
        1
      );
      const prior = (await cache.getHead())!;
      await legacyWrite({ ...initial, items: [{ type: 'text', text: 'baseAA' }] });
      expect(
        await cache.applyChanges(prior, 2, 1, 'checkpoint-2', undefined, [
          { position: 0, turn: advanced },
        ])
      ).toBe(true);
      expect((await cache.readRows(0, 1))?.[0]?.turn).toEqual(advanced);
      expect(await cache.getHead()).toMatchObject({ revision: 2, checkpoint: 'checkpoint-2' });
    } finally {
      cache.dispose();
      legacy.close();
    }
  }
);

it('rolls back incomplete cache repairs and removes a truncated suffix with its checkpoint', async () => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const entries: SessionHistoryInput[] = ['first', 'second', 'third'].map((id) => ({
    id,
    role: 'user',
    timestamp: '2026-10-16T00:00:00Z',
    items: [{ type: 'text', text: id }],
  }));
  const cache = createRoostHistoryCache('synthetic-atomic-cache');
  try {
    await cache.acceptPage(
      {
        checkpoint: 'checkpoint-1',
        startPosition: 0,
        totalCount: 3,
        rows: entries.map((entry, position) => createRoostDirectoryRow(position, entry as never)),
        hasMoreOlder: false,
        cursor: null,
      },
      entries,
      1
    );
    const original = await cache.getHead();
    if (!original) throw new Error('Missing head');
    await expect(
      cache.applyChanges(original, 3, 4, 'checkpoint-3', 2, [{ position: 3, turn: entries[0]! }])
    ).rejects.toThrow();
    expect(await cache.getHead()).toEqual(original);
    expect((await cache.readRows(0, 3))?.map((row) => row.turn.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(await cache.applyChanges(original, 5, 1, 'checkpoint-5', 1, [])).toBe(true);
    expect(await cache.getHead()).toMatchObject({
      revision: 5,
      count: 1,
      checkpoint: 'checkpoint-5',
    });
    expect((await cache.readRows(0, 1))?.[0]?.turn.id).toBe('first');
    expect(await cache.readAffected(['second', 'third'])).toEqual([]);
    expect(await cache.applyChanges(original, 6, 1, 'stale-checkpoint', undefined, [])).toBe(false);
    expect(await cache.getHead()).toMatchObject({
      revision: 5,
      count: 1,
      checkpoint: 'checkpoint-5',
    });
  } finally {
    cache.dispose();
  }
});

function controlledRefreshTimers() {
  type Timer = { callback: () => void; delay: number };
  const timers: Timer[] = [];
  const waiters: ((timer: Timer) => void)[] = [];
  const set = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay = 0
  ) => {
    const timer = { callback, delay };
    const waiter = waiters.shift();
    if (waiter) waiter(timer);
    else timers.push(timer);
    return timer as never;
  }) as typeof setTimeout);
  const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
    const index = timers.indexOf(handle as never);
    if (index >= 0) timers.splice(index, 1);
  });
  return {
    next: () =>
      timers.length
        ? Promise.resolve(timers.shift()!)
        : new Promise<Timer>((resolve) => waiters.push(resolve)),
    pending: () => [...timers],
    restore: () => {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

async function cachedRecoveryFixture(name: string, count: number, first = 0) {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const sessionId = `synthetic-recovery-${name}` as SessionId;
  const workspaceId = 'synthetic-workspace' as WorkspaceId;
  const machineId = 'synthetic-machine' as MachineId;
  const entries: SessionHistoryInput[] = Array.from({ length: count }, (_, position) => ({
    id: `recovery-${position}`,
    role: 'assistant',
    timestamp: 'synthetic',
    items: [{ type: 'text', text: 'old' }],
  }));
  const cache = createRoostHistoryCache(
    JSON.stringify(['local', workspaceId, machineId, sessionId])
  );
  await cache.acceptPage(
    {
      checkpoint: 'checkpoint-1',
      startPosition: first,
      totalCount: count,
      rows: entries
        .slice(first)
        .map((entry, offset) => createRoostDirectoryRow(first + offset, entry as never)),
      hasMoreOlder: first > 0,
      cursor: first > 0 ? String(first) : null,
    },
    entries.slice(first),
    1
  );
  const doc = new LoroDoc();
  const wakes = new Set<() => void>();
  const publish = (_revision: number, _ids?: string[]) => {
    for (const wake of wakes) wake();
  };
  const subscribeWake = (wake: () => void) => {
    wakes.add(wake);
    return () => {
      wakes.delete(wake);
    };
  };
  const reply = (revision: number, result: unknown, pageTurns?: SessionHistoryInput[]) => ({
    ok: true as const,
    responses: [
      {
        type: 'session/history-read_response' as const,
        success: true,
        sessionId,
        historyRevision: revision,
        historyCount: count,
        result,
        ...(pageTurns ? { pageTurns } : {}),
      },
    ],
  });
  return { sessionId, workspaceId, machineId, entries, cache, doc, publish, subscribeWake, reply };
}

it('refreshes an observed history from the owner when encrypted subscriptions are unavailable', async () => {
  const h = await cachedRecoveryFixture('encrypted-poll', 1);
  const timers = controlledRefreshTimers();
  const updated = { ...h.entries[0]!, items: [{ type: 'text' as const, text: 'owner update' }] };
  let changed = false;
  const data = createRemoteRoostSessionDataFactory({
    workspaceId: h.workspaceId,
    machineId: h.machineId,
    incremental: true,
    pollIntervalMs: 5000,
    requestHistoryRead: async (_machine, _session, query) => {
      if (query.kind !== 'readChanges') throw new Error('Expected a checkpoint read');
      return h.reply(
        changed ? 2 : 1,
        changed
          ? {
              state: 'ready',
              checkpoint: 'checkpoint-2',
              ids: [updated.id],
              bodies: { changed: [updated], suffix: [] },
            }
          : { state: 'ready', checkpoint: 'checkpoint-1', ids: [] }
      ).responses[0]!;
    },
    requestHistoryWrite: async () => {
      throw new Error('Unexpected write');
    },
  })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
  const observer = data.history.observe(() => {});
  try {
    await observer.initial;
    (await timers.next()).callback();
    const poll = await timers.next();
    expect(poll.delay).toBe(5000);
    changed = true;
    poll.callback();
    await timers.next();
    expect(await h.cache.readTurn(updated.id)).toMatchObject(updated);
  } finally {
    observer.unsubscribe();
    data.dispose?.();
    h.cache.dispose();
    timers.restore();
  }
});

it('renews an idle local subscription from the applied checkpoint and closes it with its observer', async () => {
  const h = await cachedRecoveryFixture('idle-subscription', 1);
  const timers = controlledRefreshTimers();
  const opens = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const releases = opens.map(() => Promise.withResolvers<void>());
  const seenIds: string[] = [];
  const stop = Promise.withResolvers<string>();
  const applied = Promise.withResolvers<void>();
  const data = createLocalRoostSessionDataFactory({
    incremental: true,
    live: true,
    workspaceId: h.workspaceId,
    machineId: h.machineId,
    sendControl: async (request, onResponse) => {
      if (request.type === 'session/history-read') {
        if (request.query.kind !== 'readChanges') throw new Error('Unexpected history query');
        return h.reply(2, {
          state: 'ready',
          checkpoint: 'checkpoint-2',
          ids: [h.entries[0]!.id],
          bodies: {
            changed: [{ ...h.entries[0], items: [{ type: 'text', text: 'fresh reply' }] }],
            suffix: [],
          },
        });
      }
      if (request.type !== 'session/history-subscription') throw new Error('Unexpected request');
      const { subscription } = request;
      const end = {
        type: 'session/history-subscription_response' as const,
        sessionId: h.sessionId,
        subscriptionId: subscription.id,
        event: 'closed' as const,
      };
      if (subscription.action === 'close') {
        stop.resolve(subscription.id);
        return { ok: true, responses: [end] };
      }
      const index = seenIds.push(subscription.id) - 1;
      expect(resolveLocalSessionControlTimeoutMs(request)).toBeGreaterThan(45_000);
      expect(subscription.checkpoint).toBe('checkpoint-1');
      onResponse?.({
        ...end,
        event: 'publication',
        publication: { checkpoint: `checkpoint-${index + 1}`, revision: index + 1 },
      });
      opens[index]!.resolve();
      await releases[index]!.promise;
      return { ok: true, responses: [end] };
    },
  })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void h.cache.getHead().then((head) => {
      if (head?.revision === 2) applied.resolve();
    });
  });
  try {
    await observation.initial;
    await opens[0]!.promise;
    releases[0]!.resolve();
    (await timers.next()).callback();
    await opens[1]!.promise;
    (await timers.next()).callback();
    await applied.promise;
    expect(await data.history.readAt(0)).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'fresh reply' }] },
    });
    observation.unsubscribe();
    expect(await stop.promise).toBe(seenIds[1]);
  } finally {
    observation.unsubscribe();
    data.dispose?.();
    h.cache.dispose();
    for (const release of releases) release.resolve();
    timers.restore();
  }
});

it.each(['edit', 'append'] as const)(
  'applies a shared history %s without rebuilding both views',
  async (kind) => {
    const h = await cachedRecoveryFixture('shared-' + kind, 2);
    const timers = controlledRefreshTimers();
    const appended = kind === 'append';
    const from = appended ? 2 : undefined;
    const turn = {
      ...h.entries[1]!,
      ...(appended ? { id: 'appended' } : {}),
      items: [{ type: 'text' as const, text: 'new reply' }],
    };
    const count = appended ? 3 : 2;
    const ids = appended ? [] : [turn.id];
    const head = { checkpoint: 'checkpoint-2', revision: 2 };
    function openWindow() {
      const online = Promise.withResolvers<() => void>();
      const changed = Promise.withResolvers<void>();
      const changes: SessionDataChange[] = [];
      const data = createRemoteRoostSessionDataFactory({
        incremental: true,
        live: true,
        workspaceId: h.workspaceId,
        machineId: h.machineId,
        subscribeHistory: async (_machine, _session, _open, publish, signal) => {
          const done = Promise.withResolvers<void>();
          signal.addEventListener('abort', () => done.resolve(), { once: true });
          online.resolve(() => publish(head));
          await done.promise;
        },
        requestHistoryRead: async (_machine, _session, query) => {
          if (query.kind !== 'readChanges') throw new Error('Unexpected owner read');
          expect(query.checkpoint).toBe('checkpoint-1');
          return {
            ...h.reply(2, {
              state: 'ready',
              checkpoint: head.checkpoint,
              from,
              ids,
              bodies: {
                from,
                changed: appended ? [] : [turn],
                suffix: appended ? [turn] : [],
              },
            }).responses[0]!,
            historyCount: count,
          };
        },
        requestHistoryWrite: async () => {
          throw new Error('Unexpected write');
        },
      })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
      const observation = data.history.observe((event) => {
        changes.push(event);
        changed.resolve();
      });
      return { data, observation, publish: online.promise, changed: changed.promise, changes };
    }
    const first = openWindow();
    const second = openWindow();
    try {
      await Promise.all([first.observation.initial, second.observation.initial]);
      (await first.publish)();
      (await timers.next()).callback();
      await first.changed;
      (await second.publish)();
      await second.changed;
      expect(second.changes).toEqual(
        appended ? [{ kind: 'structure', from: 2, to: 3 }] : [{ kind: 'changed', ids }]
      );
      expect(await second.data.history.readAt(count - 1)).toEqual({ state: 'ready', turn });
      expect(await second.data.history.readAt(0)).toEqual({ state: 'ready', turn: h.entries[0] });
    } finally {
      for (const view of [first, second]) {
        view.observation.unsubscribe();
        view.data.dispose();
      }
      h.cache.dispose();
      timers.restore();
    }
  }
);

it.each([false, true])(
  'loads a pending older page through shared tail edits (older turn also edited: %s)',
  async (editOlder) => {
    const h = await cachedRecoveryFixture('in-flight-older-' + editOlder, 41, 1);
    const timers = controlledRefreshTimers();
    const older = h.entries[0]!;
    const tail = h.entries.at(-1)!;
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const patched = {
      ...older,
      items: [{ type: 'text' as const, text: 'edited earlier turn' }],
    };
    let revision = 1;
    const open = () => {
      const online = Promise.withResolvers<(revision: number) => void>();
      let applied = Promise.withResolvers<void>();
      const data = createRemoteRoostSessionDataFactory({
        workspaceId: h.workspaceId,
        machineId: h.machineId,
        incremental: true,
        live: true,
        subscribeHistory: async (_machine, _session, _open, publish, signal) => {
          const done = Promise.withResolvers<void>();
          signal.addEventListener('abort', () => done.resolve(), { once: true });
          online.resolve((next) => publish({ checkpoint: `checkpoint-${next}`, revision: next }));
          await done.promise;
        },
        requestHistoryRead: async (_machine, _session, query) => {
          if (query.kind === 'readRange') {
            expect([query.from, query.to]).toEqual([0, 1]);
            const target = Number(query.atCheckpoint?.split('-').at(-1));
            started.resolve();
            await gate.promise;
            return h.reply(target, [
              { state: 'ready', turn: editOlder && target > 1 ? patched : older },
            ]).responses[0]!;
          }
          if (query.kind !== 'readChanges') throw new Error('Unexpected owner read');
          return h.reply(revision, {
            state: 'ready',
            checkpoint: `checkpoint-${revision}`,
            ids: editOlder && revision === 2 ? [tail.id, older.id] : [tail.id],
            bodies: {
              changed: [
                { ...tail, items: [{ type: 'text', text: `Agent output ${revision}` }] },
                ...(editOlder && revision === 2 ? [patched] : []),
              ],
              suffix: [],
            },
          }).responses[0]!;
        },
        requestHistoryWrite: async () => {
          throw new Error('Unexpected write');
        },
      })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
      const history = {
        ...data.history,
        observe: (listener: (change: SessionDataChange) => void) =>
          data.history.observe((change) => {
            listener(change);
            if (change.kind === 'changed' && change.ids.includes(tail.id)) applied.resolve();
          }),
      };
      return {
        data,
        history,
        publish: online.promise,
        nextChange() {
          applied = Promise.withResolvers();
          return applied.promise;
        },
      };
    };
    const source = open();
    const observation = source.history.observe(() => {});
    const destination = open();
    const view = createConversationViewFromReader(destination.history, {
      sessionId: h.sessionId,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      const [publishSource, publishDestination] = await Promise.all([
        source.publish,
        destination.publish,
      ]);
      const loading = view.loadOlder!();
      const outcome = loading.catch((error: Error) => error.name);
      await started.promise;
      for (const next of [2, 3]) {
        const applied = source.nextChange();
        revision = next;
        publishSource(next);
        (await timers.next()).callback();
        await applied;
      }
      const adopted = destination.nextChange();
      publishDestination(revision);
      await adopted;
      gate.resolve();

      if (editOlder) {
        expect(await outcome).toBe('HistoryRefreshSupersededError');
        expect(view.indexOf(older.id)).toBe(-1);
        expect(await h.cache.readRows(0, 1)).toBeUndefined();
        expect(await view.loadOlder!()).toBe(true);
      } else {
        expect(await outcome).toBe(true);
      }
      expect(view.indexOf(older.id)).toBe(0);
      expect(await destination.history.readTurn(older.id)).toEqual({
        state: 'ready',
        turn: editOlder ? patched : older,
      });
      expect(await h.cache.getHead()).toMatchObject({ checkpoint: 'checkpoint-3', start: 0 });
    } finally {
      gate.resolve();
      view.dispose();
      observation.unsubscribe();
      source.data.dispose();
      destination.data.dispose();
      h.cache.dispose();
      timers.restore();
    }
  }
);

it.each([1, 9])(
  'adopts a shared history reset at revision %i in both open windows',
  async (revision) => {
    const h = await cachedRecoveryFixture('shared-reset-' + revision, 120, 80);
    const timers = controlledRefreshTimers();
    const old = h.entries;
    const current = old.map((turn) => ({
      ...turn,
      items: [{ type: 'text' as const, text: 'current generation' }],
    }));
    const checkpoint = 'current-generation';
    const page = (turns: SessionHistoryInput[], checkpoint: string) => ({
      checkpoint,
      startPosition: 80,
      totalCount: turns.length,
      hasMoreOlder: true,
      cursor: '80',
      rows: turns.slice(80).map((turn, index) => createRoostDirectoryRow(80 + index, turn)),
    });
    expect(await h.cache.acceptPage(page(old, 'retired-8'), old.slice(80), 8)).toBe(true);
    let reset = false;
    const lateReadStarted = Promise.withResolvers<void>();
    const releaseLateRead = Promise.withResolvers<void>();
    function openWindow() {
      const subscribed = Promise.withResolvers<() => void>();
      const release = Promise.withResolvers<void>();
      const updated = Promise.withResolvers<void>();
      const updates: SessionDataChange[] = [];
      const data = createLocalRoostSessionDataFactory({
        incremental: true,
        live: true,
        workspaceId: h.workspaceId,
        machineId: h.machineId,
        sendControl: async (request, publish) => {
          if (request.type === 'session/history-subscription') {
            const { subscription } = request;
            const envelope = {
              type: 'session/history-subscription_response' as const,
              sessionId: h.sessionId,
              subscriptionId: subscription.id,
            };
            if (subscription.action === 'open') {
              expect(subscription.checkpoint).toBe('retired-8');
              subscribed.resolve(() =>
                publish?.({
                  ...envelope,
                  event: 'publication',
                  publication: { checkpoint, revision },
                })
              );
              await release.promise;
            } else release.resolve();
            return { ok: true, responses: [{ ...envelope, event: 'closed' as const }] };
          }
          if (request.type !== 'session/history-read')
            throw new Error('Unexpected history mutation');
          const query = request.query;
          if (query.kind === 'readTurn') {
            const { turnId } = query;
            if (!reset && turnId === old[1]!.id) {
              lateReadStarted.resolve();
              await releaseLateRead.promise;
              return h.reply(8, { state: 'ready', turn: old[1] });
            }
            return h.reply(reset ? revision : 8, {
              state: 'ready',
              turn: (reset ? current : old).find((turn) => turn.id === turnId),
            });
          }
          if (query.kind === 'readChanges') {
            expect(query.checkpoint).toBe('retired-8');
            return h.reply(revision, { state: 'reset', checkpoint });
          }
          expect(query.kind).toBe('readLatestPage');
          return h.reply(revision, page(current, checkpoint), current.slice(80));
        },
      })({ sessionId: h.sessionId, doc: new LoroDoc(), backendKind: 'roost' });
      const observation = data.history.observe((change) => {
        updates.push(change);
        void h.cache.getHead().then((head) => {
          if (head?.checkpoint === checkpoint) updated.resolve();
        });
      });
      return {
        data,
        observation,
        subscribed,
        updated,
        updates,
        dispose: () => {
          observation.unsubscribe();
          data.dispose?.();
          release.resolve();
        },
      };
    }
    const first = openWindow();
    const second = openWindow();
    try {
      await Promise.all([first.observation.initial, second.observation.initial]);
      const [publishFirst, publishSecond] = await Promise.all([
        first.subscribed.promise,
        second.subscribed.promise,
      ]);
      expect(await second.data.history.readTurn(old[0]!.id)).toMatchObject({ turn: old[0] });
      const inFlight = expect(second.data.history.readTurn(old[1]!.id)).rejects.toThrow(
        /superseded/
      );
      await lateReadStarted.promise;
      reset = true;
      publishFirst();
      (await timers.next()).callback();
      await first.updated.promise;
      const beforeSecond = second.updates.length;
      publishSecond();
      await second.updated.promise;
      expect(second.updates).toHaveLength(beforeSecond + 1);
      releaseLateRead.resolve();
      await inFlight;

      expect(await h.cache.getHead()).toMatchObject({ revision, checkpoint });
      expect(await second.data.history.readTurn(old[0]!.id)).toMatchObject({ turn: current[0] });
      expect(await second.data.history.readTurn(old[1]!.id)).toMatchObject({ turn: current[1] });
      publishSecond();
      await second.data.history.readLatestDirectoryPage(40);
      expect(second.updates).toHaveLength(beforeSecond + 1);
      expect(timers.pending()).toHaveLength(0);
    } finally {
      first.dispose();
      second.dispose();
      releaseLateRead.resolve();
      h.cache.dispose();
      timers.restore();
    }
  }
);

it('commits a bounded reset while the owner keeps writing, then catches up incrementally', async () => {
  const h = await cachedRecoveryFixture('streaming-reset', 120);
  const timers = controlledRefreshTimers();
  const committed2 = Promise.withResolvers<void>();
  const committed3 = Promise.withResolvers<void>();
  const entries = h.entries.map((entry) => ({
    ...entry,
    items: [{ type: 'text' as const, text: 'new generation' }],
  }));
  const nextTail = { ...entries[119]!, items: [{ type: 'text' as const, text: 'next chunk' }] };
  const data = createLocalRoostSessionDataFactory({
    incremental: true,
    patches: true,
    subscribeWake: h.subscribeWake,
    workspaceId: h.workspaceId,
    machineId: h.machineId,
    sendControl: async (request) => {
      if (request.type !== 'session/history-read') throw new Error('Unexpected write');
      const query = request.query;
      if (query.kind === 'readChanges') {
        if (query.checkpoint === 'checkpoint-1')
          return h.reply(2, { state: 'reset', checkpoint: 'checkpoint-2' });
        expect(query.checkpoint).toBe('checkpoint-2');
        return h.reply(3, {
          state: 'ready',
          checkpoint: 'checkpoint-3',
          ids: [nextTail.id],
          bodies: { changed: [nextTail], suffix: [] },
        });
      }
      if (query.kind !== 'readLatestPage') throw new Error('Reset must not scan unchanged history');
      // The protected page was read before the next write's control hint arrived.
      h.publish(3);
      return h.reply(
        2,
        {
          checkpoint: 'checkpoint-2',
          startPosition: 80,
          totalCount: 120,
          rows: entries.slice(80).map((turn, index) => createRoostDirectoryRow(80 + index, turn)),
          hasMoreOlder: true,
          cursor: 'owner-80',
        },
        entries.slice(80)
      );
    },
  })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void h.cache.getHead().then((head) => {
      if (head?.checkpoint === 'checkpoint-2') committed2.resolve();
      if (head?.checkpoint === 'checkpoint-3') committed3.resolve();
    });
  });
  try {
    await observation.initial;
    (await timers.next()).callback();
    await committed2.promise;
    expect(await h.cache.getHead()).toMatchObject({
      start: 80,
      revision: 2,
      checkpoint: 'checkpoint-2',
    });
    expect(await data.history.readTurn(entries[119]!.id)).toMatchObject({
      state: 'ready',
      turn: entries[119],
    });
    (await timers.next()).callback();
    await committed3.promise;
    expect(await data.history.readTurn(nextTail.id)).toMatchObject({
      state: 'ready',
      turn: nextTail,
    });
    expect(await h.cache.getHead()).toMatchObject({
      start: 80,
      revision: 3,
      checkpoint: 'checkpoint-3',
    });
    expect((await h.cache.readRows(80, 119))?.map((row) => row.turn)).toEqual(
      entries.slice(80, 119)
    );
    expect(await h.cache.readTurn(entries[0]!.id)).toBeUndefined();
  } finally {
    observation.unsubscribe();
    data.dispose?.();
    h.cache.dispose();
    timers.restore();
  }
});

it('rejects a late reset window after another tab advances the durable cache', async () => {
  const h = await cachedRecoveryFixture('reset-cas', 120);
  try {
    const prior = (await h.cache.getHead())!;
    const next = { ...h.entries[119]!, items: [{ type: 'text' as const, text: 'newer tab' }] };
    expect(
      await h.cache.applyChanges(prior, 3, 120, 'checkpoint-3', undefined, [
        { position: 119, turn: next },
      ])
    ).toBe(true);
    expect(
      await h.cache.acceptPage(
        {
          checkpoint: 'checkpoint-4',
          startPosition: 80,
          totalCount: 120,
          rows: h.entries.slice(80).map((turn, index) => createRoostDirectoryRow(80 + index, turn)),
          hasMoreOlder: true,
          cursor: 'owner-80',
        },
        h.entries.slice(80),
        // Even a newer window must not replace a head advanced since the reset began.
        4,
        undefined,
        prior
      )
    ).toBe(false);
    expect(await h.cache.getHead()).toMatchObject({ checkpoint: 'checkpoint-3', start: 0 });
    expect(await h.cache.readTurn(next.id)).toEqual(next);
  } finally {
    h.cache.dispose();
  }
});

it('retries only a timed-out page and commits the exact repair despite a newer read', async () => {
  const h = await cachedRecoveryFixture('paged-repair', 1);
  const timers = controlledRefreshTimers();
  const lastPageStarted = Promise.withResolvers<void>();
  const releaseLastPage = Promise.withResolvers<void>();
  const nextCommitted = Promise.withResolvers<void>();
  const suffix = Array.from({ length: 501 }, (_, index) => ({
    ...h.entries[0]!,
    id: `missed-${index}`,
  }));
  const readPages: number[] = [];
  const tail = suffix.at(-1)!;
  const newTail = { ...tail, items: [{ type: 'text' as const, text: 'new revision' }] };
  const reply = (revision: number, result: unknown) => ({
    ...h.reply(revision, result).responses[0]!,
    historyCount: 1 + suffix.length,
  });
  const data = createRemoteRoostSessionDataFactory({
    incremental: true,
    workspaceId: h.workspaceId,
    machineId: h.machineId,
    requestHistoryRead: async (_owner, _session, query) => {
      if (query.kind === 'readChanges') {
        if (query.checkpoint === 'checkpoint-1')
          return reply(2, { state: 'ready', checkpoint: 'checkpoint-2', ids: [], from: 1 });
        expect(query.checkpoint).toBe('checkpoint-2');
        return reply(3, {
          state: 'ready',
          checkpoint: 'checkpoint-3',
          ids: [tail.id],
          bodies: { changed: [newTail], suffix: [] },
        });
      }
      if (query.kind === 'readRange') {
        expect(query.atCheckpoint).toBe('checkpoint-2');
        readPages.push(query.from);
        if (readPages.length === 2) {
          lastPageStarted.resolve();
          await releaseLastPage.promise;
          return {
            ...reply(2, undefined),
            success: false,
            error: 'History request timed out',
            rpcFailure: {
              source: 'transport',
              code: 'response_timeout',
              requestId: 'timed-out-page',
              machineId: h.machineId,
            },
          };
        }
        return reply(
          2,
          suffix.slice(query.from - 1, query.to - 1).map((turn) => ({ state: 'ready', turn }))
        );
      }
      if (query.kind === 'readTurn' && query.turnId === tail.id && !query.atCheckpoint)
        return reply(3, { state: 'ready', turn: newTail });
      throw new Error(`Unexpected ${query.kind}`);
    },
    requestHistoryWrite: async () => {
      throw new Error('Unexpected write');
    },
  })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void h.cache.getHead().then((head) => {
      if (head?.checkpoint === 'checkpoint-3') nextCommitted.resolve();
    });
  });
  try {
    await observation.initial;
    (await timers.next()).callback();
    await lastPageStarted.promise;
    expect(await data.history.readTurn(tail.id)).toMatchObject({ state: 'ready', turn: newTail });
    expect(await h.cache.getHead()).toMatchObject({ checkpoint: 'checkpoint-1', count: 1 });
    releaseLastPage.resolve();
    const followup = await timers.next();
    expect(await h.cache.getHead()).toMatchObject({ checkpoint: 'checkpoint-2', count: 502 });
    expect(await h.cache.readTurn(tail.id)).toEqual(tail);
    expect(readPages).toEqual([1, 501, 501]);
    followup.callback();
    await nextCommitted.promise;
    expect(await h.cache.readTurn(tail.id)).toEqual(newTail);
    expect((await h.cache.readRows(0, 501))?.map((row) => row.turn)).toEqual([
      ...h.entries,
      ...suffix.slice(0, -1),
    ]);
  } finally {
    releaseLastPage.resolve();
    observation.unsubscribe();
    data.dispose?.();
    h.cache.dispose();
    timers.restore();
  }
});

it('notifies the actual view for a committed non-inline interval even when a newer hint arrives during its transaction', async () => {
  const h = await cachedRecoveryFixture('commit-notification', 600, 560);
  const timers = controlledRefreshTimers();
  const events: SessionDataChange[] = [];
  const committed3 = Promise.withResolvers<void>();
  const tailVisible = Promise.withResolvers<void>();
  const newTail = {
    ...h.entries[599]!,
    items: [{ type: 'text' as const, text: 'new durable tail' }],
  };
  let hintSent = false;
  const originalPut = IDBObjectStore.prototype.put;
  const intercept = vi
    .spyOn(IDBObjectStore.prototype, 'put')
    .mockImplementation(function (this: IDBObjectStore, value, key) {
      const request =
        key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
      if (!hintSent && value?.checkpoint === 'checkpoint-2') {
        hintSent = true;
        h.publish(3, [h.entries[0]!.id]);
      }
      return request;
    });
  const data = createLocalRoostSessionDataFactory({
    incremental: true,
    subscribeWake: h.subscribeWake,
    workspaceId: h.workspaceId,
    machineId: h.machineId,
    sendControl: async (request) => {
      if (request.type !== 'session/history-read') throw new Error('Unexpected write');
      const query = request.query;
      if (query.kind === 'readChanges') {
        if (query.checkpoint === 'checkpoint-1')
          return h.reply(2, {
            state: 'ready',
            checkpoint: 'checkpoint-2',
            ids: h.entries.slice(0, 501).map((entry) => entry.id),
            from: 599,
          });
        return h.reply(3, {
          state: 'ready',
          checkpoint: 'checkpoint-3',
          ids: [h.entries[0]!.id],
          bodies: { changed: [h.entries[0]], suffix: [] },
        });
      }
      if (query.kind === 'readRange') return h.reply(2, [{ state: 'ready', turn: newTail }]);
      throw new Error(`Unexpected ${query.kind}`);
    },
  })({ sessionId: h.sessionId, doc: h.doc, backendKind: 'roost' });
  const observation = data.history.observe((change) => {
    events.push(change);
    void h.cache.getHead().then((head) => {
      if (head?.revision === 3) committed3.resolve();
    });
  });
  const view = createConversationViewFromReader(data.history, {
    sessionId: h.sessionId,
    tailKeep: 1,
    scheduleIdle: (task) => {
      queueMicrotask(() => task({ timeRemaining: () => 100 }));
      return () => {};
    },
  });
  const unsubscribe = view.subscribe(() => {
    const item = view.turn(599)?.items[0];
    if (item?.type === 'text' && item.text === 'new durable tail') tailVisible.resolve();
  });
  try {
    await observation.initial;
    await view.ready;
    expect(view.turn(599)?.items).toEqual([{ type: 'text', text: 'old' }]);
    (await timers.next()).callback();
    const retry = await timers.next();
    expect(hintSent).toBe(true);
    expect(await h.cache.getHead()).toMatchObject({ revision: 2, checkpoint: 'checkpoint-2' });
    expect(events).toContainEqual({ kind: 'structure', from: 599, to: 600 });
    expect(events).toContainEqual({
      kind: 'changed',
      ids: h.entries.slice(0, 501).map((entry) => entry.id),
    });
    await tailVisible.promise;
    retry.callback();
    await committed3.promise;
    expect(await h.cache.getHead()).toMatchObject({ revision: 3, checkpoint: 'checkpoint-3' });
    expect(await data.history.readAt(599)).toMatchObject({
      state: 'ready',
      turn: { items: newTail.items },
    });
    expect(view.turn(599)?.items).toEqual(newTail.items);
  } finally {
    unsubscribe();
    view.dispose();
    observation.unsubscribe();
    data.dispose?.();
    h.cache.dispose();
    intercept.mockRestore();
    timers.restore();
  }
});
