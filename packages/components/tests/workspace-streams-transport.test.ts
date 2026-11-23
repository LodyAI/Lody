import {
  createWorkspaceRepoStorage,
  createWorkspaceIncompleteRecoveryStore,
} from '../src/providers/workspace-repo-storage';
import { streamsSnapshotCodec } from '@lody/shared/streams-snapshot-codec';
/**
 * Web tabs (and a reloaded primary window) of one workspace open the same repo
 * IndexedDB and the same LoroDoc cursor database, each with its own in-memory
 * replica. Meta/Flock Streams progress must belong to the replica that loaded
 * it: a tab that hydrated before another tab advanced data and cursor has to
 * bootstrap, not resume at that tail.
 *
 * Drives the real renderer composition (`IndexedDBStorageAdaptor` + resilient
 * LoroDoc cursor store + `createWorkspaceStreamsTransport`) on fake-indexeddb
 * against a scripted Streams server.
 */
import 'fake-indexeddb/auto';
import { createPrivateKey, sign } from 'node:crypto';
import { Result } from 'effect';
import {
  Bytes,
  contentSigningBytes,
  encodeContentHeader,
  inspectContentFrame,
  deriveContentKey,
  sealContentAead,
  openContentAead,
  verifyContentSignature,
  type ContentScope,
} from '@lody/e2ee-core/protocol';
import { hashRecordBytes, recordSigningBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { encodeCbor } from '@lody/e2ee-core/protocol';
import { encodeStreamsRoomAdditionalData } from 'loro-repo/transport/streams';
import { InMemoryRemoteCursorStore, PayloadProtectionError } from '@loro-dev/streams-crdt';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import {
  createLoroStreamUrl,
  DEFAULT_LORO_STREAMS_BASE_URL,
  LEGACY_LORO_STREAMS_BASE_URL,
  getLoroStreamIdForDocId,
  LORO_STREAMS_BUCKET_ID,
  type WorkspaceId,
} from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import {
  encryptedWorkspaceResolver,
  encryptedWorkspaceRoom,
} from '@lody/shared/workspace-streams-content';
import { getScheduleRoomId, getScheduleRegistryFlockDocId } from '@lody/shared';
import type { PayloadProtectionProvider, RemoteCursorStore } from '@loro-dev/streams-crdt';
import { LoroRepo, type StorageSavePayload } from 'loro-repo';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { createResilientRemoteCursorStore } from '../src/providers/resilient-remote-cursor-store';
import { resolveWorkspaceRuntimeCacheIdentity } from '../src/providers/create-workspace-runtime';
import {
  createWorkspaceStreamsTransport,
  getWorkspaceMetaStreamUrl,
  WorkspaceStreamsConfigurationError,
  type WorkspaceStreamsContent,
} from '../src/providers/workspace-streams-transport';

const sdkOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('loro-repo/transport/streams', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('loro-repo/transport/streams')>();
  return {
    ...sdk,
    StreamsTransportAdapter: class extends sdk.StreamsTransportAdapter {
      constructor(options: ConstructorParameters<typeof sdk.StreamsTransportAdapter>[0]) {
        sdkOptions.push(options);
        super(options);
      }
    },
  };
});

const streamsBaseUrl = 'https://streams.checkpoint.invalid';
const tail100 = '00000000000000000100';
const keyA = ['m', 'doc-a', 'title'];
let sequence = 0;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

/** Meta stream holding `A` at offset 100; catch-up from 100 has nothing new. */
function createMetaServer() {
  const server = new Flock('server');
  server.put(keyA, 'A');
  const snapshot = server.exportFile();
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url);
      if (init?.method === 'POST') {
        const headers = new Headers(init.headers);
        return new Response(null, {
          headers: {
            'Producer-Epoch': headers.get('Producer-Epoch') ?? '0',
            'Producer-Seq': headers.get('Producer-Seq') ?? '0',
            'Stream-Next-Offset': tail100,
            'Stream-Up-To-Date': 'true',
          },
        });
      }
      if (url.pathname.endsWith('/bootstrap')) {
        return new Response(
          new Blob([
            '--cp\r\nContent-Type: application/octet-stream\r\n\r\n',
            toArrayBuffer(snapshot),
            '\r\n--cp--\r\n',
          ]),
          {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=cp',
              'Stream-Snapshot-Offset': tail100,
              'Stream-Next-Offset': tail100,
              'Stream-Up-To-Date': 'true',
            },
          }
        );
      }
      return new Response(null, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': url.searchParams.get('offset') ?? tail100,
          'Stream-Up-To-Date': 'true',
        },
      });
    })
  );
  const bootstraps = () => requests.filter((url) => url.pathname.endsWith('/bootstrap')).length;
  return { bootstraps };
}

type Tab = { repo: LoroRepo; workspaceId: WorkspaceId; cursorDbName: string };
const openTabs = new Set<Tab>();
const openTransports = new Set<ReturnType<typeof createWorkspaceStreamsTransport>>();

/** One tab of the workspace: same databases as its siblings, its own replica. */
async function openTab(
  workspaceId: WorkspaceId,
  storage?: IndexedDBStorageAdaptor,
  cloudOnly = false
): Promise<Tab> {
  const identity = resolveWorkspaceRuntimeCacheIdentity(workspaceId, '');
  const repo = await LoroRepo.create({
    storageAdapter: storage ?? createWorkspaceRepoStorage(identity.repoDbName),
    metaDebounceCommitMs: 0,
    ...(cloudOnly ? { resolveRoomTransports: () => ({ transportIds: ['cloud'] }) } : {}),
  });
  const tab = { repo, workspaceId, cursorDbName: identity.remoteCursorDbName };
  openTabs.add(tab);
  return tab;
}

async function syncMeta(tab: Tab) {
  const transport = createWorkspaceStreamsTransport({
    content: { mode: 'plaintext' },
    repo: tab.repo,
    workspaceId: tab.workspaceId,
    documentRemoteCursorStore: createResilientRemoteCursorStore({ dbName: tab.cursorDbName }),
    auth: async () => 'streams-jwt',
    streamsBaseUrl,
    shardHostSuffix: undefined,
  });
  try {
    return await transport.syncMeta(tab.repo.getMeta());
  } finally {
    await transport.close();
  }
}

/** Drain cooperative zero-delay tasks without advancing snapshot debounce timers. */
async function settle<T>(operation: Promise<T>, timeout = 5_000): Promise<T> {
  if (!vi.isFakeTimers()) return await operation;
  const completion = operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  const result = await vi.waitFor(() => completion, { interval: 0, timeout });
  if ('error' in result) throw result.error;
  return result.value;
}

afterEach(async () => {
  for (const transport of openTransports) await settle(transport.close(), 10_000);
  openTransports.clear();
  for (const tab of openTabs) await settle(tab.repo.destroy(), 10_000);
  openTabs.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('renderer Streams checkpoints are bound to the replica that loaded them', () => {
  it.each(['meta', 'flock'] as const)('resumes %s after a gateway alias switch', async (kind) => {
    const server = createMetaServer();
    const workspace = `alias-${++sequence}` as WorkspaceId;
    const sync = async (tab: Tab, baseUrl: string) => {
      const flock =
        kind === 'meta' ? tab.repo.getMeta() : (await tab.repo.openFlockDoc('named')).flock;
      const transport = transportFor(
        tab,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        baseUrl
      );
      const result =
        kind === 'meta'
          ? await transport.syncMeta(flock)
          : await transport.syncFlockDoc('named', flock);
      expect(result.ok).toBe(true);
      expect(flock.get(keyA)).toBe('A');
      await transport.close();
      openTransports.delete(transport);
      await tab.repo.flush();
    };
    const first = await openTab(workspace);
    await sync(first, LEGACY_LORO_STREAMS_BASE_URL);
    await first.repo.destroy();
    openTabs.delete(first);
    await sync(await openTab(workspace), DEFAULT_LORO_STREAMS_BASE_URL);
    expect(server.bootstraps()).toBe(1);
  });

  it.each(['unchanged', 'tail-advanced', 'writer'] as const)(
    'persists incomplete-tail recovery across IndexedDB instances: %s',
    async (scenario) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const server = createByteServer();
      const workspace = `persistent-gap-${++sequence}` as WorkspaceId;
      const id = 'gap';
      const url = docUrl(workspace, id);
      const path = new URL(url).pathname;
      const author = new LoroDoc();
      author.setPeerId('1');
      author.getText('t').insert(0, 'prefix');
      author.commit();
      const prefix = author.export({ mode: 'snapshot' });
      const from = author.version();
      author.getText('t').push('|tail');
      author.commit();
      const dependent = author.export({ mode: 'update', from });
      const frame = new Uint8Array(4 + dependent.byteLength);
      new DataView(frame.buffer).setUint32(0, dependent.byteLength);
      frame.set(dependent, 4);
      server.room(path).batches.push(frame);
      const db = `lody-loro-repo-db-${workspace}`;
      const firstStore = createWorkspaceIncompleteRecoveryStore(db);
      const first = await openTab(workspace);
      const doc = (await first.repo.openPersistedDoc(id)).doc;
      const transport = transportFor(
        first,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        firstStore
      );
      const subscription = transport.joinDocRoom(id, doc);
      void subscription.firstSyncedWithRemote.catch(() => {});
      await vi.waitFor(async () => expect(await firstStore.load(url)).not.toBeNull(), {
        interval: 0,
      });
      subscription.unsubscribe();
      await settle(transport.close());
      openTransports.delete(transport);
      await settle(first.repo.destroy());
      openTabs.delete(first);
      const nextStore = createWorkspaceIncompleteRecoveryStore(db);
      expect(await nextStore.load(url)).not.toBeNull();
      // A new remote snapshot also advances the tail. A writer instead has the
      // missing prefix locally and must be allowed to upload it at the same tail.
      if (scenario === 'tail-advanced') {
        const complete = author.export({ mode: 'snapshot' });
        server.room(path).batches.push(new Uint8Array(4));
        server.room(path).snapshot = {
          offset: server.offset(frame.byteLength + 4),
          body: await streamsSnapshotCodec.compress(complete),
        };
      }
      const next = await openTab(workspace);
      const loaded = (await next.repo.openPersistedDoc(id)).doc;
      if (scenario === 'writer') {
        loaded.import(prefix);
        await next.repo.flush();
      }
      const resumed = transportFor(
        next,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        nextStore
      );
      const before = server.requests.length;
      const live = scenario === 'unchanged' ? undefined : resumed.joinDocRoom(id, loaded);
      void live?.firstSyncedWithRemote.catch(() => {});
      try {
        if (!live) {
          expect((await settle(resumed.syncDoc(id, loaded))).ok).toBe(false);
          expect(server.requests.slice(before).map((r) => [r.method, r.url.pathname])).toEqual([
            ['HEAD', path],
          ]);
          expect(loaded.getText('t').toString()).toBe('');
        } else {
          await settle(live.firstSyncedWithRemote);
          expect(loaded.getText('t').toString()).toBe('prefix|tail');
          expect(await nextStore.load(url)).toBeNull();
          if (scenario === 'writer')
            expect(server.requests.slice(before).some((r) => r.method === 'POST')).toBe(true);
        }
      } finally {
        live?.unsubscribe();
        author.free();
      }
    }
  );

  it.each([undefined, false, true])(
    'passes foreground WS opt-in %s while the installed HTTP SDK still syncs',
    async (enabled) => {
      const server = createMetaServer();
      const tab = await openTab(`ws-opt-in-${++sequence}` as WorkspaceId);
      const transport = transportFor(tab, undefined, undefined, undefined, undefined, enabled);
      const options = sdkOptions.at(-1);
      if (enabled)
        expect(options).toMatchObject({
          webSocket: { enabled: true, url: streamsBaseUrl, authPoolKey: tab.workspaceId },
        });
      else expect(options).not.toHaveProperty('webSocket');
      const result = await transport.syncMeta(tab.repo.getMeta());
      expect(result.ok).toBe(true);
      expect(tab.repo.getMeta().get(keyA)).toBe('A');
      expect(server.bootstraps()).toBe(1);
    }
  );
  it('bootstraps a tab that hydrated before a sibling tab advanced the shared databases', async () => {
    const workspaceId = `ws-tabs-${++sequence}` as WorkspaceId;
    const server = createMetaServer();
    const staleTab = await openTab(workspaceId);
    const activeTab = await openTab(workspaceId);

    expect((await syncMeta(activeTab)).ok).toBe(true);
    expect(activeTab.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(1);

    // Both databases now hold A and offset 100, but the stale tab never
    // loaded A: resuming at 100 would skip it for the rest of its life.
    expect((await syncMeta(staleTab)).ok).toBe(true);
    expect(staleTab.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(2);
  });
});

function transportFor(
  tab: Tab,
  content?: WorkspaceStreamsContent,
  cursorStore?: RemoteCursorStore,
  auth?: Parameters<typeof createWorkspaceStreamsTransport>[0]['auth'],
  incompleteRecoveryScope?: object,
  webSocketEnabled?: boolean,
  incompleteRecoveryStore?: import('@loro-dev/streams-crdt').IncompleteRecoveryStore,
  baseUrl = streamsBaseUrl
) {
  const transport = createWorkspaceStreamsTransport({
    repo: tab.repo,
    webSocketEnabled,
    incompleteRecoveryStore,
    incompleteRecoveryScope,
    recoverFlockCheckpointsOnTimeout: true,
    workspaceId: tab.workspaceId,
    documentRemoteCursorStore:
      cursorStore ?? createResilientRemoteCursorStore({ dbName: tab.cursorDbName }),
    auth: auth ?? (async () => 'streams-jwt'),
    streamsBaseUrl: baseUrl,
    shardHostSuffix: undefined,
    bucketId: LORO_STREAMS_BUCKET_ID,
    content: content === undefined ? { mode: 'plaintext' } : content,
  });
  openTransports.add(transport);
  return transport;
}

const docUrl = (workspaceId: WorkspaceId, docId: string) =>
  createLoroStreamUrl({
    bucketId: LORO_STREAMS_BUCKET_ID,
    streamId: getLoroStreamIdForDocId(workspaceId, docId),
    baseUrl: streamsBaseUrl,
  });

/** Byte storage only: CRDT encoding, merge, protection and cursor logic all run in the SDK. */
function createByteServer(respond?: (url: URL, method: string) => Response | undefined) {
  type Room = {
    batches: Uint8Array[];
    trimmed?: boolean;
    snapshot?: { offset: string; body: Uint8Array };
  };
  const rooms = new Map<string, Room>();
  const requests: { url: URL; method: string; body: Uint8Array; auth: string | null }[] = [];
  const live = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const liveReady = Promise.withResolvers<void>();
  const snapshotReady = Promise.withResolvers<void>();
  const snapshotReplaced = Promise.withResolvers<void>();
  const room = (path: string) => {
    let value = rooms.get(path);
    if (!value) {
      value = { batches: [] };
      rooms.set(path, value);
    }
    return value;
  };
  const offset = (bytes: number) => String(bytes).padStart(20, '0');
  const tail = (path: string) =>
    offset(room(path).batches.reduce((sum, batch) => sum + batch.byteLength, 0));
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const headers = new Headers(init?.headers);
    requests.push({ url, method, body, auth: headers.get('Authorization') });
    const intercepted = respond?.(url, method);
    if (intercepted) return intercepted;
    const path = url.pathname.replace(/\/(bootstrap|snapshot(?:\/.*)?)$/, '');
    const value = room(path);
    const currentTail = () => tail(path);
    if (method === 'POST') {
      value.batches.push(body);
      return new Response(null, {
        headers: {
          'Stream-Next-Offset': currentTail(),
          'Stream-Up-To-Date': 'true',
          'Producer-Epoch': headers.get('Producer-Epoch') ?? '0',
          'Producer-Seq': headers.get('Producer-Seq') ?? '0',
        },
      });
    }
    if (method === 'PUT') {
      if (url.pathname.includes('/snapshot/')) {
        if (value.snapshot) snapshotReplaced.resolve();
        value.snapshot = { offset: decodeURIComponent(url.pathname.split('/').at(-1)!), body };
        snapshotReady.resolve();
      }
      return new Response(null, {
        status: url.pathname.includes('/snapshot/') ? 204 : 201,
        headers: { 'Stream-Next-Offset': currentTail() },
      });
    }
    if (method === 'GET' && url.pathname.includes('/snapshot/')) {
      const snapshot = value.snapshot;
      return snapshot
        ? new Response(toArrayBuffer(snapshot.body), {
            headers: {
              'Content-Length': String(snapshot.body.byteLength),
              'Stream-Snapshot-Offset': snapshot.offset,
            },
          })
        : new Response(null, { status: 404 });
    }
    if (method === 'HEAD')
      return new Response(null, {
        headers: {
          'Stream-Next-Offset': currentTail(),
          'Stream-Snapshot-Offset': value.snapshot?.offset ?? '-1',
          'Content-Type': 'application/octet-stream',
        },
      });
    if (url.pathname.endsWith('/bootstrap')) {
      const snapshot = value.snapshot;
      return new Response(
        new Blob([
          '--bytes\r\nContent-Type: application/octet-stream\r\n\r\n',
          toArrayBuffer(snapshot?.body ?? new Uint8Array()),
          '\r\n--bytes--\r\n',
        ]),
        {
          headers: {
            'Content-Type': 'multipart/mixed; boundary=bytes',
            'Stream-Snapshot-Offset': snapshot?.offset ?? '-1',
            'Stream-Next-Offset': snapshot?.offset ?? '-1',
            'Stream-Up-To-Date': String((snapshot?.offset ?? offset(0)) === currentTail()),
          },
        }
      );
    }
    const from = url.searchParams.get('offset');
    if (value.trimmed && (from === '-1' || from === null))
      return new Response(null, { status: 410 });
    // The server assigns byte offsets; consumers only retain and return these tokens.
    let bytes = 0;
    const start =
      from === '-1' || from === null
        ? 0
        : value.batches.findIndex((batch) => {
            bytes += batch.byteLength;
            return offset(bytes) === from;
          }) + 1;
    if (url.searchParams.get('live') === 'sse') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          live.set(path, controller);
          liveReady.resolve();
          const backlog = Buffer.concat(value.batches.slice(start));
          const data = backlog.length ? `event: data\ndata: ${backlog.toString('base64')}\n\n` : '';
          controller.enqueue(
            new TextEncoder().encode(
              `${data}event: control\ndata: ${JSON.stringify({ streamNextOffset: currentTail(), upToDate: true })}\n\n`
            )
          );
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Stream-SSE-Data-Encoding': 'base64' },
      });
    }
    return new Response(new Blob(value.batches.slice(start).map(toArrayBuffer)), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Stream-Next-Offset': currentTail(),
        'Stream-Up-To-Date': 'true',
      },
    });
  };
  vi.stubGlobal('fetch', fetch);
  return {
    room,
    requests,
    live,
    liveReady: liveReady.promise,
    snapshotReady: snapshotReady.promise,
    snapshotReplaced: snapshotReplaced.promise,
    offset,
    tail,
  };
}

