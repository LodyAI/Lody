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
  const repo = await LoroRepo.create({
    storageAdapter: storage,
    metaDebounceCommitMs: 0,
    metaPersistDebounceMs: 60_000,
    docPersistDebounceMs: 60_000,
    metaCompactionByteThreshold: 0,
    flockDocCompactionByteThreshold: 0,
  });
  repos.push(repo);
  return repo;
}

describe('renderer Streams replica persistence', () => {
  it.each(['meta', 'named'] as const)(
    'persists a same-vector %s tombstone so replaying older data cannot resurrect it',
    async (kind) => {
      const repo = await open('tombstone');
      const load = async (owner: LoroRepo) =>
        kind === 'meta' ? owner.getMeta() : (await owner.openFlockDoc('named')).flock;
      const flock = await load(repo);
      const stale = {
        version: 0,
        entries: { '["A"]': { d: 'old', c: '1699999999999,0,aa' } },
      };
      flock.importJson(stale);
      flock.importJson(record('B', 2));
      await repo.flush();
      const before = flock.version();
      flock.importJson({ version: 0, entries: { '["A"]': { c: '1700000000000,1,aa' } } });
      expect(flock.version()).toEqual(before);
      if (kind === 'meta') await repo.persistMetaNow();
      else await repo.persistFlockDocNow('named', flock);
      const recovered = await load(await open('tombstone'));
      recovered.importJson(stale);
      expect(recovered.get(['A'])).toBeUndefined();
      expect(recovered.get(['B'])).toBe('B');
    }
  );

  it('keeps unloaded checkpoints recoverable but invalidates purged generations across live replicas', async () => {
    const first = await open('lifecycle');
    const original = (await first.openFlockDoc('named')).flock;
    original.importJson(record('A', 1));
    await first.persistFlockDocNow('named', original);
    const originalStore = first.getReplicaCheckpointStore({
      kind: 'flock',
      flockDocId: 'named',
      flock: original,
    });
    await originalStore.save(cursor);
    await first.unloadFlockDoc('named');
    await expect(originalStore.load(cursor.streamUrl)).rejects.toThrow();
    const reloaded = (await first.openFlockDoc('named')).flock;
    expect(reloaded).not.toBe(original);
    expect(reloaded.get(['A'])).toBe('A');
    expect(
      await first
        .getReplicaCheckpointStore({
          kind: 'flock',
          flockDocId: 'named',
          flock: reloaded,
        })
        .load(cursor.streamUrl)
    ).toEqual(cursor);

    const concurrent = await open('lifecycle');
    const concurrentFlock = (await concurrent.openFlockDoc('named')).flock;
    const concurrentStore = concurrent.getReplicaCheckpointStore({
      kind: 'flock',
      flockDocId: 'named',
      flock: concurrentFlock,
    });
    await first.purgeFlockDoc('named');
    await expect(concurrentStore.save({ ...cursor, nextOffset: '99' })).rejects.toThrow();
    const fresh = (await first.openFlockDoc('named')).flock;
    expect(fresh.get(['A'])).toBeUndefined();
    expect(
      await first
        .getReplicaCheckpointStore({
          kind: 'flock',
          flockDocId: 'named',
          flock: fresh,
        })
        .load(cursor.streamUrl)
    ).toBeNull();
  });

  it('retains both replicas data when an older checkpoint finishes last', async () => {
    const older = await open('overlap');
    const newer = await open('overlap');
    const oldStore = older.getReplicaCheckpointStore({ kind: 'meta', flock: older.getMeta() });
    const newStore = newer.getReplicaCheckpointStore({ kind: 'meta', flock: newer.getMeta() });
    older.getMeta().importJson(record('A', 1));
    await older.persistMetaNow();
    newer.getMeta().importJson(record('B', 2));
    await newer.persistMetaNow();
    await newStore.save({ ...cursor, nextOffset: '200' });
    expect(await oldStore.load(cursor.streamUrl)).toBeNull();
    await oldStore.save({ ...cursor, nextOffset: '100' });
    const recovered = await open('overlap');
    expect(recovered.getMeta().get(['A'])).toBe('A');
    expect(recovered.getMeta().get(['B'])).toBe('B');
    expect(
      (
        await recovered
          .getReplicaCheckpointStore({
            kind: 'meta',
            flock: recovered.getMeta(),
          })
          .load(cursor.streamUrl)
      )?.nextOffset
    ).toBe('100');
  });

  it.each(
    (['meta', 'named'] as const).flatMap((kind) =>
      (['none', 'data', 'checkpoint'] as const).map((failure) => ({ kind, failure }))
    )
  )(
    'recovers $kind through the published transport with $failure failure, without shutdown flush',
    async ({ kind, failure }) => {
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
      let rejectWrites = false;
      const transportFor = (repo: LoroRepo) => {
        const persistence = createRendererStreamsPersistence(repo, {
          shouldBypassMetaLoad: () => false,
        });
        return new StreamsTransportAdapter({
          baseUrl: 'https://checkpoint.invalid',
          bucketId: 'bucket',
          auth: 'synthetic-test',
          persistence: {
            ...persistence,
            cursorStoreFor: (target) => {
              const store = persistence.cursorStoreFor(target);
              return {
                ...store,
                save: (value) =>
                  rejectWrites && failure === 'checkpoint'
                    ? Promise.reject(new Error('checkpoint unavailable'))
                    : store.save(value),
              };
            },
          },
        });
      };
      const storage = new IndexedDBStorageAdaptor({ dbName: 'transport-migration' });
      const save = storage.save.bind(storage);
      storage.save = (payload) =>
        rejectWrites && failure === 'data'
          ? Promise.reject(new Error('data unavailable'))
          : save(payload);
      const first = await open('transport-migration', storage);
      const flock = await load(first);
      flock.importJson(record('B', 2));
      flock.importJson({
        version: 0,
        entries: { '["local"]': { d: 'unsent', c: '1700000000000,1,bb' } },
      });
      await first.flush();
      const initialVersion = flock.version();
      const sync = (transport: StreamsTransportAdapter, target: typeof flock) =>
        kind === 'meta'
          ? transport.syncMeta(target)
          : transport.syncFlockDoc('migration-named', target);
      const transport = transportFor(first);
      try {
        if (failure !== 'none') {
          rejectWrites = true;
          expect((await sync(transport, flock)).ok).toBe(false);
          const interrupted = await open('transport-migration');
          const interruptedFlock = await load(interrupted);
          expect(interruptedFlock.get(['local'])).toBe('unsent');
          expect(interruptedFlock.get(['A'])).toBe(failure === 'data' ? undefined : 'A');
          const target =
            kind === 'meta'
              ? ({ kind: 'meta', flock: interruptedFlock } as const)
              : ({
                  kind: 'flock',
                  flockDocId: 'migration-named',
                  flock: interruptedFlock,
                } as const);
          const streamUrl = `https://checkpoint.invalid/ds/bucket/${kind === 'meta' ? 'repo-meta' : 'flock%3Amigration-named'}`;
          expect(await interrupted.getReplicaCheckpointStore(target).load(streamUrl)).toBeNull();
          rejectWrites = false;
        }
        expect((await sync(transport, flock)).ok).toBe(true);
        expect(flock.version()).toEqual(initialVersion);
        expect(flock.get(['A'])).toBe('A');
        expect(flock.get(['local'])).toBe('unsent');
        expect(requests.some((url) => url.pathname.endsWith('/bootstrap'))).toBe(true);
      } finally {
        rejectWrites = false;
        await transport.close();
      }
      // No destroy/flush on the writer: recovery must rely on the sync barrier.
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
