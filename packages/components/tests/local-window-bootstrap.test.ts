import {
  createWorkspaceStreamsTransport,
  getWorkspaceDocStreamUrl,
} from '../src/providers/workspace-streams-transport';
import type { WorkspaceId } from '@lody/shared';
import { ResilientRemoteCursorStore } from '../src/providers/resilient-remote-cursor-store';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { adoptEagerSyncCheckpoint } from '../src/providers/eager-sync-checkpoint';
import type { EagerSyncSnapshot } from '../src/providers/eager-sync-snapshot-cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo, type StorageAdapter } from 'loro-repo';
import { LoroDoc } from 'loro-crdt';
import {
  createLocalWindowBootstrap,
  createSessionSnapshotLoader,
} from '../src/providers/local-window-bootstrap';

function channelFactory() {
  const channels = new Set<{ name: string; onmessage: BroadcastChannel['onmessage'] }>();
  const registry = new Map<string, Set<string>>();
  const createRegistry = (scope: string, id: string) => {
    const peers = registry.get(scope) ?? new Set<string>();
    registry.set(scope, peers);
    peers.add(id);
    return {
      peers: async () => [...peers].filter((peer) => peer !== id),
      close: () => {
        peers.delete(id);
      },
    };
  };
  const createChannel = (name: string) => {
    const channel = {
      name,
      onmessage: null as BroadcastChannel['onmessage'],
      postMessage(data: unknown) {
        for (const peer of channels) {
          if (peer !== channel && peer.name === name) {
            peer.onmessage?.call(
              peer as BroadcastChannel,
              { data: structuredClone(data) } as MessageEvent
            );
          }
        }
      },
      close() {
        channels.delete(channel);
      },
    };
    channels.add(channel);
    return channel;
  };
  return { createChannel, createRegistry };
}

afterEach(() => vi.useRealTimers());

describe('local window bootstrap', () => {
  it('reuses metadata and loaded history while merging independent edits', async () => {
    vi.useFakeTimers();
    const { createChannel, createRegistry } = channelFactory();
    const source = await LoroRepo.create({});
    const target = await LoroRepo.create({});
    const doc = new LoroDoc();
    doc.getText('history').insert(0, 'already loaded');
    doc.commit();
    await source.upsertDocMeta('session:test', { title: 'Existing conversation' });
    const owner = createLocalWindowBootstrap(
      source,
      'workspace',
      new Map([['session:test', doc]]),
      createChannel,
      createRegistry
    );
    const projected = new Promise<void>((resolve) => {
      const watch = target.watch((event) => {
        if (event.kind === 'doc-metadata') {
          watch.unsubscribe();
          resolve();
        }
      });
    });
    const empty = createLocalWindowBootstrap(
      target,
      'workspace',
      new Map(),
      createChannel,
      createRegistry
    );
    const receiver = createLocalWindowBootstrap(
      target,
      'workspace',
      new Map(),
      createChannel,
      createRegistry
    );
    await projected;
    expect((await target.getDocMeta('session:test'))?.meta).toMatchObject({
      title: 'Existing conversation',
    });
    const snapshot = await receiver.readDocument('session:test');
    const local = new LoroDoc();
    local.getMap('draft').set('text', 'unsent edit');
    local.commit();
    local.import(snapshot!);
    expect(local.getText('history').toString()).toBe('already loaded');
    expect(local.getMap('draft').get('text')).toBe('unsent edit');
    owner.close();
    empty.close();
    receiver.close();
    await source.destroy();
    await target.destroy();
  });

  it('isolates workspaces and resolves misses and pending requests on close', async () => {
    vi.useFakeTimers();
    const { createChannel, createRegistry } = channelFactory();
    const repo = await LoroRepo.create({});
    const doc = new LoroDoc();
    doc.getText('history').insert(0, 'private');
    doc.commit();
    const owner = createLocalWindowBootstrap(
      repo,
      'one',
      new Map([['session:test', doc]]),
      createChannel,
      createRegistry
    );
    const receiver = createLocalWindowBootstrap(
      repo,
      'two',
      new Map(),
      createChannel,
      createRegistry
    );
    const missing = receiver.readDocument('session:test');
    expect(await missing).toBeUndefined();
    const pending = receiver.readDocument('session:test');
    receiver.close();
    expect(await pending).toBeUndefined();
    expect(await receiver.readDocument('session:test')).toBeUndefined();
    owner.close();
    await repo.destroy();
  });
});