/** Synthetic reversible provider: verifies SDK AAD binding; deliberately not cryptography. */
function testProtection(): PayloadProtectionProvider {
  return {
    maxSealOverheadBytes: 4096,
    seal({ plaintext, additionalData }) {
      const header = new Uint8Array([7]);
      const aad = additionalData(header);
      const sealed = new Uint8Array(2 + aad.length + plaintext.length);
      new DataView(sealed.buffer).setUint16(0, aad.length);
      sealed.set(aad, 2);
      sealed.set(
        plaintext.map((byte) => byte ^ 0xa5),
        2 + aad.length
      );
      return { header, sealed };
    },
    open({ sealed, additionalData }) {
      const length = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength).getUint16(0);
      expect(sealed.slice(2, 2 + length)).toEqual(additionalData);
      return sealed.slice(2 + length).map((byte) => byte ^ 0xa5);
    },
  };
}

function protectedContent(
  overrides: Partial<Extract<WorkspaceStreamsContent, { mode: 'protected' }>> = {}
): WorkspaceStreamsContent {
  return {
    mode: 'protected',
    namespace: 'trusted-workspace-identity',
    resolve: () => ({ mode: 'protected', config: { provider: testProtection() } }),
    snapshotUpload: { canUpload: () => false },
    ...overrides,
  };
}

class FailingStorage extends IndexedDBStorageAdaptor {
  fail = false;
  override async save(payload: StorageSavePayload) {
    if (this.fail) throw new Error('synthetic disk failure');
    await super.save(payload);
  }
  override async saveMany(payloads: readonly StorageSavePayload[]) {
    if (this.fail) throw new Error('synthetic disk failure');
    await super.saveMany(payloads);
  }
}

describe('workspace Streams gateway headers preserve drafts and prevent fenced resource recreation', () => {
  for (const kind of ['doc', 'flock', 'meta'] as const) {
    for (const [status, code] of [
      [404, 'space_not_found'],
      [410, 'space_generation_fenced'],
      [403, 'space_read_only'],
      [403, 'space_suspended'],
    ] as const) {
      it(`${kind}: ${status} ${code} retains local edits without creating streams, uploading or refreshing auth`, async () => {
        let denied = true;
        const server = createByteServer((_url, method) =>
          method === 'GET' && denied
            ? new Response(null, { status, headers: { 'Stream-Error-Code': code } })
            : undefined
        );
        const tab = await openTab(`header-${++sequence}` as WorkspaceId);
        const id = 'local-draft';
        const doc = kind === 'doc' ? (await tab.repo.openPersistedDoc(id)).doc : undefined;
        const flock =
          kind === 'meta'
            ? tab.repo.getMeta()
            : kind === 'flock'
              ? (await tab.repo.openFlockDoc(id)).flock
              : undefined;
        if (doc) {
          doc.getMap('data').set('draft', 'unsent local edit');
          doc.commit();
        } else flock!.put(['draft'], 'unsent local edit');
        const reasons: string[] = [];
        const cursors = createResilientRemoteCursorStore({ dbName: tab.cursorDbName });
        const transport = transportFor(tab, undefined, cursors, async (context) => {
          reasons.push(context?.reason ?? 'request');
          return 'streams-jwt';
        });
        const result = doc
          ? await transport.syncDoc(id, doc)
          : kind === 'meta'
            ? await transport.syncMeta(flock!)
            : await transport.syncFlockDoc(id, flock!);
        expect(result.ok).toBe(false);
        expect(doc ? doc.getMap('data').get('draft') : flock!.get(['draft'])).toBe(
          'unsent local edit'
        );
        expect(server.requests.some(({ method }) => method === 'PUT' || method === 'POST')).toBe(
          false
        );
        expect(reasons).not.toContain('unauthorized');
        const url =
          kind === 'meta'
            ? getWorkspaceMetaStreamUrl(tab.workspaceId, streamsBaseUrl)
            : kind === 'doc'
              ? docUrl(tab.workspaceId, id)
              : createLoroStreamUrl({
                  bucketId: LORO_STREAMS_BUCKET_ID,
                  streamId: id,
                  baseUrl: streamsBaseUrl,
                });
        const checkpoint = doc
          ? await cursors.load(url)
          : await tab.repo
              .getReplicaCheckpointStore(
                kind === 'meta'
                  ? { kind: 'meta', flock: flock! }
                  : { kind: 'flock', flockDocId: id, flock: flock! }
              )
              .load(url);
        expect(checkpoint).toBeNull();
        if (status === 404 || status === 410) {
          // A transient healthy response cannot resurrect a latched namespace fence.
          denied = false;
          const requestsBeforeRetry = server.requests.length;
          const retried = doc
            ? await transport.syncDoc(id, doc)
            : kind === 'meta'
              ? await transport.syncMeta(flock!)
              : await transport.syncFlockDoc(id, flock!);
          expect(retried.ok).toBe(false);
          expect(server.requests).toHaveLength(requestsBeforeRetry);
        }
      });
    }
    for (const code of [undefined, 'future_unrecognized_code']) {
      it(`${kind}: ordinary 404 (${code ?? 'no header'}) creates the missing stream, resumes its cursor and preserves edits through retention 410`, async () => {
        let exists = false;
        let retentionExpired = false;
        let returnedGone = false;
        const server = createByteServer((url, method) => {
          if (method === 'PUT') exists = true;
          if (method === 'GET' && !url.pathname.endsWith('/bootstrap') && retentionExpired) {
            retentionExpired = false;
            returnedGone = true;
            return new Response(null, {
              status: 410,
              headers: { 'Stream-Error-Code': 'gc_watermark_expired' },
            });
          }
          if (method === 'GET' && !exists)
            return new Response(null, {
              status: 404,
              headers: code ? { 'Stream-Error-Code': code } : {},
            });
          return undefined;
        });
        const tab = await openTab(`missing-stream-${++sequence}` as WorkspaceId);
        const id = 'local-draft';
        const doc = kind === 'doc' ? (await tab.repo.openPersistedDoc(id)).doc : undefined;
        const flock =
          kind === 'meta'
            ? tab.repo.getMeta()
            : kind === 'flock'
              ? (await tab.repo.openFlockDoc(id)).flock
              : undefined;
        if (doc) {
          doc.getMap('data').set('draft', 'offline text');
          doc.commit();
        } else flock!.put(['draft'], 'offline text');
        const transport = transportFor(tab);
        const sync = () =>
          doc
            ? transport.syncDoc(id, doc)
            : kind === 'meta'
              ? transport.syncMeta(flock!)
              : transport.syncFlockDoc(id, flock!);
        expect((await sync()).ok).toBe(true);
        expect(
          server.requests.filter(
            ({ method, url }) => method === 'PUT' && !url.pathname.includes('/snapshot/')
          )
        ).toHaveLength(1);
        const path = server.requests.find(({ method }) => method === 'POST')!.url.pathname;
        const checkpoint = server.tail(path);
        const bootstraps = () =>
          server.requests.filter(({ url }) => url.pathname.endsWith('/bootstrap')).length;
        const beforeResume = bootstraps();
        const beforeReads = server.requests.length;
        expect((await sync()).ok).toBe(true);
        expect(bootstraps()).toBe(beforeResume);
        expect(
          server.requests
            .slice(beforeReads)
            .some(({ url }) => url.searchParams.get('offset') === checkpoint)
        ).toBe(true);
        if (doc) {
          doc.getMap('data').set('draft', 'local edit during retention expiry');
          doc.commit();
        } else flock!.put(['draft'], 'local edit during retention expiry');
        retentionExpired = true;
        expect((await sync()).ok).toBe(true);
        expect(returnedGone).toBe(true);
        expect(bootstraps()).toBeGreaterThan(beforeResume);
        const reader = await openTab(`missing-stream-reader-${++sequence}` as WorkspaceId);
        reader.workspaceId = tab.workspaceId;
        const receiver = transportFor(reader);
        if (doc) {
          const remote = (await reader.repo.openPersistedDoc(id)).doc;
          expect((await receiver.syncDoc(id, remote)).ok).toBe(true);
          expect(remote.getMap('data').get('draft')).toBe('local edit during retention expiry');
        } else {
          const remote =
            kind === 'meta' ? reader.repo.getMeta() : (await reader.repo.openFlockDoc(id)).flock;
          expect(
            (
              await (kind === 'meta'
                ? receiver.syncMeta(remote)
                : receiver.syncFlockDoc(id, remote))
            ).ok
          ).toBe(true);
          expect(remote.get(['draft'])).toBe('local edit during retention expiry');
        }
      });
    }
    for (const status of [401, 403] as const) {
      it(`${kind}: ordinary ${status} refreshes the rejected token and preserves local uploads`, async () => {
        let rejected = false;
        const authContexts: { reason?: string; previousToken?: string }[] = [];
        const server = createByteServer((_url, method) => {
          if (method === 'GET' && !rejected) {
            rejected = true;
            return new Response(null, {
              status,
              headers: status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {},
            });
          }
          return undefined;
        });
        const tab = await openTab(`auth-refresh-${++sequence}` as WorkspaceId);
        const id = 'local-draft';
        const doc = kind === 'doc' ? (await tab.repo.openPersistedDoc(id)).doc : undefined;
        const flock =
          kind === 'meta'
            ? tab.repo.getMeta()
            : kind === 'flock'
              ? (await tab.repo.openFlockDoc(id)).flock
              : undefined;
        if (doc) {
          doc.getMap('data').set('draft', 'offline authenticated edit');
          doc.commit();
        } else flock!.put(['draft'], 'offline authenticated edit');
        let token = 'rejected-token';
        const transport = transportFor(tab, undefined, undefined, async (context) => {
          authContexts.push(context ?? {});
          if (context?.reason === 'unauthorized') token = 'refreshed-token';
          return token;
        });
        const result = doc
          ? await transport.syncDoc(id, doc)
          : kind === 'meta'
            ? await transport.syncMeta(flock!)
            : await transport.syncFlockDoc(id, flock!);
        expect(result.ok).toBe(true);
        expect(authContexts.filter(({ reason }) => reason === 'unauthorized')).toEqual([
          expect.objectContaining({ previousToken: 'rejected-token' }),
        ]);
        const upload = server.requests.find(({ method }) => method === 'POST');
        expect(upload?.auth).toBe('Bearer refreshed-token');
        const reader = await openTab(`auth-reader-${++sequence}` as WorkspaceId);
        reader.workspaceId = tab.workspaceId;
        const receiver = transportFor(reader);
        if (doc) {
          const restored = (await reader.repo.openPersistedDoc(id)).doc;
          expect((await receiver.syncDoc(id, restored)).ok).toBe(true);
          expect(restored.getMap('data').get('draft')).toBe('offline authenticated edit');
        } else {
          const restored =
            kind === 'meta' ? reader.repo.getMeta() : (await reader.repo.openFlockDoc(id)).flock;
          expect(
            (
              await (kind === 'meta'
                ? receiver.syncMeta(restored)
                : receiver.syncFlockDoc(id, restored))
            ).ok
          ).toBe(true);
          expect(restored.get(['draft'])).toBe('offline authenticated edit');
        }
      });
    }
  }
});

