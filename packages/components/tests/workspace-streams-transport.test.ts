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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import {
  createLoroStreamUrl,
  getLoroStreamIdForDocId,
  LORO_STREAMS_BUCKET_ID,
  streamsSnapshotCodec,
  type WorkspaceId,
} from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
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
async function openTab(workspaceId: WorkspaceId, storage?: IndexedDBStorageAdaptor): Promise<Tab> {
  const identity = resolveWorkspaceRuntimeCacheIdentity(workspaceId, '');
  const repo = await LoroRepo.create({
    storageAdapter: storage ?? new IndexedDBStorageAdaptor({ dbName: identity.repoDbName }),
    metaDebounceCommitMs: 0,
  });
  const tab = { repo, workspaceId, cursorDbName: identity.remoteCursorDbName };
  openTabs.add(tab);
  return tab;
}

async function syncMeta(tab: Tab) {
  const transport = createWorkspaceStreamsTransport({
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

afterEach(async () => {
  for (const transport of openTransports) await transport.close();
  openTransports.clear();
  for (const tab of openTabs) await tab.repo.destroy();
  openTabs.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('renderer Streams checkpoints are bound to the replica that loaded them', () => {
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

  it('bootstraps again after the runtime deletes the Meta checkpoint it recovers from', async () => {
    const workspaceId = `ws-recover-${++sequence}` as WorkspaceId;
    const server = createMetaServer();
    const tab = await openTab(workspaceId);
    expect((await syncMeta(tab)).ok).toBe(true);
    expect((await syncMeta(tab)).ok).toBe(true);
    expect(server.bootstraps()).toBe(1);

    // What invalidateMetaRemoteCursor / the startup bypass marker do.
    await tab.repo
      .getReplicaCheckpointStore({ kind: 'meta', flock: tab.repo.getMeta() })
      .delete?.(getWorkspaceMetaStreamUrl(workspaceId, streamsBaseUrl));

    expect((await syncMeta(tab)).ok).toBe(true);
    expect(server.bootstraps()).toBe(2);
  });
});

function transportFor(
  tab: Tab,
  content?: WorkspaceStreamsContent,
  cursorStore?: RemoteCursorStore
) {
  const transport = createWorkspaceStreamsTransport({
    repo: tab.repo,
    workspaceId: tab.workspaceId,
    documentRemoteCursorStore:
      cursorStore ?? createResilientRemoteCursorStore({ dbName: tab.cursorDbName }),
    auth: async () => 'streams-jwt',
    streamsBaseUrl,
    shardHostSuffix: undefined,
    content,
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
function createByteServer() {
  type Room = { batches: Uint8Array[]; snapshot?: { offset: string; body: Uint8Array } };
  const rooms = new Map<string, Room>();
  const requests: { url: URL; method: string; body: Uint8Array; auth: string | null }[] = [];
  const live = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const liveReady = Promise.withResolvers<void>();
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
      if (url.pathname.includes('/snapshot/'))
        value.snapshot = { offset: decodeURIComponent(url.pathname.split('/').at(-1)!), body };
      return new Response(null, { status: 204 });
    }
    if (method === 'HEAD')
      return new Response(null, {
        headers: {
          'Stream-Next-Offset': currentTail(),
          'Stream-Snapshot-Offset': value.snapshot?.offset ?? '-1',
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
  return { room, requests, live, liveReady: liveReady.promise, offset, tail };
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

  it('rejects an unprotected snapshot before import and keeps the cursor absent', async () => {
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
    expect(result.ok).toBe(false);
    expect(doc.toJSON()).toEqual({});
    expect(await cursor.load(url)).toBeNull();
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

  it('protects Meta and named Flock updates using their logical identities', async () => {
    const server = createByteServer();
    const workspaceId = `protected-flock-${++sequence}` as WorkspaceId;
    const a = await openTab(`${workspaceId}-a` as WorkspaceId);
    const b = await openTab(`${workspaceId}-b` as WorkspaceId);
    a.workspaceId = b.workspaceId = workspaceId;
    const identities: unknown[] = [];
    const content = protectedContent({
      resolve(room) {
        identities.push(room);
        return { mode: 'protected', config: { provider: testProtection() } };
      },
    });
    const ta = transportFor(a, content);
    const tb = transportFor(b, content);
    a.repo.getMeta().put(keyA, 'meta');
    expect((await ta.syncMeta(a.repo.getMeta())).ok).toBe(true);
    expect((await tb.syncMeta(b.repo.getMeta())).ok).toBe(true);
    expect(b.repo.getMeta().get(keyA)).toBe('meta');
    const fa = (await a.repo.openFlockDoc('catalog')).flock;
    const fb = (await b.repo.openFlockDoc('catalog')).flock;
    fa.put(['row'], 'named flock');
    expect((await ta.syncFlockDoc('catalog', fa)).ok).toBe(true);
    expect((await tb.syncFlockDoc('catalog', fb)).ok).toBe(true);
    expect(fb.get(['row'])).toBe('named flock');
    expect(identities).toEqual([
      { kind: 'meta' },
      { kind: 'meta' },
      { kind: 'flock', flockDocId: 'catalog' },
      { kind: 'flock', flockDocId: 'catalog' },
    ]);
    expect(server.room(`/ds/${LORO_STREAMS_BUCKET_ID}/catalog`).batches.length).toBeGreaterThan(0);
  });

  it('keeps a reader live through rejoin without local edits', async () => {
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
    a.getMap('data').set('value', 2);
    a.commit();
    expect((await ta.syncDoc('doc-a', a)).ok).toBe(true);
    const received = Promise.withResolvers<void>();
    const stopObserving = b.subscribe(() => {
      if (b.getMap('data').get('value') === 2) received.resolve();
    });
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
    await subscription.firstSyncedWithRemote;
    const path = new URL(docUrl(tab.workspaceId, 'doc-a')).pathname;
    for (const nextPermission of ['deny', 'throw', 'allow'] as const) {
      permission = nextPermission;
      doc.getMap('data').set('value', permission);
      doc.commit();
      await subscription.waitUntilSynced();
      await vi.advanceTimersByTimeAsync(10);
      if (permission !== 'allow') expect(server.room(path).snapshot).toBeUndefined();
    }
    const snapshot = server.room(path).snapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot!.body[0]).not.toBe(42);
    expect(snapshot!.offset).toBe(server.tail(path));
    const reader = await openTab(`snapshot-reader-${++sequence}` as WorkspaceId);
    reader.workspaceId = tab.workspaceId;
    const restored = (await reader.repo.openPersistedDoc('doc-a')).doc;
    expect((await transportFor(reader, content).syncDoc('doc-a', restored)).ok).toBe(true);
    expect(restored.toJSON()).toEqual({ data: { value: 'allow' } });
    subscription.unsubscribe();
  });

  it('publishes ordinary snapshots in the existing compressed Loro format', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = createByteServer();
    const tab = await openTab(`ordinary-upload-${++sequence}` as WorkspaceId);
    const doc = (await tab.repo.openPersistedDoc('doc-a')).doc;
    const subscription = transportFor(tab).joinDocRoom('doc-a', doc);
    await subscription.firstSyncedWithRemote;
    let seed = 123456;
    const text = Array.from({ length: 200_000 }, () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return String.fromCharCode(32 + ((seed >>> 0) % 95));
    }).join('');
    doc.getMap('data').set('text', text);
    doc.commit();
    await subscription.waitUntilSynced();
    const path = new URL(docUrl(tab.workspaceId, 'doc-a')).pathname;
    expect(Number(server.tail(path))).toBeGreaterThan(102400);
    await vi.advanceTimersByTimeAsync(10_000);
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