describe('session snapshot adoption', () => {
  function storageFixture() {
    const snapshots = new Map<string, Uint8Array>();
    let rejectNextSave = false;
    const storage: StorageAdapter = {
      loadMeta: async () => undefined,
      loadDoc: async (room) => {
        const snapshot = snapshots.get(room);
        return snapshot ? LoroDoc.fromSnapshot(snapshot) : undefined;
      },
      save: async (payload) => {
        if (payload.type !== 'doc-snapshot' && payload.type !== 'doc-update') return;
        if (rejectNextSave) {
          rejectNextSave = false;
          throw new Error('disk unavailable');
        }
        const previous = snapshots.get(payload.docId);
        const doc = previous ? LoroDoc.fromSnapshot(previous) : new LoroDoc();
        doc.import(payload.type === 'doc-snapshot' ? payload.snapshot : payload.update);
        snapshots.set(payload.docId, doc.export({ mode: 'snapshot' }));
      },
    };
    return {
      storage,
      snapshots,
      failNextSave: () => {
        rejectNextSave = true;
      },
    };
  }
  function remoteSnapshot() {
    const doc = new LoroDoc();
    doc.getMap('fields').set('remote', 'peer');
    return doc.export({ mode: 'snapshot' });
  }

  it('adopts a durable cold snapshot and retains later local edits after reopening', async () => {
    const { storage, snapshots } = storageFixture();
    const open = createSessionSnapshotLoader(storage);
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const { doc } = await open(repo, 'session-one', async () => remoteSnapshot());
    expect(doc.toJSON()).toEqual({ fields: { remote: 'peer' } });
    expect(LoroDoc.fromSnapshot(snapshots.get('session-one')!).toJSON()).toEqual(doc.toJSON());
    doc.getMap('fields').set('local', 'unsent');
    doc.commit();
    await repo.flush();
    await repo.unloadDoc('session-one');
    const reopened = await repo.openPersistedDoc('session-one');
    expect(reopened.doc.toJSON()).toEqual({ fields: { remote: 'peer', local: 'unsent' } });
    await repo.destroy();
  });

  it('does not expose a cold document until its seeded state is durable', async () => {
    const { storage, snapshots } = storageFixture();
    const save = storage.save;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    storage.save = async (payload) => {
      if (payload.type === 'doc-snapshot') {
        entered();
        await blocked;
      }
      await save(payload);
    };
    const open = createSessionSnapshotLoader(storage);
    const repo = await LoroRepo.create({ storageAdapter: storage });
    let exposed = false;
    const opening = open(repo, 'session-one', async () => remoteSnapshot()).then((handle) => {
      exposed = true;
      return handle;
    });
    await saving;
    expect(exposed).toBe(false);
    expect(snapshots.has('session-one')).toBe(false);
    release();
    const { doc } = await opening;
    expect(LoroDoc.fromSnapshot(snapshots.get('session-one')!).toJSON()).toEqual(doc.toJSON());
    await repo.destroy();
  });

  it('merges persisted edits before adoption without discarding either branch', async () => {
    const { storage, snapshots } = storageFixture();
    const local = new LoroDoc();
    local.getMap('fields').set('local', 'unsent');
    snapshots.set('session-one', local.export({ mode: 'snapshot' }));
    const open = createSessionSnapshotLoader(storage);
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const { doc } = await open(repo, 'session-one', async () => remoteSnapshot());
    expect(doc.toJSON()).toEqual({ fields: { remote: 'peer', local: 'unsent' } });
    expect(LoroDoc.fromSnapshot(snapshots.get('session-one')!).toJSON()).toEqual(doc.toJSON());
    await repo.destroy();
  });

  it('retains persisted pending updates while adopting a bootstrap snapshot', async () => {
    const remote = new LoroDoc();
    remote.setPeerId(1n);
    remote.getText('text').insert(0, 'base|');
    const base = remote.export({ mode: 'snapshot' });
    const beforeA = remote.oplogVersion();
    remote.getText('text').insert(5, 'A');
    const updateA = remote.export({ mode: 'update', from: beforeA });
    const beforeB = remote.oplogVersion();
    remote.getText('text').insert(6, 'B');
    const updateB = remote.export({ mode: 'update', from: beforeB });

    const persisted = LoroDoc.fromSnapshot(base);
    persisted.import(updateB);
    expect(persisted.exportPendingUpdates()).toBeDefined();

    const storage: StorageAdapter = {
      loadMeta: async () => undefined,
      loadDoc: async () => persisted,
      save: async () => {},
    };
    const open = createSessionSnapshotLoader(storage);
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const { doc } = await open(repo, 'session-one', async () => remoteSnapshot());
    expect(doc.getText('text').toString()).toBe('base|');
    expect(doc.exportPendingUpdates()).toBeDefined();
    doc.import(updateA);
    expect(doc.getText('text').toString()).toBe('base|AB');
    expect(doc.exportPendingUpdates()).toBeUndefined();
    await repo.destroy();
  });

  it('keeps an already owned replica and notifies its subscribers of the merge', async () => {
    const { storage } = storageFixture();
    const open = createSessionSnapshotLoader(storage);
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const owned = await repo.acquireDoc('session-one');
    owned.doc.getMap('fields').set('local', 'unsent');
    owned.doc.commit();
    let observed: unknown;
    const unsubscribe = owned.doc.subscribe(() => {
      observed = owned.doc.toJSON();
    });
    const handle = await open(repo, 'session-one', async () => remoteSnapshot());
    expect(handle.doc).toBe(owned.doc);
    expect(observed).toEqual({ fields: { remote: 'peer', local: 'unsent' } });
    unsubscribe();
    await owned.release();
    await repo.destroy();
  });

  it('falls back to the normal live merge if bootstrap persistence fails', async () => {
    const { storage, snapshots, failNextSave } = storageFixture();
    const open = createSessionSnapshotLoader(storage);
    const repo = await LoroRepo.create({ storageAdapter: storage });
    failNextSave();
    const handle = await open(repo, 'session-one', async () => remoteSnapshot());
    expect(handle.doc.toJSON()).toEqual({ fields: { remote: 'peer' } });
    await repo.flush();
    expect(LoroDoc.fromSnapshot(snapshots.get('session-one')!).toJSON()).toEqual(
      handle.doc.toJSON()
    );
    await repo.destroy();
  });

  it('reopens a document that already contains its cached snapshot without rebuilding or rewriting it', async () => {
    // A cache entry outlives its first merge, so every later cold open of a long
    // conversation would otherwise decode, import and re-save the whole history.
    const { storage, snapshots } = storageFixture();
    const cached = remoteSnapshot();
    const persisted = LoroDoc.fromSnapshot(cached);
    persisted.getMap('fields').set('local', 'unsent');
    persisted.commit();
    snapshots.set('session-one', persisted.export({ mode: 'snapshot' }));
    const stored = snapshots.get('session-one');
    let loaded: LoroDoc | undefined;
    const loadDoc = storage.loadDoc;
    storage.loadDoc = async (room) => (loaded = await loadDoc(room));
    const open = createSessionSnapshotLoader(storage);
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const { doc } = await open(repo, 'session-one', async () => cached);
    expect(doc).toBe(loaded);
    expect(doc.toJSON()).toEqual({ fields: { remote: 'peer', local: 'unsent' } });
    expect(snapshots.get('session-one')).toBe(stored);
    await repo.destroy();
  });

  it('merges new cached history into the loaded document instead of a rebuilt copy', async () => {
    const { storage, snapshots } = storageFixture();
    const local = new LoroDoc();
    local.getMap('fields').set('local', 'unsent');
    snapshots.set('session-one', local.export({ mode: 'snapshot' }));
    let loaded: LoroDoc | undefined;
    const loadDoc = storage.loadDoc;
    storage.loadDoc = async (room) => (loaded = await loadDoc(room));
    const open = createSessionSnapshotLoader(storage);
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const { doc } = await open(repo, 'session-one', async () => remoteSnapshot());
    expect(doc).toBe(loaded);
    expect(doc.toJSON()).toEqual({ fields: { remote: 'peer', local: 'unsent' } });
    expect(LoroDoc.fromSnapshot(snapshots.get('session-one')!).toJSON()).toEqual(doc.toJSON());
    await repo.destroy();
  });

  it('ignores corrupt bootstrap data and retains persisted edits', async () => {
    const { storage, snapshots } = storageFixture();
    const local = new LoroDoc();
    local.getMap('fields').set('local', 'unsent');
    snapshots.set('session-one', local.export({ mode: 'snapshot' }));
    const open = createSessionSnapshotLoader(storage);
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const handle = await open(repo, 'session-one', async () => new Uint8Array([1, 2, 3]));
    expect(handle.doc.toJSON()).toEqual({ fields: { local: 'unsent' } });
    await repo.destroy();
  });
});