describe('renderer snapshot authorization stays separate from live write authorization', () => {
  it.each([undefined, 'space_read_only'])(
    'PUT snapshot 403 (%s) suppresses the same token without refreshing or stopping local uploads',
    async (code) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let currentToken = 'snapshot-token-1';
      let allowed = false;
      const rejected = Promise.withResolvers<void>();
      const uploaded = Promise.withResolvers<void>();
      const reasons: string[] = [];
      const server = createByteServer((url, method) =>
        method === 'PUT' && url.pathname.includes('/snapshot/') && !allowed
          ? new Response(null, { status: 403, headers: code ? { 'Stream-Error-Code': code } : {} })
          : undefined
      );
      const tab = await openTab(`snapshot-auth-${++sequence}` as WorkspaceId);
      const doc = (await tab.repo.openPersistedDoc('doc-a')).doc;
      const content = protectedContent({
        snapshotUpload: {
          canUpload: () => true,
          debounceMs: 10,
          minBytesSinceRemoteSnapshot: 0,
          onDiagnostic: (event) => {
            if (event.stage === 'put' && event.outcome === 'failed') rejected.resolve();
            if (event.stage === 'put' && event.outcome === 'succeeded') uploaded.resolve();
          },
        },
      });
      const transport = transportFor(tab, content, undefined, async (context) => {
        reasons.push(context?.reason ?? 'request');
        return currentToken;
      });
      const sub = transport.joinDocRoom('doc-a', doc);
      try {
        await settle(sub.firstSyncedWithRemote);
        doc.getMap('data').set('draft', 'first');
        doc.commit();
        await settle(sub.waitUntilSynced());
        await vi.advanceTimersByTimeAsync(10);
        await settle(rejected.promise);
        const puts = () =>
          server.requests.filter(
            ({ method, url }) => method === 'PUT' && url.pathname.includes('/snapshot/')
          );
        expect(puts()).toHaveLength(1);
        expect(reasons).not.toContain('unauthorized');
        const heads = server.requests.filter(({ method }) => method === 'HEAD').length;
        doc.getMap('data').set('draft', 'second');
        doc.commit();
        await settle(sub.waitUntilSynced());
        await vi.advanceTimersByTimeAsync(10);
        expect(puts()).toHaveLength(1);
        expect(server.requests.filter(({ method }) => method === 'HEAD')).toHaveLength(heads);
        currentToken = 'snapshot-token-2';
        allowed = true;
        doc.getMap('data').set('draft', 'after token rotation');
        doc.commit();
        await settle(sub.waitUntilSynced());
        await vi.advanceTimersByTimeAsync(10);
        await settle(uploaded.promise);
        expect(puts()).toHaveLength(2);
        expect(puts().at(-1)!.auth).toBe('Bearer snapshot-token-2');
        expect(reasons).not.toContain('unauthorized');
        const reader = await openTab(`snapshot-auth-reader-${++sequence}` as WorkspaceId);
        reader.workspaceId = tab.workspaceId;
        const restored = (await reader.repo.openPersistedDoc('doc-a')).doc;
        expect((await settle(transportFor(reader, content).syncDoc('doc-a', restored))).ok).toBe(
          true
        );
        expect(restored.toJSON()).toEqual(doc.toJSON());
      } finally {
        sub.unsubscribe();
      }
    }
  );
});

