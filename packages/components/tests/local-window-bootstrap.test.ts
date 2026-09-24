import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo, type StorageAdapter } from 'loro-repo';
import { LoroDoc } from 'loro-crdt';
import {
  createLocalWindowBootstrap,
  createSessionSnapshotLoader,
  readSessionBootstrapSnapshot,
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

  it('falls through immediately when live peers do not own the requested document', async () => {
    vi.useFakeTimers();
    const { createChannel, createRegistry } = channelFactory();
    const repo = await LoroRepo.create({});
    const owner = createLocalWindowBootstrap(
      repo,
      'workspace',
      new Map(),
      createChannel,
      createRegistry
    );
    const receiver = createLocalWindowBootstrap(
      repo,
      'workspace',
      new Map(),
      createChannel,
      createRegistry
    );
    expect(await receiver.readDocument('session:missing')).toBeUndefined();
    owner.close();
    expect(await receiver.readDocument('session:closed-peer')).toBeUndefined();
    receiver.close();
    await repo.destroy();
  });

  it('uses the disk snapshot before peer state and tolerates disk failure', async () => {
    const disk = new Uint8Array([1]);
    const peer = new Uint8Array([2]);
    expect(
      await readSessionBootstrapSnapshot(
        async () => disk,
        async () => peer
      )
    ).toEqual(disk);
    expect(
      await readSessionBootstrapSnapshot(
        async () => {
          throw new Error('broken cache');
        },
        async () => peer
      )
    ).toEqual(peer);
    expect(
      await readSessionBootstrapSnapshot(
        async () => undefined,
        async () => undefined
      )
    ).toBeUndefined();
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
