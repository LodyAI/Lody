import { Flock } from '@loro-dev/flock-wasm';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';
import { getWorkspaceFlockDocId } from '@lody/shared';
import { captureFrozenRendererWorkspaceFlockSources } from '../src/providers/renderer-workspace-flock-migration';

const workspaceId = 'lw_synthetic_migration' as WorkspaceId;
const roomId = getWorkspaceFlockDocId(workspaceId);
const name = `lody-loro-repo-db-${workspaceId}`;
function adapter(idb: IDBFactory, dbName: string) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: idb });
  try {
    return new IndexedDBStorageAdaptor({ dbName });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
}
const request = <A>(op: IDBRequest<A>) =>
  new Promise<A>((resolve, reject) => {
    op.onsuccess = () => resolve(op.result);
    op.onerror = () => reject(op.error);
  });
async function stored(idb: IDBFactory, dbName: string) {
  const db = await request(idb.open(dbName));
  try {
    const stores = [...db.objectStoreNames];
    const tx = db.transaction(stores, 'readonly');
    return await Promise.all(
      stores.map(async (store) => [
        store,
        await request(tx.objectStore(store).getAllKeys()),
        await request(tx.objectStore(store).getAll()),
      ])
    );
  } finally {
    db.close();
  }
}

describe('frozen renderer workspace Flock inventory', () => {
  it('captures every window after its drain barrier without rewriting binary bases, JSON update queues or checkpoints', async () => {
    const idb = new IDBFactory();
    const stores = [
      adapter(idb, name),
      adapter(idb, `${name}:window-a`),
      adapter(idb, `${name}:window-empty`),
      adapter(idb, `${name}-other-workspace`),
    ];
    try {
      const old = new Flock();
      old.put(['project', 'deleted'], { title: 'old device' }, 100);
      const changed = Flock.strictFromFile(old.exportFile());
      changed.delete(['project', 'deleted'], 200);
      changed.put(['futureUnknownRoot', 'opaque'], { nested: { future: true } }, 201);
      await stores[0]!.save({
        type: 'flock-doc-snapshot',
        flockDocId: roomId,
        snapshot: old.exportFile(),
      });
      await stores[1]!.save({
        type: 'flock-doc-snapshot',
        flockDocId: roomId,
        snapshot: old.exportFile(),
      });
      await stores[2]!.save({
        type: 'flock-doc-snapshot',
        flockDocId: 'another-room',
        snapshot: old.exportFile(),
      });
      await stores[3]!.save({
        type: 'flock-doc-snapshot',
        flockDocId: roomId,
        snapshot: old.exportFile(),
      });
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const freezing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const capture = captureFrozenRendererWorkspaceFlockSources({
        workspaceId,
        contentMode: 'plaintext',
        indexedDB: idb,
        freezeAndDrainAllWindows: async () => {
          entered();
          await barrier;
        },
      });
      await freezing;
      await stores[0]!.save({
        type: 'flock-doc-update',
        flockDocId: roomId,
        update: new TextEncoder().encode(JSON.stringify(changed.exportJson())),
      });
      const before = await Promise.all(
        [name, `${name}:window-a`, `${name}:window-empty`].map((name) => stored(idb, name))
      );
      release();
      const sources = await capture;
      expect(sources.map((source) => source.dbName)).toEqual([
        name,
        `${name}:window-a`,
        `${name}:window-empty`,
      ]);
      expect(sources.map((source) => source.present)).toEqual([true, true, false]);
      const merged = new Flock();
      for (const source of sources) merged.strictImportFile(source.snapshot);
      expect(merged.exportJson()).toEqual(changed.exportJson());
      expect(merged.getEntry(['project', 'deleted'])).toEqual(
        changed.getEntry(['project', 'deleted'])
      );
      merged.strictImportFile(old.exportFile());
      expect(merged.get(['project', 'deleted'])).toBeUndefined();
      expect(merged.get(['futureUnknownRoot', 'opaque'])).toEqual({ nested: { future: true } });
      expect(await Promise.all(sources.map((source) => stored(idb, source.dbName)))).toEqual(
        before
      );
    } finally {
      await Promise.all(stores.map((store) => store.close()));
    }
  });

  it('refuses corrupt persisted binary instead of recovery-importing a partial replica, preserving the original', async () => {
    const idb = new IDBFactory();
    const store = adapter(idb, name);
    try {
      const flock = new Flock();
      flock.put(['project', 'preserved'], 'must not be silently lost', 100);
      await store.save({
        type: 'flock-doc-snapshot',
        flockDocId: roomId,
        snapshot: flock.exportFile(),
      });
      const db = await request(idb.open(name));
      const corrupted = flock.exportFile();
      corrupted[corrupted.length - 1] ^= 1;
      const tx = db.transaction('flock-docs', 'readwrite');
      await request(tx.objectStore('flock-docs').put(corrupted, roomId));
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      const before = await stored(idb, name);
      await expect(
        captureFrozenRendererWorkspaceFlockSources({
          workspaceId,
          contentMode: 'plaintext',
          indexedDB: idb,
          freezeAndDrainAllWindows: async () => {},
        })
      ).rejects.toThrow();
      expect(await stored(idb, name)).toEqual(before);
    } finally {
      await store.close();
    }
  });
});