describe('pure-cloud room recovery keeps independent rooms alive', () => {
  it('retains a bounded incomplete-recovery budget across cloud adapter replacement without restarting healthy rooms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = createByteServer();
    const tab = await openTab(`cloud-budget-${++sequence}` as WorkspaceId, undefined, true);
    const owner = {};
    const healthyId = 'healthy-doc';
    const brokenId = 'missing-dependency-doc';
    const healthy = (await tab.repo.openPersistedDoc(healthyId)).doc;
    const broken = (await tab.repo.openPersistedDoc(brokenId)).doc;
    const remote = new LoroDoc();
    remote.getText('text').insert(0, 'dependency');
    remote.commit();
    const from = remote.version();
    remote.getText('text').push('|dependent');
    remote.commit();
    const pending = remote.export({ mode: 'update', from });
    const frame = new Uint8Array(4 + pending.byteLength);
    new DataView(frame.buffer).setUint32(0, pending.byteLength);
    frame.set(pending, 4);
    const brokenPath = new URL(docUrl(tab.workspaceId, brokenId)).pathname;
    server.room(brokenPath).batches.push(frame);
    const metaPath = new URL(getWorkspaceMetaStreamUrl(tab.workspaceId, streamsBaseUrl)).pathname;
    const healthyPath = new URL(docUrl(tab.workspaceId, healthyId)).pathname;
    const count = (path: string, suffix: string) =>
      server.requests.filter(({ url }) => url.pathname === path + suffix).length;
    const subscriptions: { unsubscribe(): void }[] = [];
    try {
      await settle(
        tab.repo.addTransport('cloud', transportFor(tab, undefined, undefined, undefined, owner), {
          ephemeral: true,
        })
      );
      const meta = await settle(tab.repo.joinMetaRoom());
      subscriptions.push(meta);
      const live = await settle(tab.repo.joinDocRoom(healthyId));
      subscriptions.push(live);
      await settle(meta.firstSyncedWithRemote);
      await settle(live.firstSyncedWithRemote);
      const fault = await settle(tab.repo.joinDocRoom(brokenId));
      subscriptions.push(fault);
      let faultSettled = false;
      void fault.firstSyncedWithRemote.then(
        () => {
          faultSettled = true;
        },
        () => {
          faultSettled = true;
        }
      );
      await vi.waitFor(
        () => expect(broken.exportPendingUpdates()?.byteLength ?? 0).toBeGreaterThan(0),
        { interval: 0 }
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(faultSettled).toBe(false);
      expect(broken.getText('text').toString()).toBe('');
      expect(count(brokenPath, '/bootstrap')).toBeGreaterThan(0);
      await settle(tab.repo.removeTransport('cloud', { close: true }));
      await settle(
        tab.repo.addTransport('cloud', transportFor(tab, undefined, undefined, undefined, owner), {
          ephemeral: true,
        })
      );
      const replacement = await settle(tab.repo.joinDocRoom(brokenId));
      subscriptions.push(replacement);
      let replacementSettled = false;
      void replacement.firstSyncedWithRemote.then(
        () => {
          replacementSettled = true;
        },
        () => {
          replacementSettled = true;
        }
      );
      let replacementSyncSettled = false;
      void replacement.waitUntilSynced().then(
        () => {
          replacementSyncSettled = true;
        },
        () => {
          replacementSyncSettled = true;
        }
      );
      // Explicit adapter replacement is allowed; subsequent room recovery must
      // not keep replacing unrelated streams or replenish the same owner's budget.
      await settle(meta.firstSyncedWithRemote);
      await settle(live.firstSyncedWithRemote);
      const metaBootstraps = count(metaPath, '/bootstrap');
      const healthyBootstraps = count(healthyPath, '/bootstrap');
      const brokenBootstraps = count(brokenPath, '/bootstrap');
      const healthyConnections = server.requests.filter(
        ({ url }) => url.pathname === healthyPath && url.searchParams.get('live') === 'sse'
      ).length;
      for (let attempt = 0; attempt < 6; attempt++) {
        await settle(tab.repo.reconnect({ resetBackoff: true }));
        // Keep healthy SSE channels active; an idle timeout is a separate failure.
        for (const [path, controller] of server.live) {
          if (path === brokenPath) continue;
          try {
            controller.enqueue(
              new TextEncoder().encode(
                `event: control\ndata: ${JSON.stringify({ streamNextOffset: server.tail(path), upToDate: true })}\n\n`
              )
            );
          } catch {
            /* a superseded channel is no longer the observed stream */
          }
        }
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(count(brokenPath, '/bootstrap')).toBeLessThanOrEqual(brokenBootstraps + 1);
      expect(count(metaPath, '/bootstrap')).toBe(metaBootstraps);
      expect(count(healthyPath, '/bootstrap')).toBe(healthyBootstraps);
      expect(
        server.requests.filter(
          ({ url }) => url.pathname === healthyPath && url.searchParams.get('live') === 'sse'
        )
      ).toHaveLength(healthyConnections);
      healthy.getMap('data').set('value', 'uploaded while another room is incomplete');
      healthy.commit();
      await settle(live.waitUntilSynced());
      const reader = await openTab(`cloud-budget-reader-${++sequence}` as WorkspaceId);
      reader.workspaceId = tab.workspaceId;
      const restored = (await reader.repo.openPersistedDoc(healthyId)).doc;
      expect((await settle(transportFor(reader).syncDoc(healthyId, restored))).ok).toBe(true);
      expect(restored.toJSON()).toEqual(healthy.toJSON());
      expect(replacementSettled).toBe(false);
      expect(replacementSyncSettled).toBe(false);
    } finally {
      for (const sub of subscriptions) sub.unsubscribe();
      remote.free();
    }
  });
  it('uploads cached missing predecessors and old unsent writes on the first admitted baseline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = createByteServer();
    const tab = await openTab(
      `first-cached-baseline-${++sequence}` as WorkspaceId,
      undefined,
      true
    );
    const common = new LoroDoc();
    const author = new LoroDoc();
    const reader = new LoroDoc();
    const id = 'first-cached-gap';
    const path = new URL(docUrl(tab.workspaceId, id)).pathname;
    common.getMap('base').set('cached', 'server-known'.repeat(1000));
    common.commit();
    const snapshot = common.export({ mode: 'snapshot' });
    author.import(snapshot);
    author.getText('gap').insert(0, 'a');
    author.commit();
    const predecessor = author.export({ mode: 'update', from: common.version() });
    const afterA = author.version();
    author.getText('gap').insert(1, 'b');
    author.commit();
    const dependent = author.export({ mode: 'update', from: afterA });
    const framed = new Uint8Array(4 + dependent.byteLength);
    new DataView(framed.buffer).setUint32(0, dependent.byteLength);
    framed.set(dependent, 4);
    server.room(path).snapshot = {
      offset: server.offset(0),
      body: await streamsSnapshotCodec.compress(snapshot),
    };
    server.room(path).batches.push(framed);
    const cached = (await tab.repo.openPersistedDoc(id)).doc;
    cached.import(snapshot);
    cached.import(predecessor);
    cached.getMap('local').set('unsent', true);
    cached.commit();
    await tab.repo.flush();
    const transport = transportFor(tab, undefined, new InMemoryRemoteCursorStore(), undefined, {});
    let subscription: Awaited<ReturnType<LoroRepo['joinDocRoom']>> | undefined;
    try {
      await settle(tab.repo.addTransport('cloud', transport, { ephemeral: true }));
      subscription = await settle(tab.repo.joinDocRoom(id));
      await settle(subscription.firstSyncedWithRemote);
      await settle(subscription.waitUntilSynced());
      reader.import(await streamsSnapshotCodec.decompress(server.room(path).snapshot!.body));
      // Reconstruct only what actually reached the server, including its B.
      for (const body of server.room(path).batches) {
        for (let offset = 0; offset < body.byteLength;) {
          const size = new DataView(body.buffer, body.byteOffset + offset, 4).getUint32(0);
          reader.import(body.subarray(offset + 4, offset + 4 + size));
          offset += 4 + size;
        }
      }
      const posts = server.requests.filter((r) => r.url.pathname === path && r.method === 'POST');
      const postBytes = posts.reduce((bytes, request) => bytes + request.body.byteLength, 0);
      expect(
        {
          gap: reader.getText('gap').toString(),
          hasPending: reader.exportPendingUpdates() !== undefined,
          unsent: reader.getMap('local').get('unsent'),
        },
        `Server replay after ${posts.length} POSTs (${postBytes} bytes)`
      ).toEqual({
        gap: 'ab',
        hasPending: false,
        unsent: true,
      });
      expect(reader.toJSON()).toEqual(cached.toJSON());
    } finally {
      subscription?.unsubscribe();
      await settle(transport.close());
      openTransports.delete(transport);
      reader.free();
      author.free();
      common.free();
    }
  });

  it.each(['local-commit', 'explicit-sync', 'passive-wait'] as const)(
    '%s respects writer intent and passive waiting at the thirty-minute host cap',
    async (trigger) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(0);
      const server = createByteServer();
      const owner = {};
      const workspace = `writer-floor-${++sequence}` as WorkspaceId;
      const id = 'writer-gap';
      const path = new URL(docUrl(workspace, id)).pathname;
      const common = new LoroDoc();
      const author = new LoroDoc();
      const reader = new LoroDoc();
      common.getMap('base').set('cached', 'server-known'.repeat(1000));
      common.commit();
      const snapshot = common.export({ mode: 'snapshot' });
      author.import(snapshot);
      author.getText('gap').insert(0, 'a');
      author.commit();
      const predecessor = author.export({ mode: 'update', from: common.version() });
      const afterA = author.version();
      author.getText('gap').insert(1, 'b');
      author.commit();
      const dependent = author.export({ mode: 'update', from: afterA });
      const framed = new Uint8Array(4 + dependent.byteLength);
      new DataView(framed.buffer).setUint32(0, dependent.byteLength);
      framed.set(dependent, 4);
      server.room(path).snapshot = {
        offset: server.offset(0),
        body: await streamsSnapshotCodec.compress(snapshot),
      };
      server.room(path).batches.push(framed);
      const countBootstrap = () =>
        server.requests.filter((r) => r.url.pathname === path + '/bootstrap').length;
      const isRead = (method: string, url: URL) =>
        method === 'GET' && (url.pathname === path + '/bootstrap' || url.pathname === path);
      const opened: Array<{
        transport: ReturnType<typeof transportFor>;
        subscription: ReturnType<ReturnType<typeof transportFor>['joinDocRoom']>;
      }> = [];
      const fixtureFetch = globalThis.fetch;
      const releaseWriterRead = Promise.withResolvers<void>();
      let writerReadIssued = false;
      let writerReadDelivered = false;
      let triggered = false;
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const auth = new Headers(init?.headers).get('Authorization');
        if (
          triggered &&
          auth === 'Bearer writer-acceptance' &&
          isRead(init?.method ?? 'GET', url) &&
          !writerReadDelivered
        ) {
          writerReadIssued = true;
          await releaseWriterRead.promise;
          const response = await fixtureFetch(input, init);
          writerReadDelivered = true;
          return response;
        }
        return fixtureFetch(input, init);
      });
      const openReplica = async (role: string, cached: boolean, hasPredecessor = false) => {
        const tab = await openTab(`writer-peer-${++sequence}` as WorkspaceId);
        tab.workspaceId = workspace;
        const doc = (await tab.repo.openPersistedDoc(id)).doc;
        if (cached) doc.import(snapshot);
        if (hasPredecessor) {
          doc.import(predecessor);
          doc.getMap('local').set('oldUnsent', true);
          doc.commit();
        }
        await tab.repo.flush();
        const transport = transportFor(
          tab,
          undefined,
          new InMemoryRemoteCursorStore(),
          async () => role,
          owner
        );
        const subscription = transport.joinDocRoom(id, doc);
        void subscription.firstSyncedWithRemote.catch(() => {});
        const item = { transport, subscription };
        opened.push(item);
        return { doc, ...item };
      };
      const closeReplica = async (replica: Awaited<ReturnType<typeof openReplica>>) => {
        replica.subscription.unsubscribe();
        await settle(replica.transport.close());
        openTransports.delete(replica.transport);
      };
      try {
        // Actual reanchor admissions: 30s, 60s, ... 960s, then the 1800s cap.
        // No private SDK budget API is called or mocked.
        for (let attempt = 0; attempt < 7; attempt++) {
          if (attempt > 0) await vi.advanceTimersByTimeAsync(30_000 * 2 ** (attempt - 1));
          const before = countBootstrap();
          const warm = await openReplica('warm-acceptance', false);
          await vi.waitFor(
            () => {
              expect(countBootstrap()).toBeGreaterThan(before);
              expect(warm.doc.exportPendingUpdates()?.byteLength ?? 0).toBeGreaterThan(0);
              expect(warm.subscription.status).toBe('reconnecting');
            },
            { interval: 0 }
          );
          await closeReplica(warm);
        }
        const readOnly = await openReplica('readonly-acceptance', true);
        let readOnlySettled = false;
        void readOnly.subscription.firstSyncedWithRemote.then(
          () => {
            readOnlySettled = true;
          },
          () => {
            readOnlySettled = true;
          }
        );
        await vi.waitFor(() => expect(readOnly.subscription.status).not.toBe('connecting'), {
          interval: 0,
        });
        const writer = await openReplica('writer-acceptance', true, true);
        let writerFirstSettled = false;
        void writer.subscription.firstSyncedWithRemote.then(
          () => {
            writerFirstSettled = true;
          },
          () => {
            writerFirstSettled = true;
          }
        );
        await vi.waitFor(() => expect(writer.subscription.status).not.toBe('connecting'), {
          interval: 0,
        });
        const beforeTrigger = server.requests.length;
        const preTriggerPosts = server.requests.filter(
          (r) =>
            r.url.pathname === path &&
            r.method === 'POST' &&
            (r.auth === 'Bearer readonly-acceptance' || r.auth === 'Bearer writer-acceptance')
        );
        const preTriggerReads = server.requests.filter(
          (r) =>
            isRead(r.method, r.url) &&
            (r.auth === 'Bearer readonly-acceptance' || r.auth === 'Bearer writer-acceptance')
        );
        const firstSettledBeforeTrigger = writerFirstSettled;
        let passiveWaitSettled = false;
        triggered = true;
        if (trigger === 'local-commit') {
          writer.doc.getMap('local').set('newCommit', true);
          writer.doc.commit();
        } else if (trigger === 'explicit-sync') {
          void writer.transport.syncDoc(id, writer.doc).catch(() => {});
        } else {
          // Observing upload completion is passive; it is not SDK awaitUploaded.
          void writer.subscription.waitUntilSynced().then(
            () => {
              passiveWaitSettled = true;
            },
            () => {
              passiveWaitSettled = true;
            }
          );
        }
        // The agreed one-second writer first-read floor is much less
        // than the host's current thirty-minute admission deadline.
        for (let elapsed = 0; elapsed < 1_000 && !writerReadIssued; elapsed += 1_000) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        const readOnlyReadsDuringFloor = server.requests.filter(
          (r) => isRead(r.method, r.url) && r.auth === 'Bearer readonly-acceptance'
        );
        const readOnlySettledDuringFloor = readOnlySettled;
        const beforeBaselinePosts = server.requests
          .slice(beforeTrigger)
          .filter(
            (r) =>
              r.url.pathname === path &&
              r.method === 'POST' &&
              r.auth === 'Bearer writer-acceptance'
          );
        const readIssuedWithinFloor = writerReadIssued;
        if (trigger === 'passive-wait') {
          const passiveRequests = server.requests.filter(
            (r) =>
              (r.auth === 'Bearer readonly-acceptance' || r.auth === 'Bearer writer-acceptance') &&
              (isRead(r.method, r.url) || (r.method === 'POST' && r.url.pathname === path))
          );
          expect(writer.doc.getMap('local').get('oldUnsent')).toBe(true);
          expect.soft(passiveRequests.length).toBe(0);
          expect.soft(readIssuedWithinFloor).toBe(false);
          expect.soft(writerFirstSettled).toBe(false);
          expect.soft(passiveWaitSettled).toBe(false);
          expect.soft(readOnlyReadsDuringFloor.length).toBe(0);
          expect.soft(readOnlySettledDuringFloor).toBe(false);
          // No writer intent was issued: do not require remote repair here.
          return;
        }
        releaseWriterRead.resolve();
        if (readIssuedWithinFloor) {
          // The released baseline can schedule upload/rejoin work. Drive its
          // fake timers within the existing completion budget.
          await vi.waitFor(() => expect(writerFirstSettled).toBe(true), {
            interval: 100,
            timeout: 5_000,
          });
          await settle(writer.subscription.firstSyncedWithRemote);
          await settle(writer.subscription.waitUntilSynced());
        }
        reader.import(await streamsSnapshotCodec.decompress(server.room(path).snapshot!.body));
        for (const body of server.room(path).batches) {
          for (let offset = 0; offset < body.byteLength;) {
            const size = new DataView(body.buffer, body.byteOffset + offset, 4).getUint32(0);
            reader.import(body.subarray(offset + 4, offset + 4 + size));
            offset += 4 + size;
          }
        }
        expect.soft(preTriggerReads.length).toBe(0);
        expect.soft(preTriggerPosts.length).toBe(0);
        expect.soft(firstSettledBeforeTrigger).toBe(false);
        expect.soft(readIssuedWithinFloor).toBe(true);
        expect.soft(beforeBaselinePosts.length).toBe(0);
        expect.soft(readOnlyReadsDuringFloor.length).toBe(0);
        expect.soft(readOnlySettledDuringFloor).toBe(false);
        expect(reader.getText('gap').toString()).toBe('ab');
        expect(reader.exportPendingUpdates()).toBeUndefined();
        expect(reader.getMap('local').get('oldUnsent')).toBe(true);
        if (trigger === 'local-commit') expect(reader.getMap('local').get('newCommit')).toBe(true);
      } finally {
        releaseWriterRead.resolve();
        for (const { transport, subscription } of opened) {
          subscription.unsubscribe();
          await settle(transport.close());
          openTransports.delete(transport);
        }
        reader.free();
        author.free();
        common.free();
      }
    }
  );

  it('does not reupload cached server history when replacement replicas cannot reanchor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = createByteServer();
    const tab = await openTab(`cached-budget-${++sequence}` as WorkspaceId);
    const owner = {};
    const common = new LoroDoc();
    const author = new LoroDoc();
    common.getMap('body').set('cached', 'already-server-known'.repeat(20_000));
    common.commit();
    const snapshot = common.export({ mode: 'snapshot' });
    author.import(snapshot);
    author.getText('gap').insert(0, 'a');
    author.commit();
    const from = author.version();
    author.getText('gap').insert(1, 'b');
    author.commit();
    const pending = author.export({ mode: 'update', from });
    const frame = new Uint8Array(4 + pending.byteLength);
    new DataView(frame.buffer).setUint32(0, pending.byteLength);
    frame.set(pending, 4);
    const path = new URL(docUrl(tab.workspaceId, 'cached-gap')).pathname;
    server.room(path).snapshot = {
      offset: server.offset(0),
      body: await streamsSnapshotCodec.compress(snapshot),
    };
    server.room(path).batches.push(frame);
    const bootstraps = () =>
      server.requests.filter(({ url }) => url.pathname === path + '/bootstrap').length;
    const posts = () =>
      server.requests.filter(({ url, method }) => url.pathname === path && method === 'POST');
    const observe = async (replica: LoroDoc, initial: boolean, replicaTab: Tab) => {
      // Each new replica gets its own cursor. Only the runtime's recovery
      // owner survives adapter replacement; no volatile position is shared.
      const transport = transportFor(
        replicaTab,
        undefined,
        new InMemoryRemoteCursorStore(),
        undefined,
        owner
      );
      const subscription = transport.joinDocRoom('cached-gap', replica);
      let firstSyncSettled = false;
      void subscription.firstSyncedWithRemote.then(
        () => {
          firstSyncSettled = true;
        },
        () => {
          firstSyncSettled = true;
        }
      );
      let syncSettled = false;
      void subscription.waitUntilSynced().then(
        () => {
          syncSettled = true;
        },
        () => {
          syncSettled = true;
        }
      );
      try {
        if (initial) {
          await vi.waitFor(
            () => {
              expect(replica.exportPendingUpdates()?.byteLength ?? 0).toBeGreaterThan(0);
              expect(bootstraps()).toBe(2);
            },
            { interval: 0 }
          );
        }
        // Observe the completed live-join startup before teardown can hide a
        // queued historical append. Keep this passive: explicit sync would be
        // writer intent and may legitimately admit a writer-priority baseline.
        await vi.waitFor(() => expect(subscription.status).toBe('reconnecting'), { interval: 0 });
        expect(firstSyncSettled).toBe(false);
        expect(syncSettled).toBe(false);
        expect(replica.getMap('body').toJSON()).toEqual(common.getMap('body').toJSON());
        expect(replica.toJSON().gap ?? '').toBe('');
      } finally {
        subscription.unsubscribe();
        await settle(transport.close());
        openTransports.delete(transport);
      }
    };
    try {
      const initial = (await tab.repo.openPersistedDoc('cached-gap')).doc;
      await observe(initial, true, tab);
      // These replicas restore only the known prefix, not the pending suffix.
      // A bootstrap-only counter would miss their repeated 400 KiB POSTs.
      for (let attempt = 0; attempt < 3; attempt++) {
        const replicaTab = await openTab(`cached-replica-${++sequence}` as WorkspaceId);
        replicaTab.workspaceId = tab.workspaceId;
        const cached = (await replicaTab.repo.openPersistedDoc('cached-gap')).doc;
        cached.import(snapshot);
        await observe(cached, false, replicaTab);
      }
      expect({
        bootstraps: bootstraps(),
        posts: posts().length,
        postBytes: posts().reduce((bytes, request) => bytes + request.body.byteLength, 0),
      }).toEqual({ bootstraps: 2, posts: 0, postBytes: 0 });
    } finally {
      // Registered replicas are destroyed by their owning Repo in afterEach.
      common.free();
      author.free();
    }
  });
});

