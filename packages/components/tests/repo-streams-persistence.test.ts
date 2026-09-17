import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { LoroRepo, type StorageSavePayload } from 'loro-repo';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { StreamsTransportAdapter } from 'loro-repo/transport/streams';
import { InMemoryRemoteCursorStore } from '@loro-dev/streams-crdt';
import {
  createRendererStreamsPersistence,
  invalidateRendererMetaCheckpoint,
} from '../src/providers/repo-streams-persistence';

const cursor = {
  streamUrl: 'https://streams.invalid/meta',
  nextOffset: '42',
  serverLowerBoundVersion: {},
  updatedAtMs: 1,
};
const record = (key: string, clock: number) => ({
  version: 0,
  entries: {
    [JSON.stringify([key])]: { d: key, c: `1700000000000,${clock},aa` },
  },
});
const repos: LoroRepo[] = [];
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.destroy();
  vi.unstubAllGlobals();
});
async function open(dbName = 'migration', storage = new IndexedDBStorageAdaptor({ dbName })) {
  const repo = await LoroRepo.create({ storageAdapter: storage, metaDebounceCommitMs: 0 });
  repos.push(repo);
  return repo;
}

describe('renderer Streams replica persistence', () => {
  it.each(['meta', 'named'] as const)(
    'bootstraps %s through the published transport, merges local data, then resumes after restart',
    async (kind) => {
      const server = await open('remote');
      server.getMeta().importJson(record('A', 1));
      server.getMeta().importJson(record('B', 2));
      const snapshot = server.getMeta().exportFile();
      const requests: URL[] = [];
      const tail = '00000000000000000100';
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url);
        const headers = new Headers({
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': tail,
          'Stream-Up-To-Date': 'true',
        });
        if (init?.method === 'POST') {
          const sent = new Headers(init.headers);
          headers.set('Producer-Epoch', sent.get('Producer-Epoch') ?? '0');
          headers.set('Producer-Seq', sent.get('Producer-Seq') ?? '0');
          return new Response(null, { headers });
        }
        if (url.pathname.endsWith('/bootstrap')) {
          headers.set('Content-Type', 'multipart/mixed; boundary=checkpoint');
          headers.set('Stream-Snapshot-Offset', tail);
          return new Response(
            new Blob([
              '--checkpoint\r\nContent-Type: application/octet-stream\r\n\r\n',
              snapshot.slice().buffer as ArrayBuffer,
              '\r\n--checkpoint--\r\n',
            ]),
            { headers }
          );
        }
        return new Response(null, { headers });
      });
      const load = async (repo: LoroRepo) =>
        kind === 'meta' ? repo.getMeta() : (await repo.openFlockDoc('migration-named')).flock;
      const transportFor = (repo: LoroRepo) =>
        new StreamsTransportAdapter({
          baseUrl: 'https://checkpoint.invalid',
          bucketId: 'bucket',
          auth: 'synthetic-test',
          persistence: createRendererStreamsPersistence(repo, {
            shouldBypassMetaLoad: () => false,
          }),
        });
      const first = await open('transport-migration');
      const flock = await load(first);
      flock.importJson(record('B', 2));
      flock.importJson({
        version: 0,
        entries: { '["local"]': { d: 'unsent', c: '1700000000000,1,bb' } },
      });
      const initialVersion = flock.version();
      const sync = (transport: StreamsTransportAdapter, target: typeof flock) =>
        kind === 'meta'
          ? transport.syncMeta(target)
          : transport.syncFlockDoc('migration-named', target);
      const transport = transportFor(first);
      try {
        expect((await sync(transport, flock)).ok).toBe(true);
        expect(flock.version()).toEqual(initialVersion);
        expect(flock.get(['A'])).toBe('A');
        expect(flock.get(['local'])).toBe('unsent');
        expect(requests.some((url) => url.pathname.endsWith('/bootstrap'))).toBe(true);
      } finally {
        await transport.close();
      }
      await first.destroy();
      repos.splice(repos.indexOf(first), 1);
      const restarted = await open('transport-migration');
      const restored = await load(restarted);
      expect(restored.get(['A'])).toBe('A');
      expect(restored.get(['B'])).toBe('B');
      expect(restored.get(['local'])).toBe('unsent');
      requests.length = 0;
      const next = transportFor(restarted);
      try {
        expect((await sync(next, restored)).ok).toBe(true);
        expect(requests.some((url) => url.pathname.endsWith('/bootstrap'))).toBe(false);
        expect(requests.some((url) => url.searchParams.get('offset') === tail)).toBe(true);
      } finally {
        await next.close();
      }
    }
  );

  it('ignores legacy Flock progress, preserves local data, and durably repairs a same-vector hole', async () => {
    // Actual v3 schema: no replica-checkpoints store. All fixture data is synthetic.
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('migration', 3);
      request.onupgradeneeded = () => {
        for (const name of [
          'docs',
          'doc-updates',
          'flock-docs',
          'flock-doc-updates',
          'meta',
          'meta-updates',
        ])
          request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction('meta-updates', 'readwrite');
      tx.objectStore('meta-updates').put(
        new TextEncoder().encode(JSON.stringify(record('B', 2))),
        'update:legacy'
      );
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    legacy.close();
    const oldCursors = new InMemoryRemoteCursorStore();
    await oldCursors.save(cursor);
    const repo = await open();
    const flock = repo.getMeta();
    const persistence = createRendererStreamsPersistence(repo, {
      documentRemoteCursorStore: oldCursors,
      shouldBypassMetaLoad: () => false,
    });
    const store = persistence.cursorStoreFor({ kind: 'meta', flock });
    expect(await store.load(cursor.streamUrl)).toBeNull();
    expect(await persistence.documentRemoteCursorStore.load(cursor.streamUrl)).toEqual(cursor);
    const before = flock.version();
    flock.importJson(record('A', 1));
    flock.commit();
    expect(flock.version()).toEqual(before);
    await persistence.persistMeta!(flock);
    await store.save(cursor);
    const reopened = await open();
    expect(reopened.getMeta().get(['A'])).toBe('A');
    expect(reopened.getMeta().get(['B'])).toBe('B');
    expect(
      await reopened
        .getReplicaCheckpointStore({ kind: 'meta', flock: reopened.getMeta() })
        .load(cursor.streamUrl)
    ).toEqual(cursor);
  });

  it('does not borrow progress from another already-loaded replica and bypasses the actual Meta checkpoint', async () => {
    const first = await open();
    const second = await open();
    let bypass = false;
    const a = createRendererStreamsPersistence(first, { shouldBypassMetaLoad: () => bypass });
    const b = createRendererStreamsPersistence(second, { shouldBypassMetaLoad: () => false });
    const firstStore = a.cursorStoreFor({ kind: 'meta', flock: first.getMeta() });
    first.getMeta().importJson(record('A', 1));
    await a.persistMeta!(first.getMeta());
    await firstStore.save(cursor);
    expect(
      await b.cursorStoreFor({ kind: 'meta', flock: second.getMeta() }).load(cursor.streamUrl)
    ).toBeNull();
    expect(second.getMeta().get(['A'])).toBeUndefined();
    bypass = true;
    expect(await firstStore.load(cursor.streamUrl)).toBeNull();
    await invalidateRendererMetaCheckpoint(first, cursor.streamUrl);
    bypass = false;
    expect(await firstStore.load(cursor.streamUrl)).toBeNull();
  });

  it('rejects a failed durability barrier and retains the data for retry', async () => {
    const storage = new IndexedDBStorageAdaptor({ dbName: 'failure' });
    const save = storage.save.bind(storage);
    let fail = true;
    storage.save = (payload: StorageSavePayload) =>
      fail ? Promise.reject(new Error('disk full')) : save(payload);
    const repo = await open('failure', storage);
    const persistence = createRendererStreamsPersistence(repo, {
      shouldBypassMetaLoad: () => false,
    });
    repo.getMeta().importJson(record('A', 1));
    await expect(persistence.persistMeta!(repo.getMeta())).rejects.toThrow();
    fail = false;
    await persistence.persistMeta!(repo.getMeta());
    const reopened = await open('failure');
    expect(reopened.getMeta().get(['A'])).toBe('A');
  });
});