describe('cold cloud snapshot checkpoint adoption', () => {
  const streamUrl = getWorkspaceDocStreamUrl(
    'workspace' as WorkspaceId,
    'session-one',
    'https://streams.example.com'
  );
  const room = 'session-one';
  function fixture() {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, _options: LockOptions, callback: LockGrantedCallback) =>
          callback({} as Lock),
      },
    });
    const remote = new LoroDoc();
    remote.setPeerId('1');
    remote.getMap('fields').set('remote', 'first');
    remote.commit();
    const bytes = remote.export({ mode: 'snapshot' });
    const row: EagerSyncSnapshot = {
      key: 'key',
      scope: 'workspace',
      roomId: room,
      plane: 'cloud',
      lastMessageAt: 1,
      savedAt: 1,
      snapshot: new Blob([bytes.slice().buffer]),
      cloudCheckpoint: {
        format: 1,
        snapshotVersion: Object.fromEntries(remote.oplogVersion().toJSON()),
        cursor: {
          streamUrl,
          nextOffset: '100',
          serverLowerBoundVersion: Object.fromEntries(remote.oplogVersion().toJSON()),
          updatedAtMs: 1,
        },
      },
    };
    const requests: Array<{ url: URL; method: string }> = [];
    let gone = false;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (method === 'POST') {
        const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
        let offset = 0;
        while (offset < body.length) {
          const length = new DataView(body.buffer).getUint32(offset, false);
          offset += 4;
          remote.import(body.slice(offset, offset + length));
          offset += length;
        }
        const headers = new Headers(init?.headers);
        return new Response(null, {
          headers: {
            'Producer-Epoch': headers.get('Producer-Epoch') ?? '0',
            'Producer-Seq': headers.get('Producer-Seq') ?? '0',
            'Stream-Next-Offset': '200',
            'Stream-Up-To-Date': 'true',
          },
        });
      }
      if (url.searchParams.has('live')) {
        return new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
          else
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true }
            );
        });
      }
      if (url.pathname.endsWith('/bootstrap'))
        return new Response(
          new Blob([
            '--cp\r\nContent-Type: application/octet-stream\r\n\r\n',
            remote.export({ mode: 'snapshot' }).slice().buffer,
            '\r\n--cp--\r\n',
          ]),
          {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=cp',
              'Stream-Snapshot-Offset': '100',
              'Stream-Next-Offset': '100',
              'Stream-Up-To-Date': 'true',
            },
          }
        );
      if (gone) {
        gone = false;
        return new Response(null, { status: 410 });
      }
      return new Response(null, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': url.searchParams.get('offset') ?? '100',
          'Stream-Up-To-Date': 'true',
        },
      });
    });
    const openWindow = async (name: string, entry: EagerSyncSnapshot = row, local?: Uint8Array) => {
      const storage = new IndexedDBStorageAdaptor({ dbName: `repo-${name}` });
      if (local) await storage.save({ type: 'doc-snapshot', docId: room, snapshot: local });
      const cursors = new ResilientRemoteCursorStore({ dbName: `cursor-${name}` });
      const repo = await LoroRepo.create({ storageAdapter: storage });
      const open = createSessionSnapshotLoader(storage);
      const handle = await open(
        repo,
        room,
        async () => new Uint8Array(await entry.snapshot.arrayBuffer()),
        (doc) => adoptEagerSyncCheckpoint(entry, 'workspace', room, streamUrl, doc, cursors)
      );
      const transport = createWorkspaceStreamsTransport({
        repo,
        workspaceId: 'workspace' as WorkspaceId,
        content: { mode: 'plaintext' },
        streamsBaseUrl: 'https://streams.example.com',
        shardHostSuffix: undefined,
        documentRemoteCursorStore: cursors,
        auth: async () => 'token',
      });
      return {
        storage,
        cursors,
        repo,
        handle,
        open,
        transport,
        async close() {
          await transport.close();
          await repo.destroy();
        },
      };
    };
    return {
      remote,
      row,
      requests,
      openWindow,
      gone() {
        gone = true;
      },
    };
  }

  it('lets independent window databases join from the cached offset without bootstrap', async () => {
    const f = fixture();
    try {
      for (const name of ['main', 'auxiliary']) {
        const w = await f.openWindow(name);
        try {
          expect((await w.cursors.load(streamUrl))?.nextOffset).toBe('100');
          const sub = w.transport.joinDocRoom(room, w.handle.doc);
          await sub.firstSyncedWithRemote;
          expect(w.handle.doc.toJSON()).toEqual(f.remote.toJSON());
          sub.unsubscribe();
        } finally {
          await w.close();
        }
      }
      expect(f.requests.some((r) => r.url.pathname.endsWith('/bootstrap'))).toBe(false);
      expect(
        f.requests
          .filter((r) => !r.url.searchParams.has('live'))
          .map((r) => [r.method, r.url.pathname, r.url.searchParams.get('offset')])
      ).toEqual([
        ['GET', new URL(streamUrl).pathname, '100'],
        ['GET', new URL(streamUrl).pathname, '100'],
      ]);
    } finally {
      f.remote.free();
    }
  });

  it('uploads unuploaded local writes after adopting remote progress', async () => {
    const f = fixture();
    const local = new LoroDoc();
    local.getMap('fields').set('local', 'unsent');
    local.commit();
    const w = await f.openWindow('local-edits', f.row, local.export({ mode: 'snapshot' }));
    try {
      const result = await w.transport.syncDoc(room, w.handle.doc);
      expect(result.error).toBeUndefined();
      expect(f.remote.getMap('fields').get('local')).toBe('unsent');
      expect(w.handle.doc.getMap('fields').get('remote')).toBe('first');
      expect(f.requests.some((r) => r.method === 'POST')).toBe(true);
      expect(f.requests.some((r) => r.url.pathname.endsWith('/bootstrap'))).toBe(false);
    } finally {
      await w.close();
      local.free();
      f.remote.free();
    }
  });

  it('never replaces an existing UI cursor, including an older or equal one', async () => {
    const f = fixture();
    const store = new ResilientRemoteCursorStore({ dbName: 'existing-cursor' });
    const original = {
      ...f.row.cloudCheckpoint!.cursor,
      nextOffset: 'ui-offset',
      serverLowerBoundVersion: {},
    };
    await store.save(original);
    try {
      await adoptEagerSyncCheckpoint(f.row, 'workspace', room, streamUrl, f.remote, store);
      expect(await store.load(streamUrl)).toEqual(original);
    } finally {
      f.remote.free();
    }
  });

  it.each(['legacy', 'scope', 'room', 'plane', 'stream', 'uncovered'] as const)(
    'ignores a %s checkpoint while preserving snapshot fallback',
    async (kind) => {
      const f = fixture();
      if (kind === 'legacy') delete f.row.cloudCheckpoint;
      else if (kind === 'scope') f.row.scope = 'another';
      else if (kind === 'room') f.row.roomId = 'another';
      else if (kind === 'plane') f.row.plane = 'local';
      else if (kind === 'stream')
        f.row.cloudCheckpoint!.cursor = {
          ...f.row.cloudCheckpoint!.cursor,
          streamUrl: 'https://other.example.com/ds/bucket/session-one',
        };
      else
        f.row.cloudCheckpoint!.cursor = {
          ...f.row.cloudCheckpoint!.cursor,
          serverLowerBoundVersion: { '1': 999 },
        };
      const w = await f.openWindow(kind);
      try {
        expect(await w.cursors.load(streamUrl)).toBeNull();
        const result = await w.transport.syncDoc(room, w.handle.doc);
        expect(result.error).toBeUndefined();
        expect(w.handle.doc.toJSON()).toEqual(f.remote.toJSON());
        expect(f.requests.some((r) => r.url.pathname.endsWith('/bootstrap'))).toBe(true);
      } finally {
        await w.close();
        f.remote.free();
      }
    }
  );

  it('recovers a gone adopted cursor by bootstrapping', async () => {
    const f = fixture();
    const w = await f.openWindow('gone');
    try {
      f.gone();
      f.remote.getMap('fields').set('after-compaction', 'new');
      f.remote.commit();
      const result = await w.transport.syncDoc(room, w.handle.doc);
      expect(result.error).toBeUndefined();
      expect(w.handle.doc.toJSON()).toEqual(f.remote.toJSON());
      expect(f.requests.some((r) => r.url.pathname.endsWith('/bootstrap'))).toBe(true);
    } finally {
      await w.close();
      f.remote.free();
    }
  });
  it('seeds progress only after a cold merge is durable, and never for an already owned document', async () => {
    const f = fixture();
    const storage = new IndexedDBStorageAdaptor({ dbName: 'durability' });
    const store = new ResilientRemoteCursorStore({ dbName: 'durability-cursors' });
    const repo = await LoroRepo.create({ storageAdapter: storage });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const save = storage.save.bind(storage);
    storage.save = async (payload) => {
      if (payload.type === 'doc-snapshot') {
        entered();
        await blocked;
      }
      await save(payload);
    };
    const open = createSessionSnapshotLoader(storage);
    const read = async () => new Uint8Array(await f.row.snapshot.arrayBuffer());
    const adopt = (doc: LoroDoc) =>
      adoptEagerSyncCheckpoint(f.row, 'workspace', room, streamUrl, doc, store);
    try {
      const opening = open(repo, room, read, adopt);
      await saving;
      expect(await store.load(streamUrl)).toBeNull();
      release();
      const handle = await opening;
      expect((await store.load(streamUrl))?.nextOffset).toBe('100');
      await store.delete(streamUrl);
      await open(repo, room, read, adopt);
      expect(await store.load(streamUrl)).toBeNull();
      await repo.unloadDoc(room);
      await open(repo, room, read, adopt);
      expect((await store.load(streamUrl))?.nextOffset).toBe('100');
      expect(handle.doc.toJSON()).toEqual(f.remote.toJSON());
    } finally {
      release();
      await repo.destroy();
      f.remote.free();
    }
  });

  it('leaves progress empty after failed persistence and adopts on a later successful cold open', async () => {
    const f = fixture();
    const storage = new IndexedDBStorageAdaptor({ dbName: 'failed-durability' });
    const store = new ResilientRemoteCursorStore({ dbName: 'failed-cursors' });
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const save = storage.save.bind(storage);
    let fail = true;
    storage.save = async (payload) => {
      if (fail && payload.type === 'doc-snapshot') {
        fail = false;
        throw new Error('disk unavailable');
      }
      await save(payload);
    };
    const open = createSessionSnapshotLoader(storage);
    const read = async () => new Uint8Array(await f.row.snapshot.arrayBuffer());
    const adopt = (doc: LoroDoc) =>
      adoptEagerSyncCheckpoint(f.row, 'workspace', room, streamUrl, doc, store);
    try {
      await open(repo, room, read, adopt);
      expect(await store.load(streamUrl)).toBeNull();
      await repo.flush();
      await repo.unloadDoc(room);
      const handle = await open(repo, room, read, adopt);
      expect((await store.load(streamUrl))?.nextOffset).toBe('100');
      expect(handle.doc.toJSON()).toEqual(f.remote.toJSON());
    } finally {
      await repo.destroy();
      f.remote.free();
    }
  });

  it('retains persisted pending imports and refuses to advance their checkpoint', async () => {
    const f = fixture();
    const source = new LoroDoc();
    source.setPeerId('2');
    source.getText('body').insert(0, 'base');
    source.commit();
    const base = source.export({ mode: 'snapshot' });
    const beforeA = source.oplogVersion();
    source.getText('body').insert(4, 'A');
    source.commit();
    const updateA = source.export({ mode: 'update', from: beforeA });
    const beforeB = source.oplogVersion();
    source.getText('body').insert(5, 'B');
    source.commit();
    const updateB = source.export({ mode: 'update', from: beforeB });
    const storage = new IndexedDBStorageAdaptor({ dbName: 'pending-adoption' });
    await storage.save({ type: 'doc-snapshot', docId: room, snapshot: base });
    await storage.save({ type: 'doc-update', docId: room, update: updateB });
    const cursors = new ResilientRemoteCursorStore({ dbName: 'pending-cursors' });
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const open = createSessionSnapshotLoader(storage);
    try {
      const handle = await open(
        repo,
        room,
        async () => new Uint8Array(await f.row.snapshot.arrayBuffer()),
        (doc) => adoptEagerSyncCheckpoint(f.row, 'workspace', room, streamUrl, doc, cursors)
      );
      expect(handle.doc.exportPendingUpdates()).toBeDefined();
      expect(await cursors.load(streamUrl)).toBeNull();
      await repo.flush();
      await repo.unloadDoc(room);
      const restored = await repo.openPersistedDoc(room);
      expect(restored.doc.exportPendingUpdates()).toBeDefined();
      restored.doc.import(updateA);
      expect(restored.doc.getText('body').toString()).toBe('baseAB');
      expect(restored.doc.exportPendingUpdates()).toBeUndefined();
    } finally {
      await repo.destroy();
      source.free();
      f.remote.free();
    }
  });
});