describe('workspace Streams content boundary', () => {
  it.each([
    null,
    { mode: 'unknown' },
    { mode: 'protected' },
    protectedContent({ namespace: '' }),
    protectedContent({ snapshotUpload: undefined }),
  ])(
    'rejects incomplete or unknown content configuration before network I/O (%j)',
    async (content) => {
      const server = createByteServer();
      const tab = await openTab(`invalid-${++sequence}` as WorkspaceId);
      expect(() => transportFor(tab, content as WorkspaceStreamsContent)).toThrow(
        WorkspaceStreamsConfigurationError
      );
      expect(server.requests).toEqual([]);
    }
  );

  it.each([undefined, { mode: 'plaintext' } as const, protectedContent()])(
    'converges offline edits on two real documents and restores saved state (%j)',
    async (content) => {
      const server = createByteServer();
      const workspaceId = `peers-${++sequence}` as WorkspaceId;
      // Independent databases, same trusted workspace and room identity.
      const left = await openTab(`${workspaceId}-left` as WorkspaceId);
      const right = await openTab(`${workspaceId}-right` as WorkspaceId);
      left.workspaceId = right.workspaceId = workspaceId;
      const a = (await left.repo.openPersistedDoc('doc-a')).doc;
      const b = (await right.repo.openPersistedDoc('doc-a')).doc;
      a.setPeerId('101');
      b.setPeerId('202');
      a.getMap('data').set('left', 'offline A');
      a.commit();
      b.getMap('data').set('right', 'offline B');
      b.commit();
      const originalUpdate = a.export({ mode: 'update' });
      const ta = transportFor(left, content);
      const tb = transportFor(right, content);
      expect((await ta.syncDoc('doc-a', a)).ok).toBe(true);
      expect((await tb.syncDoc('doc-a', b)).ok).toBe(true);
      expect((await ta.syncDoc('doc-a', a)).ok).toBe(true);
      expect(a.toJSON()).toEqual({ data: { left: 'offline A', right: 'offline B' } });
      expect(b.toJSON()).toEqual(a.toJSON());
      const path = new URL(docUrl(workspaceId, 'doc-a')).pathname;
      expect(server.requests.every((request) => request.url.pathname.startsWith(path))).toBe(true);
      expect(server.requests.every((request) => request.auth === 'Bearer streams-jwt')).toBe(true);
      if (content?.mode !== 'protected') {
        expect(server.room(path).batches[0]!.slice(4)).toEqual(originalUpdate);
        const replica = new LoroDoc();
        // Ordinary POSTs are unchanged length-prefixed raw Loro updates.
        for (const batch of server.room(path).batches) {
          for (let cursor = 0; cursor < batch.length;) {
            const length = new DataView(batch.buffer, batch.byteOffset).getUint32(cursor);
            replica.import(batch.slice(cursor + 4, cursor + 4 + length));
            cursor += 4 + length;
          }
        }
        expect(replica.toJSON()).toEqual(a.toJSON());
      }
      await ta.close();
      await tb.close();
      await left.repo.destroy();
      openTabs.delete(left);
      const restored = await openTab(`${workspaceId}-left` as WorkspaceId);
      expect((await restored.repo.openPersistedDoc('doc-a')).doc.toJSON()).toEqual(b.toJSON());
    }
  );

  it.each([false, true])(
    'imports an ordinary snapshot and saves data before cursor (compressed=%s)',
    async (compressed) => {
      const server = createByteServer();
      const tab = await openTab(`snapshot-${++sequence}` as WorkspaceId);
      const source = new LoroDoc();
      source.getMap('data').set('title', 'snapshot');
      source.commit();
      const bytes = source.export({ mode: 'snapshot' });
      const url = docUrl(tab.workspaceId, 'doc-a');
      server.room(new URL(url).pathname).snapshot = {
        offset: server.offset(0),
        body: compressed ? await streamsSnapshotCodec.compress(bytes) : bytes,
      };
      const doc = (await tab.repo.openPersistedDoc('doc-a')).doc;
      const cursor = createResilientRemoteCursorStore({ dbName: tab.cursorDbName });
      const transport = transportFor(tab, undefined, {
        load: (key) => cursor.load(key),
        async save(value) {
          const restored = await openTab(tab.workspaceId);
          expect((await restored.repo.openPersistedDoc('doc-a')).doc.toJSON()).toEqual(
            source.toJSON()
          );
          await cursor.save(value);
        },
      });
      expect((await transport.syncDoc('doc-a', doc)).ok).toBe(true);
      expect(doc.toJSON()).toEqual(source.toJSON());
      expect((await cursor.load(url))?.nextOffset).toBe(server.offset(0));
    }
  );

  it('does not advance a document cursor when durable saving fails, then retries the same remote bytes', async () => {
    const server = createByteServer();
    const workspaceId = `save-failure-${++sequence}` as WorkspaceId;
    const storage = new FailingStorage({
      dbName: resolveWorkspaceRuntimeCacheIdentity(workspaceId, '').repoDbName,
    });
    const tab = await openTab(workspaceId, storage);
    const source = new LoroDoc();
    source.getMap('data').set('title', 'must persist');
    source.commit();
    const url = docUrl(tab.workspaceId, 'doc-a');
    server.room(new URL(url).pathname).snapshot = {
      offset: server.offset(0),
      body: source.export({ mode: 'snapshot' }),
    };
    const doc = (await tab.repo.openPersistedDoc('doc-a')).doc;
    const cursor = createResilientRemoteCursorStore({ dbName: tab.cursorDbName });
    storage.fail = true;
    const transport = transportFor(tab, undefined, cursor);
    expect((await transport.syncDoc('doc-a', doc)).ok).toBe(false);
    expect(await cursor.load(url)).toBeNull();
    storage.fail = false;
    expect((await transport.syncDoc('doc-a', doc)).ok).toBe(true);
    expect((await cursor.load(url))?.nextOffset).toBe(server.offset(0));
    const restored = await openTab(tab.workspaceId);
    expect((await restored.repo.openPersistedDoc('doc-a')).doc.toJSON()).toEqual(source.toJSON());
  });

  it.each([{ mode: 'plaintext' }, { mode: 'protected', config: {} }, undefined])(
    'rejects missing room protection without importing or saving progress (%j)',
    async (selection) => {
      const server = createByteServer();
      const tab = await openTab(`no-fallback-${++sequence}` as WorkspaceId);
      const doc = (await tab.repo.openPersistedDoc('doc-a')).doc;
      const cursor = createResilientRemoteCursorStore({ dbName: tab.cursorDbName });
      const transport = transportFor(
        tab,
        protectedContent({
          resolve: (() => selection) as Extract<
            WorkspaceStreamsContent,
            { mode: 'protected' }
          >['resolve'],
        }),
        cursor
      );
      const result = await transport.syncDoc('doc-a', doc);
      expect(result.ok).toBe(false);
      expect(doc.toJSON()).toEqual({});
      expect(await cursor.load(docUrl(tab.workspaceId, 'doc-a'))).toBeNull();
      expect(server.requests).toEqual([]);
    }
  );

  it('ignores an unprotected snapshot and replays the available empty history', async () => {
    const server = createByteServer();
    const tab = await openTab(`bad-snapshot-${++sequence}` as WorkspaceId);
    const source = new LoroDoc();
    source.getMap('data').set('secret', 'not admitted');
    source.commit();
    const url = docUrl(tab.workspaceId, 'doc-a');
    server.room(new URL(url).pathname).snapshot = {
      offset: server.offset(0),
      body: source.export({ mode: 'snapshot' }),
    };
    const doc = (await tab.repo.openPersistedDoc('doc-a')).doc;
    const cursor = createResilientRemoteCursorStore({ dbName: tab.cursorDbName });
    const result = await transportFor(tab, protectedContent(), cursor).syncDoc('doc-a', doc);
    expect(result.ok).toBe(true);
    expect(doc.toJSON()).toEqual({});
    expect((await cursor.load(url))?.nextOffset).toBe(server.offset(0));
  });

  it.each(['meta', 'flock'] as const)(
    'persists %s content and its replica checkpoint together, including a failed save',
    async (kind) => {
      const server = createByteServer();
      const workspaceId = `flock-save-${++sequence}` as WorkspaceId;
      const storage = new FailingStorage({
        dbName: resolveWorkspaceRuntimeCacheIdentity(workspaceId, '').repoDbName,
      });
      const tab = await openTab(workspaceId, storage);
      const id = 'named-catalog';
      const flock = kind === 'meta' ? tab.repo.getMeta() : (await tab.repo.openFlockDoc(id)).flock;
      const target = kind === 'meta' ? { kind, flock } : { kind, flockDocId: id, flock };
      const url =
        kind === 'meta'
          ? getWorkspaceMetaStreamUrl(workspaceId, streamsBaseUrl)
          : createLoroStreamUrl({
              bucketId: LORO_STREAMS_BUCKET_ID,
              streamId: id,
              baseUrl: streamsBaseUrl,
            });
      const source = new Flock('remote-source');
      source.put(keyA, 'durable catalog');
      server.room(new URL(url).pathname).snapshot = {
        offset: server.offset(0),
        body: source.exportFile(),
      };
      const transport = transportFor(tab);
      const sync = () =>
        kind === 'meta' ? transport.syncMeta(flock) : transport.syncFlockDoc(id, flock);
      storage.fail = true;
      expect((await sync()).ok).toBe(false);
      expect(await tab.repo.getReplicaCheckpointStore(target).load(url)).toBeNull();
      storage.fail = false;
      expect((await sync()).ok).toBe(true);
      expect(flock.get(keyA)).toBe('durable catalog');
      const restored = await openTab(workspaceId);
      const restoredFlock =
        kind === 'meta' ? restored.repo.getMeta() : (await restored.repo.openFlockDoc(id)).flock;
      expect(restoredFlock.get(keyA)).toBe('durable catalog');
      const restoredTarget =
        kind === 'meta'
          ? { kind, flock: restoredFlock }
          : { kind, flockDocId: id, flock: restoredFlock };
      expect(
        (await restored.repo.getReplicaCheckpointStore(restoredTarget).load(url))?.nextOffset
      ).toBe(server.offset(0));
    }
  );

  it('keeps a reader live through rejoin without local edits', async () => {
    // Hold automatic retry backoff until the explicit rejoin. Otherwise a slow
    // writer save can let the SDK reconnect before this fixture has new bytes.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = createByteServer();
    const workspaceId = `reader-${++sequence}` as WorkspaceId;
    const writer = await openTab(`${workspaceId}-writer` as WorkspaceId);
    const reader = await openTab(`${workspaceId}-reader` as WorkspaceId);
    writer.workspaceId = reader.workspaceId = workspaceId;
    const a = (await writer.repo.openPersistedDoc('doc-a')).doc;
    const b = (await reader.repo.openPersistedDoc('doc-a')).doc;
    const ta = transportFor(writer);
    const tb = transportFor(reader);
    a.getMap('data').set('value', 1);
    a.commit();
    expect((await ta.syncDoc('doc-a', a)).ok).toBe(true);
    const subscription = tb.joinDocRoom('doc-a', b);
    await subscription.firstSyncedWithRemote;
    await server.liveReady;
    expect(b.toJSON()).toEqual(a.toJSON());
    const originalVersion = b.version().toJSON();
    const disconnected = Promise.withResolvers<void>();
    const unwatch = subscription.onStatusChange((status) => {
      if (status === 'reconnecting' || status === 'disconnected' || status === 'error')
        disconnected.resolve();
    });
    server.live
      .get(new URL(docUrl(workspaceId, 'doc-a')).pathname)!
      .error(new Error('synthetic disconnect'));
    await disconnected.promise;
    unwatch();
    // The writer changes while the reader's connection is replaced. Rejoin must
    // catch up using its durable cursor, without requiring a local dirty write.
    const received = Promise.withResolvers<void>();
    const stopObserving = b.subscribe(() => {
      if (b.getMap('data').get('value') === 2) received.resolve();
    });
    a.getMap('data').set('value', 2);
    a.commit();
    expect((await ta.syncDoc('doc-a', a)).ok).toBe(true);
    await subscription.rejoin!();
    await received.promise;
    stopObserving();
    await subscription.waitUntilSynced();
    expect(b.toJSON()).toEqual({ data: { value: 2 } });
    expect(b.version().toJSON()).not.toEqual(originalVersion);
    expect(subscription.status).toBe('joined');
    subscription.unsubscribe();
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(2);
  });

  it('requires snapshot admission, protects the admitted snapshot and decodes it on a fresh reader', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = createByteServer();
    const tab = await openTab(`snapshot-upload-${++sequence}` as WorkspaceId);
    const doc = (await tab.repo.openPersistedDoc('doc-a')).doc;
    let permission: 'deny' | 'throw' | 'allow' = 'deny';
    const content = protectedContent({
      snapshotUpload: {
        canUpload() {
          if (permission === 'throw') throw new Error('synthetic admission failure');
          return permission === 'allow';
        },
        debounceMs: 10,
        minBytesSinceRemoteSnapshot: 0,
      },
      snapshotCodec: {
        compress: (bytes) => Uint8Array.from([42, ...bytes]),
        decompress: (bytes) => {
          expect(bytes[0]).toBe(42);
          return bytes.slice(1);
        },
      },
    });
    const transport = transportFor(tab, content);
    const subscription = transport.joinDocRoom('doc-a', doc);
    await settle(subscription.firstSyncedWithRemote);
    const path = new URL(docUrl(tab.workspaceId, 'doc-a')).pathname;
    for (const nextPermission of ['deny', 'throw', 'allow'] as const) {
      permission = nextPermission;
      doc.getMap('data').set('value', permission);
      doc.commit();
      await settle(subscription.waitUntilSynced());
      await vi.advanceTimersByTimeAsync(10);
      if (permission !== 'allow') expect(server.room(path).snapshot).toBeUndefined();
    }
    await server.snapshotReady;
    const snapshot = server.room(path).snapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot!.body[0]).not.toBe(42);
    expect(snapshot!.offset).toBe(server.tail(path));
    const reader = await openTab(`snapshot-reader-${++sequence}` as WorkspaceId);
    reader.workspaceId = tab.workspaceId;
    const restored = (await reader.repo.openPersistedDoc('doc-a')).doc;
    expect((await settle(transportFor(reader, content).syncDoc('doc-a', restored))).ok).toBe(true);
    expect(restored.toJSON()).toEqual({ data: { value: 'allow' } });
    subscription.unsubscribe();
  });

  it('publishes ordinary snapshots in the existing compressed Loro format', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = createByteServer();
    const tab = await openTab(`ordinary-upload-${++sequence}` as WorkspaceId);
    const doc = (await tab.repo.openPersistedDoc('doc-a')).doc;
    const subscription = transportFor(tab).joinDocRoom('doc-a', doc);
    await settle(subscription.firstSyncedWithRemote);
    let seed = 123456;
    const text = Array.from({ length: 200_000 }, () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return String.fromCharCode(32 + ((seed >>> 0) % 95));
    }).join('');
    doc.getMap('data').set('text', text);
    doc.commit();
    await settle(subscription.waitUntilSynced());
    const path = new URL(docUrl(tab.workspaceId, 'doc-a')).pathname;
    expect(Number(server.tail(path))).toBeGreaterThan(102400);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.room(path).snapshot).toBeUndefined();
    doc.getMap('data').set('aboveNewThreshold', text.repeat(6));
    doc.commit();
    await settle(subscription.waitUntilSynced());
    expect(Number(server.tail(path))).toBeGreaterThan(1024 * 1024);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(server.snapshotReady);
    const snapshot = server.room(path).snapshot;
    expect(snapshot?.offset).toBe(server.tail(path));
    const restored = new LoroDoc();
    restored.import(await streamsSnapshotCodec.decompress(snapshot!.body));
    expect(restored.toJSON()).toEqual(doc.toJSON());
    subscription.unsubscribe();
  });

  it('preserves the last durable cursor on async verification failure and can retry without skipping data', async () => {
    createByteServer();
    const workspaceId = `verify-${++sequence}` as WorkspaceId;
    const a = await openTab(`${workspaceId}-a` as WorkspaceId);
    const b = await openTab(`${workspaceId}-b` as WorkspaceId);
    a.workspaceId = b.workspaceId = workspaceId;
    const writer = (await a.repo.openPersistedDoc('doc-a')).doc;
    const reader = (await b.repo.openPersistedDoc('doc-a')).doc;
    const cursor = createResilientRemoteCursorStore({ dbName: b.cursorDbName });
    let reject = false;
    const provider = testProtection();
    const readerContent = protectedContent({
      resolve: () => ({
        mode: 'protected',
        config: {
          provider: {
            ...provider,
            async open(input) {
              if (reject) throw new Error('synthetic private provider detail');
              return await provider.open(input);
            },
          },
        },
      }),
    });
    const ta = transportFor(a, protectedContent());
    const tb = transportFor(b, readerContent, cursor);
    writer.getMap('data').set('value', 1);
    writer.commit();
    expect((await ta.syncDoc('doc-a', writer)).ok).toBe(true);
    expect((await tb.syncDoc('doc-a', reader)).ok).toBe(true);
    const url = docUrl(workspaceId, 'doc-a');
    const before = await cursor.load(url);
    writer.getMap('data').set('value', 2);
    writer.commit();
    expect((await ta.syncDoc('doc-a', writer)).ok).toBe(true);
    reject = true;
    const failure = await tb.syncDoc('doc-a', reader);
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error?.message).toContain('payload_protection_error');
      expect(failure.error?.message).not.toContain('private provider detail');
    }
    expect(reader.toJSON()).toEqual({ data: { value: 1 } });
    expect(await cursor.load(url)).toEqual(before);
    reject = false;
    expect((await tb.syncDoc('doc-a', reader)).ok).toBe(true);
    expect(reader.toJSON()).toEqual(writer.toJSON());
    expect((await cursor.load(url))?.nextOffset).not.toBe(before?.nextOffset);
  });
});