it('freezes two actual Repo/IDB window lifetimes before exporting, waits admitted writes and detaches live WF sync', async () => {
  const { LoroRepo } = await import('loro-repo');
  const { RendererWorkspaceFlockFreeze, createRendererWfRepoFreezePorts } =
    await import('../src/providers/renderer-workspace-flock-freeze');
  const { RendererWorkspaceFlockMigrationMainLegacy } =
    await import('../../../apps/electron/src/main/services/renderer-workspace-flock-migration');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'lody-wf-freeze-'));
  const idb = new IDBFactory();
  const binding = {
    accountId: 'local:synthetic',
    workspaceId,
    roomId,
    contentMode: 'plaintext' as const,
  };
  const registered = [1, 2];
  const gates = new Map<number, InstanceType<typeof RendererWorkspaceFlockFreeze>>();
  const repos: Array<Awaited<ReturnType<typeof LoroRepo.create>>> = [];
  const stores: IndexedDBStorageAdaptor[] = [];
  let committed: 'legacy' | 'native' | 'frozen' = 'legacy';
  let captureStarted = false;
  const publishedOwners = new Map<number, string>();
  const main = new RendererWorkspaceFlockMigrationMainLegacy({
    databasePath: join(root, 'maintenance.sqlite3'),
    registeredWindowIds: () => registered,
    readCommittedOwner: async () => committed,
    send: async (id, message) => {
      if (message.phase === 'capture') captureStarted = true;
      const ack = await gates.get(id)!.handle(message);
      main.acceptAck(id, ack);
    },
    publishOwner: (id, owner) => {
      if (id === 1) throw new Error('synthetic frame closes just after durable publication');
      publishedOwners.set(id, owner.owner);
    },
  });
  const signal = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const detached = [signal(), signal()];
  const live = new Set<string>();
  try {
    for (const id of registered) {
      const storage = adapter(idb, `${name}:window-${id}`);
      stores.push(storage);
      let gate: InstanceType<typeof RendererWorkspaceFlockFreeze> | undefined;
      const repo = await LoroRepo.create({
        storageAdapter: storage,
        metaDebounceCommitMs: 0,
        resolveRoomTransports: (room) =>
          room.kind === 'flock-doc' && room.id === roomId && !gate?.isLegacy()
            ? { transportIds: [] }
            : { transportIds: ['synthetic'] },
      });
      repos.push(repo);
      const ports = createRendererWfRepoFreezePorts(repo, roomId);
      gate = new RendererWorkspaceFlockFreeze(binding, {
        readStartupOwner: async () => {
          const registration = main.register(id, binding, main.beginRegistration(id));
          return main.ready(id, registration.registrationId);
        },
        indexedDB: idb,
        persistRoom: ports.persistRoom,
        detachRoom: async () => {
          await ports.detachRoom();
          detached[id - 1]!.resolve();
        },
      });
      gates.set(id, gate);
      await gate.startup();
      const sub = (resource: string) => {
        live.add(resource);
        return {
          unsubscribe: () => {
            live.delete(resource);
          },
          firstSyncedWithRemote: Promise.resolve(),
          waitUntilSynced: async () => {},
          status: 'joined' as const,
          onStatusChange: () => () => {},
        };
      };
      await repo.addTransport('synthetic', {
        connect: async () => {},
        close: async () => {},
        isConnected: () => true,
        getStatus: () => 'connected',
        onStatusChange: () => () => {},
        syncMeta: async () => ({ ok: true }),
        syncDoc: async () => ({ ok: true }),
        syncFlockDoc: async () => ({ ok: true }),
        joinMetaRoom: () => sub(`meta-${id}`),
        joinDocRoom: (doc) => sub(`${id}:${doc}`),
        joinFlockDocRoom: (doc) => sub(`${id}:${doc}`),
      });
      const handle = await repo.openFlockDoc(roomId);
      handle.flock.put(['futureOpaque', `window-${id}`], { from: id }, 100 + id);
      handle.flock.commit();
      await gate.run(() => handle.joinRoom());
    }
    expect(live.has(`1:${roomId}`)).toBe(true);
    expect(live.has(`2:${roomId}`)).toBe(true);
    const entered = signal(),
      release = signal();
    const admitted = gates.get(1)!.run(async () => {
      entered.resolve();
      await release.promise;
      const handle = await repos[0]!.openFlockDoc(roomId);
      handle.flock.put(['futureOpaque', 'settled-before-ack'], 'last admitted write', 999);
      handle.flock.commit();
    });
    await entered.promise;
    const migration = main.freeze(binding);
    await Promise.all(detached.map((signal) => signal.promise));
    expect(captureStarted).toBe(false);
    expect(live.has(`1:${roomId}`)).toBe(false);
    expect(live.has(`2:${roomId}`)).toBe(false);
    await expect(gates.get(1)!.run(() => Promise.resolve())).rejects.toThrow(/frozen/);
    expect(main.status(binding).owner).toBe('frozen');
    registered.push(3);
    expect(main.register(3, binding, main.beginRegistration(3)).owner).toBe('frozen');
    release.resolve();
    await admitted;
    const frozen = await migration;
    const merged = new Flock();
    for (const source of frozen.sources) merged.strictImportFile(source.snapshot);
    expect(merged.get(['futureOpaque', 'settled-before-ack'])).toBe('last admitted write');
    expect(merged.get(['futureOpaque', 'window-2'])).toEqual({ from: 2 });
    await expect(main.complete(binding, frozen.revision)).rejects.toThrow(/not durably committed/);
    expect(main.status(binding).owner).toBe('frozen');
    committed = 'native';
    await main.complete(binding, frozen.revision);
    expect(main.status(binding).owner).toBe('native');
    expect(publishedOwners.get(2)).toBe('native');
    main.close();
    const restart = new RendererWorkspaceFlockMigrationMainLegacy({
      databasePath: join(root, 'maintenance.sqlite3'),
      registeredWindowIds: () => [3],
      send: () => {},
      readCommittedOwner: async () => committed,
    });
    expect(restart.register(3, binding, restart.beginRegistration(3)).owner).toBe('native');
    restart.close();
  } finally {
    await Promise.all([...gates.values()].map((gate) => gate.close()));
    main.close();
    await Promise.all(repos.map((repo) => repo.destroy()));
    await Promise.all(stores.map((store) => store.close()));
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a replacement runtime registered when an aborted older registration or reply completes late', async () => {
  const { RendererWorkspaceFlockMigrationMainLegacy } =
    await import('../../../apps/electron/src/main/services/renderer-workspace-flock-migration');
  const { createRendererWorkspaceFlockIpcPort } =
    await import('../src/providers/renderer-workspace-flock-ipc');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const binding = {
    accountId: 'local:synthetic',
    workspaceId,
    roomId,
    contentMode: 'plaintext' as const,
  };
  for (const stage of ['catalog', 'reply'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'lody-wf-register-'));
    const listeners = new Set<
      (message: import('@lody/shared/renderer-room-migration').RendererWfRequest) => void
    >();
    const main = new RendererWorkspaceFlockMigrationMainLegacy({
      databasePath: join(root, 'owners.sqlite3'),
      registeredWindowIds: () => [1],
      send: (_id, request) => {
        for (const listener of listeners) listener(request);
      },
      readCommittedOwner: async () => 'legacy',
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    let newestTicket = '';
    const port = createRendererWorkspaceFlockIpcPort(
      {
        registerWorkspaceFlock: async () => {
          const attempt = main.beginRegistration(1);
          const first = ++calls === 1;
          if (first && stage === 'catalog') {
            entered();
            await wait;
          }
          const registered = main.register(1, binding, attempt);
          if (!first) newestTicket = registered.registrationId;
          if (first && stage === 'reply') {
            entered();
            await wait;
          }
          return registered;
        },
        readyWorkspaceFlock: async (ticket) => main.ready(1, ticket),
        retireWorkspaceFlock: async (ticket) => main.retire(1, ticket),
        acknowledgeWorkspaceFlock: async (ack) => main.acceptAck(1, ack),
      },
      (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    );
    const abort = new AbortController();
    const onRequest = async (
      request: import('@lody/shared/renderer-room-migration').RendererWfRequest
    ) => (request.phase === 'freeze' ? { ...request } : { ...request, sources: [] });
    const old = port.start(binding, onRequest, abort.signal);
    void old.catch(() => {});
    try {
      await started;
      abort.abort(new Error('old runtime retired'));
      const replacement = await port.start(binding, onRequest);
      release();
      await expect(old).rejects.toThrow();
      expect(main.ready(1, newestTicket).owner).toBe('legacy');
      const result = await main.freeze(binding);
      expect(result.sources).toEqual([]);
      expect(main.status(binding).owner).toBe('frozen');
      await replacement.close();
    } finally {
      release();
      await Promise.allSettled([old]);
      main.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

it('rejects oversized all-window inventory without truncation and retains its durable freeze after main restart', async () => {
  const { RendererWorkspaceFlockMigrationMainLegacy } =
    await import('../../../apps/electron/src/main/services/renderer-workspace-flock-migration');
  const { createRendererWorkspaceFlockIpcPort } =
    await import('../src/providers/renderer-workspace-flock-ipc');
  const { RENDERER_WF_MAX_BYTES } = await import('@lody/shared/renderer-room-migration');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'lody-wf-budget-'));
  const binding = {
    accountId: 'local:synthetic',
    workspaceId,
    roomId,
    contentMode: 'plaintext' as const,
  };
  let listener:
    | ((message: import('@lody/shared/renderer-room-migration').RendererWfRequest) => void)
    | undefined;
  const options = {
    databasePath: join(root, 'owners.sqlite3'),
    registeredWindowIds: () => [1],
    send: (
      _id: number,
      request: import('@lody/shared/renderer-room-migration').RendererWfRequest
    ) => listener?.(request),
    readCommittedOwner: async () => 'legacy' as const,
  };
  const main = new RendererWorkspaceFlockMigrationMainLegacy(options);
  const port = createRendererWorkspaceFlockIpcPort(
    {
      registerWorkspaceFlock: async () => main.register(1, binding, main.beginRegistration(1)),
      readyWorkspaceFlock: async (ticket) => main.ready(1, ticket),
      retireWorkspaceFlock: async (ticket) => main.retire(1, ticket),
      acknowledgeWorkspaceFlock: async (ack) => main.acceptAck(1, ack),
    },
    (onRequest) => {
      listener = onRequest;
      return () => {
        listener = undefined;
      };
    }
  );
  let registration: Awaited<ReturnType<typeof port.start>> | undefined;
  try {
    registration = await port.start(binding, async (request) =>
      request.phase === 'freeze'
        ? { ...request }
        : {
            ...request,
            sources: [
              {
                sourceId: `renderer-idb:loro-repo@0.25.0:${name}`,
                dbName: name,
                present: true,
                snapshot: new Uint8Array(RENDERER_WF_MAX_BYTES + 1),
              },
            ],
          }
    );
    await expect(main.freeze(binding)).rejects.toThrow(/capture_failed/);
    expect(main.status(binding).owner).toBe('frozen');
    await registration.close();
    registration = undefined;
    main.close();
    const restarted = new RendererWorkspaceFlockMigrationMainLegacy(options);
    try {
      expect(restarted.register(1, binding, restarted.beginRegistration(1)).owner).toBe('frozen');
    } finally {
      restarted.close();
    }
  } finally {
    await registration?.close();
    main.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps persistent maintenance when a current participant closes or sends an unknown ACK, and never captures partial inventory', async () => {
  const { RendererWorkspaceFlockMigrationMainLegacy } =
    await import('../../../apps/electron/src/main/services/renderer-workspace-flock-migration');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const binding = {
    accountId: 'local:synthetic',
    workspaceId,
    roomId,
    contentMode: 'plaintext' as const,
  };
  for (const failure of ['closed', 'unknown'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'lody-wf-participant-'));
    const requests = new Map<
      number,
      import('@lody/shared/renderer-room-migration').RendererWfRequest
    >();
    let sent!: () => void;
    const delivered = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const options = {
      databasePath: join(root, 'owners.sqlite3'),
      registeredWindowIds: () => [1, 2],
      readCommittedOwner: async () => 'legacy' as const,
      send: (
        id: number,
        request: import('@lody/shared/renderer-room-migration').RendererWfRequest
      ) => {
        if (request.phase === 'capture') throw new Error('partial inventory capture is forbidden');
        requests.set(id, request);
        if (requests.size === 2) sent();
      },
    };
    const main = new RendererWorkspaceFlockMigrationMainLegacy(options);
    for (const id of [1, 2]) {
      const registration = main.register(id, binding, main.beginRegistration(id));
      main.ready(id, registration.registrationId);
    }
    const freeze = main.freeze(binding);
    void freeze.catch(() => {});
    try {
      await delivered;
      main.acceptAck(1, requests.get(1)!);
      if (failure === 'closed') main.windowClosed(2);
      else
        expect(() =>
          main.acceptAck(2, { ...requests.get(2)!, requestId: 'unknown-request' })
        ).toThrow(/Unknown/);
      await expect(freeze).rejects.toThrow();
      expect(main.status(binding).owner).toBe('frozen');
      if (failure === 'closed')
        expect(main.status(binding).revision).not.toBe(requests.get(2)!.revision);
      expect(() => main.assertFrozen(binding, main.status(binding).revision)).toThrow(/absent/);
      main.close();
      const restart = new RendererWorkspaceFlockMigrationMainLegacy(options);
      try {
        expect(restart.register(1, binding, restart.beginRegistration(1)).owner).toBe('frozen');
        if (failure === 'closed')
          expect(restart.status(binding).revision).not.toBe(requests.get(2)!.revision);
      } finally {
        restart.close();
      }
    } finally {
      main.close();
      await Promise.allSettled([freeze]);
      await rm(root, { recursive: true, force: true });
    }
  }
});

it('holds startup legacy admission while main freezes before the ready handshake completes', async () => {
  const { RendererWorkspaceFlockMigrationMainLegacy } =
    await import('../../../apps/electron/src/main/services/renderer-workspace-flock-migration');
  const { RendererWorkspaceFlockFreeze } =
    await import('../src/providers/renderer-workspace-flock-freeze');
  const { createRendererWorkspaceFlockIpcPort } =
    await import('../src/providers/renderer-workspace-flock-ipc');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'lody-wf-startup-'));
  const idb = new IDBFactory();
  const storage = adapter(idb, name);
  const before = new Flock();
  before.put(['unknownRoot', 'preserve'], 'historical window', 10);
  await storage.save({
    type: 'flock-doc-snapshot',
    flockDocId: roomId,
    snapshot: before.exportFile(),
  });
  await storage.close();
  const binding = {
    accountId: 'local:synthetic',
    workspaceId,
    roomId,
    contentMode: 'plaintext' as const,
  };
  let listener:
    | ((message: import('@lody/shared/renderer-room-migration').RendererWfRequest) => void)
    | undefined;
  const main = new RendererWorkspaceFlockMigrationMainLegacy({
    databasePath: join(root, 'owners.sqlite3'),
    registeredWindowIds: () => [1],
    send: (_id, request) => listener?.(request),
    readCommittedOwner: async () => 'legacy',
  });
  let readyEntered!: () => void;
  const readyWaiting = new Promise<void>((resolve) => {
    readyEntered = resolve;
  });
  let finishReady!: () => void;
  const readyBarrier = new Promise<void>((resolve) => {
    finishReady = resolve;
  });
  const port = createRendererWorkspaceFlockIpcPort(
    {
      registerWorkspaceFlock: async () => main.register(1, binding, main.beginRegistration(1)),
      readyWorkspaceFlock: async (ticket) => {
        readyEntered();
        await readyBarrier;
        return main.ready(1, ticket);
      },
      retireWorkspaceFlock: async (ticket) => main.retire(1, ticket),
      acknowledgeWorkspaceFlock: async (ack) => main.acceptAck(1, ack),
    },
    (handler) => {
      listener = handler;
      return () => {
        listener = undefined;
      };
    }
  );
  let registration: Awaited<ReturnType<typeof port.start>> | undefined;
  const gate = new RendererWorkspaceFlockFreeze(binding, {
    indexedDB: idb,
    readStartupOwner: async () => {
      registration = await port.start(binding, (request) => gate.handle(request));
      return registration.owner;
    },
    detachRoom: async () => {
      throw new Error('a startup-frozen runtime must not open legacy WF');
    },
    persistRoom: async () => {
      throw new Error('a startup-frozen runtime must not open legacy WF');
    },
  });
  const startup = gate.startup();
  void startup.catch(() => {});
  let freeze: ReturnType<typeof main.freeze> | undefined;
  try {
    await readyWaiting;
    await expect(gate.run(() => Promise.resolve())).rejects.toThrow(/frozen/);
    freeze = main.freeze(binding);
    void freeze.catch(() => {});
    expect(main.status(binding).owner).toBe('frozen');
    finishReady();
    expect((await startup).owner).toBe('frozen');
    const result = await freeze;
    expect(Flock.strictFromFile(result.sources[0]!.snapshot).exportJson()).toEqual(
      before.exportJson()
    );
    await expect(gate.run(() => Promise.resolve())).rejects.toThrow(/frozen/);
  } finally {
    finishReady();
    await Promise.allSettled([startup, freeze]);
    await gate.close();
    await registration?.close();
    main.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not let a late capture ACK from an aborted freeze cancel a newer receipt in the same window registration', async () => {
  const { RendererWorkspaceFlockMigrationMainLegacy } =
    await import('../../../apps/electron/src/main/services/renderer-workspace-flock-migration');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'lody-wf-late-ack-'));
  const binding = {
    accountId: 'local:synthetic',
    workspaceId,
    roomId,
    contentMode: 'plaintext' as const,
  };
  let oldCapture: import('@lody/shared/renderer-room-migration').RendererWfRequest | undefined;
  let reached!: () => void;
  const captured = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const main = new RendererWorkspaceFlockMigrationMainLegacy({
    databasePath: join(root, 'owners.sqlite3'),
    registeredWindowIds: () => [1],
    readCommittedOwner: async () => 'legacy',
    send: (_id, request) => {
      if (request.phase === 'freeze') {
        main.acceptAck(1, request);
        return;
      }
      if (!oldCapture) {
        oldCapture = request;
        reached();
        return;
      }
      expect(() => main.acceptAck(1, { ...oldCapture, sources: [] })).toThrow(/Unknown/);
      main.acceptAck(1, { ...request, sources: [] });
    },
  });
  const registration = main.register(1, binding, main.beginRegistration(1));
  main.ready(1, registration.registrationId);
  const abort = new AbortController();
  const first = main.freeze(binding, abort.signal);
  void first.catch(() => {});
  try {
    await captured;
    abort.abort(new Error('first freeze deadline'));
    await expect(first).rejects.toThrow(/deadline/);
    const second = await main.freeze(binding);
    expect(second.revision).not.toBe(oldCapture!.revision);
    expect(second.sources).toEqual([]);
    main.assertFrozen(binding, second.revision);
    expect(main.status(binding).owner).toBe('frozen');
  } finally {
    abort.abort();
    main.close();
    await Promise.allSettled([first]);
    await rm(root, { recursive: true, force: true });
  }
});