// P10 preparation only. The native signer and pinned key are synthetic test
// custody, not a production signer or a substitute for ledger author authority.
const syntheticPrivateKey = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex'
  ),
  format: 'der',
  type: 'pkcs8',
});
const syntheticSignerBytes = Uint8Array.from(
  Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex')
);
const syntheticSigner = Result.getOrThrow(Bytes.signingPublicKey(syntheticSignerBytes));
const syntheticDevice = Buffer.from(syntheticSignerBytes).toString('hex');
const syntheticEpochKey = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(0x55)));
// P08's public full replay establishes this synthetic *current* author only.
// It does not expose retired-author mappings; no historical authorization is
// implemented here and a pinned key alone is never advertised as that check.
const syntheticGenesisBody = [
  1,
  syntheticSignerBytes,
  new Uint8Array(32).fill(1),
  new Uint8Array(16).fill(2),
  new Uint8Array(32).fill(3),
  new Uint8Array(32).fill(4),
] as const;
const syntheticGenesis = Result.getOrThrow(
  encodeCbor([
    syntheticGenesisBody,
    new Uint8Array(
      sign(
        null,
        recordSigningBytes(Result.getOrThrow(encodeCbor(syntheticGenesisBody))),
        syntheticPrivateKey
      )
    ),
  ])
);
const syntheticHead = hashRecordBytes(syntheticGenesis);
const syntheticAuthority = Result.getOrThrow(
  verifyLedger({
    anchor: Result.getOrThrow(Bytes.genesisHash(syntheticHead.toBytes())),
    records: [syntheticGenesis],
    checkpoint: { head: syntheticHead, length: 1 },
  })
);
const syntheticScope = {
  genesis: Buffer.from(syntheticAuthority.genesis.toBytes()).toString('hex'),
  resource: 'doc-a',
  epoch: 0,
  docEpoch: 0,
} as const;

type CryptoFault = 'signature' | 'tag' | 'missing-key';

/** Independently compose public P07 primitives; never accept a verifier callback.
 * Header 3/4, whole-batch v0 and authenticated content-frame snapshot offset follow the current
 * content contract. Missing production signing/history ports remain blockers.
 */
function cryptoTestProtection(
  options: {
    scope?: Partial<ContentScope>;
    fault?: CryptoFault;
    snapshotOnly?: boolean;
    model?: 'loro' | 'flock';
  } = {}
): PayloadProtectionProvider {
  const scopeFor = (snapshot: boolean): ContentScope => ({
    ...syntheticScope,
    purpose:
      options.model === 'flock'
        ? snapshot
          ? 'flock-snapshot'
          : 'flock-update'
        : snapshot
          ? 'doc-snapshot'
          : 'doc-update',
    ...options.scope,
  });
  const unwrap = <A>(
    value: Result.Result<A, unknown>,
    reason: 'encrypt_failed' | 'decrypt_failed'
  ): A => {
    if (Result.isFailure(value))
      throw new PayloadProtectionError(reason, 'synthetic private crypto detail');
    return value.success;
  };
  return {
    maxSealOverheadBytes: 1 + 143 + 2 + 1024,
    seal(input) {
      const snapshot = input.context.kind === 'snapshot';
      const scope = scopeFor(snapshot);
      const trustedHeader = {
        ...scope,
        docEpoch: 0 as const,
        device: syntheticDevice,
        ...(snapshot ? { continuationOffset: input.context.continuationOffset } : {}),
      };
      const header = Uint8Array.of(snapshot ? 4 : 3);
      const binding = input.additionalData(header);
      const prefix = unwrap(encodeContentHeader(trustedHeader), 'encrypt_failed');
      const key = unwrap(deriveContentKey(syntheticEpochKey, scope), 'encrypt_failed');
      const encrypted = unwrap(
        sealContentAead(key, trustedHeader, input.plaintext, binding),
        'encrypt_failed'
      );
      if (options.fault === 'tag' && (!options.snapshotOnly || snapshot))
        encrypted.ciphertext[0] ^= 1;
      const unsigned = new Uint8Array(prefix.length + 24 + encrypted.ciphertext.length);
      unsigned.set(prefix);
      unsigned.set(encrypted.nonce, prefix.length);
      unsigned.set(encrypted.ciphertext, prefix.length + 24);
      const signature = sign(
        null,
        unwrap(contentSigningBytes(scope, unsigned, binding), 'encrypt_failed'),
        syntheticPrivateKey
      );
      if (options.fault === 'signature' && (!options.snapshotOnly || snapshot)) signature[0] ^= 1;
      return { header, sealed: Uint8Array.from(Buffer.concat([unsigned, signature])) };
    },
    open(input) {
      const snapshot = input.context.kind === 'snapshot';
      if (input.header.length !== 1 || input.header[0] !== (snapshot ? 4 : 3))
        throw new PayloadProtectionError('invalid_envelope');
      const scope = scopeFor(snapshot);
      expect(syntheticAuthority.inspectState().devices.has(syntheticDevice)).toBe(true);
      // Scope and signer are supplied independently; frame metadata never
      // selects a trusted Org, purpose, document, epoch or public key.
      const metadata = unwrap(
        verifyContentSignature(input.sealed, scope, syntheticSigner, input.additionalData),
        'decrypt_failed'
      );
      if (options.fault === 'missing-key' && (!options.snapshotOnly || snapshot))
        throw new PayloadProtectionError('missing_read_key', 'synthetic key detail');
      const trustedHeader = {
        ...scope,
        docEpoch: 0 as const,
        device: syntheticDevice,
        ...(snapshot ? { continuationOffset: metadata.continuationOffset } : {}),
      };
      const prefix = unwrap(encodeContentHeader(trustedHeader), 'decrypt_failed');
      const key = unwrap(deriveContentKey(syntheticEpochKey, scope), 'decrypt_failed');
      const bytes = unwrap(
        openContentAead(
          key,
          trustedHeader,
          input.sealed.slice(prefix.length, prefix.length + 24),
          input.sealed.slice(prefix.length + 24, -64),
          input.additionalData
        ),
        'decrypt_failed'
      );
      if (snapshot && metadata.continuationOffset !== input.context.continuationOffset) {
        bytes.fill(0);
        throw new PayloadProtectionError('decrypt_failed');
      }
      return bytes;
    },
  };
}

const cryptoContent = (provider?: PayloadProtectionProvider): WorkspaceStreamsContent =>
  protectedContent({
    resolve: (room) => ({
      mode: 'protected',
      config: {
        provider:
          provider ??
          cryptoTestProtection({
            scope: { resource: room.kind === 'doc' ? room.docId : 'unused' },
          }),
      },
    }),
  });

describe('P10 public crypto and published SDK preparation', () => {
  it.each(['doc', 'flock'] as const)(
    'syncs the schedule %s through the production encrypted selector, signed snapshots and durable storage',
    async (kind) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const server = createByteServer();
      const writer = await openTab(`schedule-w-${++sequence}` as WorkspaceId);
      const readerName = `schedule-r-${sequence}` as WorkspaceId;
      const reader = await openTab(readerName);
      reader.workspaceId = writer.workspaceId;
      const id =
        kind === 'doc'
          ? getScheduleRoomId('message')
          : getScheduleRegistryFlockDocId(writer.workspaceId);
      const content = protectedContent({
        resolve: encryptedWorkspaceResolver(writer.workspaceId, (room) => {
          const descriptor = encryptedWorkspaceRoom(writer.workspaceId, room);
          return cryptoTestProtection({
            scope: { resource: descriptor.resource },
            model: descriptor.model,
          });
        }),
        snapshotUpload: { canUpload: () => true, debounceMs: 10, minBytesSinceRemoteSnapshot: 0 },
      });
      const transport = transportFor(writer, content);
      if (kind === 'doc') {
        const doc = (await writer.repo.openPersistedDoc(id)).doc;
        const sub = transport.joinDocRoom(id, doc);
        await settle(sub.firstSyncedWithRemote);
        doc.getMap('schedule').set('prompt', 'Private scheduled message');
        doc.commit();
        await settle(sub.waitUntilSynced());
        await vi.advanceTimersByTimeAsync(10);
        await server.snapshotReady;
        const remote = (await reader.repo.openPersistedDoc(id)).doc;
        expect((await transportFor(reader, content).syncDoc(id, remote)).ok).toBe(true);
        expect(remote.toJSON()).toEqual(doc.toJSON());
      } else {
        const flock = (await writer.repo.openFlockDoc(id)).flock;
        const sub = transport.joinFlockDocRoom(id, flock);
        await settle(sub.firstSyncedWithRemote);
        flock.put(['schedule', 'message'], { title: 'Private scheduled message', enabled: true });
        await settle(sub.waitUntilSynced());
        await vi.advanceTimersByTimeAsync(10);
        await server.snapshotReady;
        const remote = (await reader.repo.openFlockDoc(id)).flock;
        expect((await transportFor(reader, content).syncFlockDoc(id, remote)).ok).toBe(true);
        expect(remote.get(['schedule', 'message'])).toEqual(flock.get(['schedule', 'message']));
      }
      const path =
        kind === 'doc'
          ? new URL(docUrl(writer.workspaceId, id)).pathname
          : `/ds/${LORO_STREAMS_BUCKET_ID}/${encodeURIComponent(id)}`;
      const room = server.room(path);
      expect(room.batches.length).toBeGreaterThan(0);
      expect(room.snapshot).toBeDefined();
      for (const bytes of [...room.batches, room.snapshot!.body])
        expect(Buffer.from(bytes).includes(Buffer.from('Private scheduled message'))).toBe(false);
      await reader.repo.flush();
      await reader.repo.destroy();
      openTabs.delete(reader);
      const restored = await openTab(readerName);
      if (kind === 'doc')
        expect(
          (await restored.repo.openPersistedDoc(id)).doc.getMap('schedule').get('prompt')
        ).toBe('Private scheduled message');
      else
        expect((await restored.repo.openFlockDoc(id)).flock.get(['schedule', 'message'])).toEqual({
          title: 'Private scheduled message',
          enabled: true,
        });
    }
  );

  it.each(['signature', 'tag', 'missing-key', 'org', 'document', 'purpose', 'epoch'] as const)(
    'rejects %s without changing saved content/cursor or stopping another document',
    async (failure) => {
      createByteServer();
      const writer = await openTab(`v0-fault-w-${++sequence}` as WorkspaceId);
      const reader = await openTab(`v0-fault-r-${++sequence}` as WorkspaceId);
      reader.workspaceId = writer.workspaceId;
      const a = (await writer.repo.openPersistedDoc('doc-a')).doc;
      const b = (await reader.repo.openPersistedDoc('doc-a')).doc;
      const cursor = createResilientRemoteCursorStore({ dbName: reader.cursorDbName });
      const ta = transportFor(writer, cryptoContent());
      const good = transportFor(reader, cryptoContent(), cursor);
      a.getMap('data').set('value', 1);
      a.commit();
      expect((await ta.syncDoc('doc-a', a)).ok).toBe(true);
      expect((await good.syncDoc('doc-a', b)).ok).toBe(true);
      const url = docUrl(writer.workspaceId, 'doc-a');
      const checkpoint = await cursor.load(url);
      await good.close();
      const scope =
        failure === 'org'
          ? { genesis: '22'.repeat(32) }
          : failure === 'document'
            ? { resource: 'doc-b' }
            : failure === 'purpose'
              ? { purpose: 'flock-update' as const }
              : failure === 'epoch'
                ? { epoch: 1 }
                : undefined;
      const faultyWriter =
        failure === 'signature' || failure === 'tag'
          ? transportFor(writer, cryptoContent(cryptoTestProtection({ fault: failure })))
          : ta;
      a.getMap('data').set('value', 2);
      a.commit();
      // One-shot sync reads its own append as well: hostile bytes are stored by
      // the byte fixture, then rejected by the writer's strict read boundary.
      expect((await faultyWriter.syncDoc('doc-a', a)).ok).toBe(
        failure !== 'signature' && failure !== 'tag'
      );
      const tb = transportFor(
        reader,
        protectedContent({
          resolve: (room) => ({
            mode: 'protected',
            config: {
              provider:
                room.kind === 'doc' && room.docId === 'doc-a'
                  ? cryptoTestProtection({
                      scope,
                      fault: failure === 'missing-key' ? failure : undefined,
                    })
                  : cryptoTestProtection({
                      scope: { resource: room.kind === 'doc' ? room.docId : 'unused' },
                    }),
            },
          }),
        }),
        cursor
      );
      const result = await tb.syncDoc('doc-a', b);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          payloadProtectionReason:
            failure === 'missing-key' ? 'missing_read_key' : 'decrypt_failed',
          retryable: false,
        });
        expect(result.error?.message).not.toContain('synthetic');
      }
      expect(b.toJSON()).toEqual({ data: { value: 1 } });
      expect(await cursor.load(url)).toEqual(checkpoint);
      const restored = await openTab(`v0-fault-r-${sequence}` as WorkspaceId);
      expect((await restored.repo.openPersistedDoc('doc-a')).doc.toJSON()).toEqual(b.toJSON());
      const otherWriter = (await writer.repo.openPersistedDoc('doc-b')).doc;
      const otherReader = (await reader.repo.openPersistedDoc('doc-b')).doc;
      otherWriter.getMap('data').set('unaffected', true);
      otherWriter.commit();
      expect((await ta.syncDoc('doc-b', otherWriter)).ok).toBe(true);
      expect((await tb.syncDoc('doc-b', otherReader)).ok).toBe(true);
      expect(otherReader.toJSON()).toEqual({ data: { unaffected: true } });
    }
  );

  it.each(['valid', 'signature', 'tag', 'position', 'missing-key', 'empty'] as const)(
    'verifies the signed v0 snapshot before decompress/import/save (%s)',
    async (fault) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const server = createByteServer();
      const writer = await openTab(`v0-snapshot-w-${++sequence}` as WorkspaceId);
      const doc = (await writer.repo.openPersistedDoc('doc-a')).doc;
      const content = protectedContent({
        resolve: () => ({
          mode: 'protected',
          config: {
            provider: cryptoTestProtection({
              fault: fault === 'signature' || fault === 'tag' ? fault : undefined,
              snapshotOnly: true,
            }),
          },
        }),
        snapshotUpload: { canUpload: () => true, debounceMs: 10, minBytesSinceRemoteSnapshot: 0 },
      });
      const subscription = transportFor(writer, content).joinDocRoom('doc-a', doc);
      await settle(subscription.firstSyncedWithRemote);
      doc.getMap('data').set('snapshot', 'verified before decompression');
      doc.commit();
      await settle(subscription.waitUntilSynced());
      await vi.advanceTimersByTimeAsync(10);
      await server.snapshotReady;
      const url = docUrl(writer.workspaceId, 'doc-a');
      const snapshot = server.room(new URL(url).pathname).snapshot;
      expect(snapshot).toBeDefined();
      // Published host helper reconstructs identical room AAD. This verifies
      // signatures only; the byte server does not implement host admission.
      const hostBinding = encodeStreamsRoomAdditionalData(
        'trusted-workspace-identity',
        { kind: 'doc', docId: 'doc-a' },
        Uint8Array.from(
          Buffer.concat([
            Buffer.from('loro-streams-crdt-payload-protection/v2\0'),
            snapshot!.body.slice(0, 11),
          ])
        )
      );
      expect(
        Result.isSuccess(
          verifyContentSignature(
            snapshot!.body.slice(11),
            { ...syntheticScope, purpose: 'doc-snapshot' },
            syntheticSigner,
            hostBinding
          )
        )
      ).toBe(fault !== 'signature');
      // Provider field stays [4]; the continuation follows the signer inside
      // the signed/AEAD-bound content frame, not the encrypted plaintext.
      expect([snapshot!.body[10], snapshot!.body[11]]).toEqual([4, 0]);
      expect(
        Result.getOrThrow(inspectContentFrame(snapshot!.body.slice(11), 'doc-snapshot'))
          .continuationOffset
      ).toBe(snapshot!.offset);
      const snapshotState = doc.toJSON();
      if (fault !== 'empty') {
        doc.getMap('data').set('suffix', 'after snapshot');
        doc.commit();
        await settle(subscription.waitUntilSynced());
      }
      if (fault === 'position') snapshot!.offset = server.offset(Number(snapshot!.offset) + 1);
      if (fault === 'empty') snapshot!.body = new Uint8Array();
      subscription.unsubscribe();
      const readerId = `v0-snapshot-r-${sequence}` as WorkspaceId;
      const reader = await openTab(readerId);
      reader.workspaceId = writer.workspaceId;
      const restored = (await reader.repo.openPersistedDoc('doc-a')).doc;
      const cursor = createResilientRemoteCursorStore({ dbName: reader.cursorDbName });
      const decompressed: Uint8Array[] = [];
      const readerContent = protectedContent({
        resolve: () => ({
          mode: 'protected',
          config: {
            provider: cryptoTestProtection({
              fault: fault === 'missing-key' ? 'missing-key' : undefined,
              snapshotOnly: true,
            }),
          },
        }),
        snapshotCodec: {
          compress: streamsSnapshotCodec.compress,
          async decompress(bytes) {
            const decoded = await streamsSnapshotCodec.decompress(bytes);
            decompressed.push(decoded);
            return decoded;
          },
        },
      });
      const readerTransport = transportFor(reader, readerContent, {
        load: (key) => cursor.load(key),
        async save(value) {
          const disk = await openTab(readerId);
          expect((await disk.repo.openPersistedDoc('doc-a')).doc.toJSON()).toEqual(
            restored.toJSON()
          );
          await cursor.save(value);
        },
      });
      const result = await settle(readerTransport.syncDoc('doc-a', restored));
      expect(result.ok).toBe(true);
      expect(decompressed).toHaveLength(fault === 'valid' ? 1 : 0);
      if (fault === 'valid') {
        const checked = new LoroDoc();
        checked.import(decompressed[0]!);
        expect(checked.toJSON()).toEqual(snapshotState);
        checked.free();
      }
      expect(restored.toJSON()).toEqual(doc.toJSON());
      expect((await cursor.load(url))?.nextOffset).toBe(server.tail(new URL(url).pathname));
    }
  );

  it.each(['corrupted', 'empty'] as const)(
    'rejects a trimmed unreadable encrypted snapshot (%s) without snapshot-repair polling',
    async (outcome) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const server = createByteServer();
      const writer = await openTab(`trimmed-w-${++sequence}` as WorkspaceId);
      const doc = (await writer.repo.openPersistedDoc('doc-a')).doc;
      const writerContent = cryptoContent();
      if (writerContent.mode !== 'protected') throw new Error('expected protected content');
      writerContent.snapshotUpload = {
        canUpload: () => true,
        debounceMs: 10,
        minBytesSinceRemoteSnapshot: 0,
      };
      const sourceTransport = transportFor(writer, writerContent);
      const source = sourceTransport.joinDocRoom('doc-a', doc);
      await settle(source.firstSyncedWithRemote);
      doc.getMap('data').set('value', 'complete source');
      doc.commit();
      await settle(source.waitUntilSynced());
      await vi.advanceTimersByTimeAsync(10);
      await settle(server.snapshotReady);
      const url = docUrl(writer.workspaceId, 'doc-a');
      const stored = server.room(new URL(url).pathname);
      if (outcome === 'empty') stored.snapshot!.body = new Uint8Array();
      else stored.snapshot!.body[stored.snapshot!.body.length - 1] ^= 1;
      stored.trimmed = true;

      const reader = await openTab(`trimmed-r-${sequence}` as WorkspaceId);
      reader.workspaceId = writer.workspaceId;
      const restored = (await reader.repo.openPersistedDoc('doc-a')).doc;
      const cursor = createResilientRemoteCursorStore({
        dbName: reader.cursorDbName,
        timeoutMs: 0,
      });
      const readerTransport = transportFor(reader, cryptoContent(), cursor);
      const syncResult = await settle(readerTransport.syncDoc('doc-a', restored));
      expect(syncResult.ok).toBe(false);
      if (!syncResult.ok) {
        expect(syncResult.error?.message).toContain('protocol_error');
      }
      expect(restored.toJSON()).toEqual({});
      expect(await cursor.load(url)).toBeNull();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(
        server.requests.some((request) => request.url.pathname.endsWith(':snapshot-repair'))
      ).toBe(false);
      source.unsubscribe();
    }
  );

  it('uploads a snapshot after alternating foreign writes once maxBytesSinceRemoteSnapshot is reached', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = createByteServer();
    const writer = await openTab(`max-bytes-w-${++sequence}` as WorkspaceId);
    const doc = (await writer.repo.openPersistedDoc('doc-a')).doc;
    const writerContent = cryptoContent();
    if (writerContent.mode !== 'protected') throw new Error('expected protected content');
    writerContent.snapshotUpload = {
      canUpload: () => true,
      debounceMs: 10,
      minBytesSinceRemoteSnapshot: 200,
      maxBytesSinceRemoteSnapshot: 2_000,
    };
    const sourceTransport = transportFor(writer, writerContent);
    const source = sourceTransport.joinDocRoom('doc-a', doc);
    await settle(source.firstSyncedWithRemote);

    const url = docUrl(writer.workspaceId, 'doc-a');
    const path = new URL(url).pathname;
    const stored = server.room(path);

    // 1. Local write above minBytes (200) but below maxBytes (2000), followed by a foreign writer.
    doc.getMap('data').set('local-1', 'a'.repeat(400));
    doc.commit();
    await settle(source.waitUntilSynced());

    const peer = await openTab(`max-bytes-peer-${sequence}` as WorkspaceId);
    peer.workspaceId = writer.workspaceId;
    const peerDoc = (await peer.repo.openPersistedDoc('doc-a')).doc;
    const peerTransport = transportFor(peer, cryptoContent());
    expect((await settle(peerTransport.syncDoc('doc-a', peerDoc))).ok).toBe(true);
    peerDoc.getMap('data').set('foreign', 'competing writer');
    peerDoc.commit();
    expect((await settle(peerTransport.syncDoc('doc-a', peerDoc))).ok).toBe(true);

    const arrived = Promise.withResolvers<void>();
    const unsubscribe = doc.subscribe(() => {
      if (doc.getMap('data').get('foreign') === 'competing writer') arrived.resolve();
    });
    try {
      server.live
        .get(path)!
        .enqueue(
          new TextEncoder().encode(
            `event: data\ndata: ${Buffer.from(stored.batches.at(-1)!).toString('base64')}\n\nevent: control\ndata: ${JSON.stringify({ streamNextOffset: server.tail(path), upToDate: true })}\n\n`
          )
        );
      await settle(arrived.promise);
      await settle(source.waitUntilSynced());
    } finally {
      unsubscribe();
    }

    expect(Number(server.tail(path))).toBeGreaterThan(200);
    expect(Number(server.tail(path))).toBeLessThan(2_000);
    await vi.advanceTimersByTimeAsync(20);
    // Below maxBytesSinceRemoteSnapshot, observedForeignWriter suppresses snapshot upload.
    expect(stored.snapshot).toBeUndefined();

    // 2. Subsequent local writes push stream byte delta past maxBytesSinceRemoteSnapshot (2000).
    doc.getMap('data').set('local-2', 'b'.repeat(2_200));
    doc.commit();
    await settle(source.waitUntilSynced());
    expect(Number(server.tail(path))).toBeGreaterThanOrEqual(2_000);
    await vi.advanceTimersByTimeAsync(20);
    await settle(server.snapshotReady);
    expect(stored.snapshot).toBeDefined();
    expect(stored.snapshot!.offset).toBe(server.tail(path));

    const reader = await openTab(`max-bytes-r-${sequence}` as WorkspaceId);
    reader.workspaceId = writer.workspaceId;
    const restored = (await reader.repo.openPersistedDoc('doc-a')).doc;
    expect(
      (await settle(transportFor(reader, cryptoContent()).syncDoc('doc-a', restored))).ok
    ).toBe(true);
    expect(restored.toJSON()).toEqual(doc.toJSON());
    source.unsubscribe();
  });

  it('does not upload when the real AEAD cannot obtain secure randomness', async () => {
    const server = createByteServer();
    const tab = await openTab(`v0-random-${++sequence}` as WorkspaceId);
    const doc = (await tab.repo.openPersistedDoc('doc-a')).doc;
    doc.getMap('data').set('draft', 'retained');
    doc.commit();
    const nativeCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        if (bytes.byteLength === 24) throw new Error('synthetic private random failure');
        return nativeCrypto.getRandomValues(bytes);
      },
    });
    const result = await transportFor(tab, cryptoContent())
      .syncDoc('doc-a', doc)
      .finally(() => vi.stubGlobal('crypto', nativeCrypto));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({ payloadProtectionReason: 'encrypt_failed' });
    expect(
      server.requests.filter((request) => request.method === 'POST' || request.method === 'PUT')
    ).toEqual([]);
    expect(doc.toJSON()).toEqual({ data: { draft: 'retained' } });
  });
});

describe('workspace Flock snapshot catch-up selection', () => {
  it.each(
    (['meta', 'mf', 'wf', 'sr'] as const).flatMap((kind) =>
      (['plaintext', 'protected'] as const).flatMap((mode) =>
        (
          [
            'small-snapshot',
            'large-snapshot',
            'local-draft',
            'edit-during-probe',
            'edit-during-bootstrap',
          ] as const
        ).map((scenario) => ({
          kind,
          mode,
          scenario,
        }))
      )
    )
  )(
    '$kind / $mode / $scenario preserves content and replica checkpoints',
    async ({ kind, mode, scenario }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let writeDuringProbe = () => {};
      let writeDuringBootstrap = () => {};
      const server = createByteServer((url, method) => {
        if (method === 'GET' && url.pathname.includes('/snapshot/')) writeDuringProbe();
        if (url.pathname.endsWith('/bootstrap')) writeDuringBootstrap();
        return scenario === 'large-snapshot' &&
          method === 'GET' &&
          url.pathname.includes('/snapshot/')
          ? new Response(null, { headers: { 'Content-Length': String(20 * 1024 * 1024) } })
          : undefined;
      });
      const writer = await openTab(`catchup-w-${++sequence}` as WorkspaceId);
      const reader = await openTab(`catchup-r-${sequence}` as WorkspaceId);
      reader.workspaceId = writer.workspaceId;
      const id =
        kind === 'mf'
          ? `${writer.workspaceId}:mf:machine`
          : kind === 'wf'
            ? `${writer.workspaceId}:wf:workspace`
            : `${writer.workspaceId}:sr`;
      const local =
        kind === 'meta' ? writer.repo.getMeta() : (await writer.repo.openFlockDoc(id)).flock;
      const remote =
        kind === 'meta' ? reader.repo.getMeta() : (await reader.repo.openFlockDoc(id)).flock;
      const content: WorkspaceStreamsContent =
        mode === 'protected'
          ? protectedContent({
              snapshotUpload: {
                canUpload: () => true,
                debounceMs: 10,
                minBytesSinceRemoteSnapshot: 0,
              },
            })
          : { mode: 'plaintext' };
      const source = transportFor(writer, content);
      const joined =
        kind === 'meta' ? source.joinMetaRoom(local) : source.joinFlockDocRoom(id, local);
      await settle(joined.firstSyncedWithRemote);
      local.put(['value'], 'baseline');
      await settle(joined.waitUntilSynced());
      const oldReader = transportFor(
        reader,
        mode === 'protected' ? protectedContent() : { mode: 'plaintext' }
      );
      expect(
        (
          await settle(
            kind === 'meta' ? oldReader.syncMeta(remote) : oldReader.syncFlockDoc(id, remote)
          )
        ).ok
      ).toBe(true);
      await settle(oldReader.close());
      openTransports.delete(oldReader);
      // Repeated overwrites make stream history large while current state stays small.
      for (let i = 0; i < 4; i++) {
        local.put(['value'], `${i}:${'x'.repeat(600_000)}`);
        await settle(joined.waitUntilSynced());
      }
      local.put(['value'], 'latest');
      await settle(joined.waitUntilSynced());
      const url =
        kind === 'meta'
          ? getWorkspaceMetaStreamUrl(writer.workspaceId, streamsBaseUrl)
          : `${streamsBaseUrl}/ds/${LORO_STREAMS_BUCKET_ID}/${encodeURIComponent(id)}`;
      const path = new URL(url).pathname;
      if (mode === 'protected') {
        await vi.advanceTimersByTimeAsync(10);
        await settle(server.snapshotReady);
      } else {
        server.room(path).snapshot = {
          offset: server.tail(path),
          body: await streamsSnapshotCodec.compress(local.exportFile()),
        };
      }
      if (scenario === 'local-draft') remote.put(['draft'], 'unsent');
      if (scenario === 'edit-during-probe')
        writeDuringProbe = () => {
          remote.put(['draft'], 'unsent');
        };
      if (scenario === 'edit-during-bootstrap')
        writeDuringBootstrap = () => {
          remote.put(['draft'], 'unsent');
        };
      const start = server.requests.length;
      const resumed = transportFor(
        reader,
        mode === 'protected' ? protectedContent() : { mode: 'plaintext' }
      );
      expect(
        (
          await settle(
            kind === 'meta' ? resumed.syncMeta(remote) : resumed.syncFlockDoc(id, remote)
          )
        ).ok
      ).toBe(true);
      expect(remote.get(['value'])).toBe('latest');
      const requests = server.requests.slice(start);
      expect(requests.some(({ url }) => url.pathname.endsWith('/bootstrap'))).toBe(
        scenario === 'small-snapshot' || scenario === 'edit-during-bootstrap'
      );
      if (
        scenario === 'local-draft' ||
        scenario === 'edit-during-probe' ||
        scenario === 'edit-during-bootstrap'
      ) {
        expect(remote.get(['draft'])).toBe('unsent');
        const verifier = await openTab(`catchup-v-${sequence}` as WorkspaceId);
        verifier.workspaceId = writer.workspaceId;
        const check =
          kind === 'meta' ? verifier.repo.getMeta() : (await verifier.repo.openFlockDoc(id)).flock;
        const verification = transportFor(
          verifier,
          mode === 'protected' ? protectedContent() : { mode: 'plaintext' }
        );
        expect(
          (
            await settle(
              kind === 'meta' ? verification.syncMeta(check) : verification.syncFlockDoc(id, check)
            )
          ).ok
        ).toBe(true);
        expect(check.get(['draft'])).toBe('unsent');
      }
      const checkpoint = await reader.repo
        .getReplicaCheckpointStore(
          kind === 'meta'
            ? { kind: 'meta', flock: remote }
            : { kind: 'flock', flockDocId: id, flock: remote }
        )
        .load(url);
      expect(checkpoint?.nextOffset).toBe(server.tail(path));
      joined.unsubscribe();
    }
  );
});

describe('named Flock initial catch-up timeout recovery', () => {
  it.each(
    ['mf:machine', 'wf:workspace', 'sr'].flatMap((suffix) =>
      ['plaintext', 'protected'].map((mode) => ({ suffix, mode }))
    )
  )(
    'recovers $suffix / $mode independently and uploads offline writes',
    async ({ suffix, mode }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const server = createByteServer();
      const writer = await openTab(`timeout-w-${++sequence}` as WorkspaceId);
      const reader = await openTab(`timeout-r-${sequence}` as WorkspaceId);
      reader.workspaceId = writer.workspaceId;
      const id = `${writer.workspaceId}:${suffix}`;
      const a = (await writer.repo.openFlockDoc(id)).flock;
      const b = (await reader.repo.openFlockDoc(id)).flock;
      const content =
        mode === 'protected'
          ? protectedContent({
              snapshotUpload: {
                canUpload: () => true,
                debounceMs: 10,
                minBytesSinceRemoteSnapshot: 0,
              },
            })
          : { mode: 'plaintext' as const };
      const readContent =
        mode === 'protected' ? protectedContent() : { mode: 'plaintext' as const };
      const source = transportFor(writer, content).joinFlockDocRoom(id, a);
      await settle(source.firstSyncedWithRemote);
      a.put(['remote'], 'baseline');
      await settle(source.waitUntilSynced());
      const old = transportFor(reader, readContent);
      expect((await settle(old.syncFlockDoc(id, b))).ok).toBe(true);
      await settle(old.close());
      openTransports.delete(old);
      a.put(['remote'], 'latest');
      await settle(source.waitUntilSynced());
      const path = `/ds/${LORO_STREAMS_BUCKET_ID}/${encodeURIComponent(id)}`;
      if (mode === 'protected') {
        await vi.advanceTimersByTimeAsync(10);
        await settle(server.snapshotReady);
      } else {
        server.room(path).snapshot = {
          offset: server.tail(path),
          body: await streamsSnapshotCodec.compress(a.exportFile()),
        };
      }
      b.put(['draft'], 'retained offline');
      const originalFetch = globalThis.fetch;
      const reading = Promise.withResolvers<void>();
      let stall = true;
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (stall && url.pathname === path && (init?.method ?? 'GET') === 'GET') {
          reading.resolve();
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
              once: true,
            });
          });
        }
        return originalFetch(input, init);
      });
      const recovery = transportFor(reader, readContent);
      const subscription = recovery.joinFlockDocRoom(id, b);
      const failed = subscription.firstSyncedWithRemote.catch((error: unknown) => error);
      await settle(reading.promise);
      await vi.advanceTimersByTimeAsync(240_000);
      expect(await settle(failed)).toMatchObject({ streamsCode: 'initial_sync_timeout' });
      stall = false;
      await settle(subscription.rejoin!());
      await settle(subscription.firstSyncedWithRemote);
      expect(b.get(['remote'])).toBe('latest');
      expect(b.get(['draft'])).toBe('retained offline');
      expect(server.requests.some(({ url }) => url.pathname === `${path}/bootstrap`)).toBe(true);
      const verifier = await openTab(`timeout-v-${sequence}` as WorkspaceId);
      verifier.workspaceId = writer.workspaceId;
      const c = (await verifier.repo.openFlockDoc(id)).flock;
      expect((await settle(transportFor(verifier, readContent).syncFlockDoc(id, c))).ok).toBe(true);
      expect(c.get(['draft'])).toBe('retained offline');
      subscription.unsubscribe();
      source.unsubscribe();
    }
  );
});
