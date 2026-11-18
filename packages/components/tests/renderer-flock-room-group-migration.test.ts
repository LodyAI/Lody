import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroRepo } from 'loro-repo';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import {
  FLOCK_GROUP_MAX_BYTES,
  rendererFlockGroupSchema,
  rendererFlockGroupKey,
  rendererFlockGroupScope,
  validateRendererFlockGroupInventory,
  type RendererFlockGroup,
  type RendererFlockGroupRequest,
} from '@lody/shared/renderer-flock-room-group';
import { RendererFlockRoomGroupMigrationMainLegacy } from '../../../apps/electron/src/main/services/renderer-flock-room-group-migration';
import { captureFrozenRendererFlockRoomGroup } from '../src/providers/renderer-flock-room-group-capture';
import {
  RendererFlockRoomGroupFreeze,
  createRendererFlockGroupRepoFreezePorts,
} from '../src/providers/renderer-flock-room-group-freeze';

const workspaceId = 'lw_group_fixture';
const group: RendererFlockGroup = {
  accountId: 'local:fixture',
  workspaceId,
  domain: 'machine',
  contentMode: 'plaintext',
  roomIds: [`${workspaceId}:mf:machine-a`, `${workspaceId}:mf:machine-b`],
};
const schedule: RendererFlockGroup = {
  ...group,
  domain: 'schedule',
  roomIds: [`${workspaceId}:sr`],
};
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
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
const request = <A>(req: IDBRequest<A>) =>
  new Promise<A>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
async function dump(idb: IDBFactory, dbName: string) {
  const db = await request(idb.open(dbName));
  try {
    const names = [...db.objectStoreNames];
    const tx = db.transaction(names, 'readonly');
    return await Promise.all(
      names.map(async (store) => [
        store,
        await request(tx.objectStore(store).getAllKeys()),
        await request(tx.objectStore(store).getAll()),
      ])
    );
  } finally {
    db.close();
  }
}

async function selectedFixture(
  selected: RendererFlockGroup,
  databasePath: string,
  idb: IDBFactory,
  beforeCapture?: () => Promise<void>
) {
  let native = false;
  let gate!: RendererFlockRoomGroupFreeze;
  const main = new RendererFlockRoomGroupMigrationMainLegacy({
    group: selected,
    databasePath,
    registeredWindowIds: () => [1],
    readCommittedOwner: async () => (native ? 'native' : 'legacy'),
    send: async (id, req) => {
      const ack = await gate.handle(req);
      if (req.phase === 'capture') await beforeCapture?.();
      main.acceptAck(id, ack);
    },
    publishOwner: (_id, owner) => gate.published(owner),
  });
  gate = new RendererFlockRoomGroupFreeze(selected, {
    indexedDB: idb,
    detachRooms: async () => {},
    persistRooms: async () => {},
    readStartupOwner: async () => {
      const reg = main.register(1, main.beginRegistration(1));
      gate.bindRegistration(reg.registrationId);
      return main.ready(1, reg.registrationId);
    },
  });
  await gate.startup();
  return {
    main,
    gate,
    native: () => {
      native = true;
    },
    async close() {
      try {
        await gate.close();
      } finally {
        main.close();
      }
    },
  };
}

it('migrates selected machines sequentially in one workspace while unselected and newly added machines remain legacy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-mf-selected-'));
  const databasePath = path.join(root, 'owners.sqlite3');
  const a = { ...group, roomIds: [group.roomIds[0]!] },
    b = { ...group, roomIds: [group.roomIds[1]!] };
  const idb = new IDBFactory(),
    store = adapter(idb, name);
  const original = new Flock();
  original.put(['opaque'], { preserved: true }, 100);
  await store.save({
    type: 'flock-doc-snapshot',
    flockDocId: a.roomIds[0]!,
    snapshot: original.exportFile(),
  });
  await store.save({
    type: 'flock-doc-snapshot',
    flockDocId: b.roomIds[0]!,
    snapshot: original.exportFile(),
  });
  const first = await selectedFixture(a, databasePath, idb);
  const second = await selectedFixture(b, databasePath, idb);
  let added: Awaited<ReturnType<typeof selectedFixture>> | undefined;
  try {
    const proofA = await first.main.freeze();
    first.native();
    await first.main.complete(proofA.revision);
    expect(first.main.status().owner).toBe('native');
    expect(second.main.status().owner).toBe('legacy');
    expect(first.gate.shouldRoute(b.roomIds[0]!)).toBe(true);
    const later = Flock.strictFromFile(original.exportFile());
    later.put(['later'], 'legacy B still writes', 200);
    await second.gate.run(b.roomIds[0]!, () =>
      store.save({
        type: 'flock-doc-snapshot',
        flockDocId: b.roomIds[0]!,
        snapshot: later.exportFile(),
      })
    );
    const proofB = await second.main.freeze();
    expect(
      Flock.strictFromFile(proofB.windows[0]!.inventory[0]!.sources[0]!.snapshot).get(['later'])
    ).toBe('legacy B still writes');
    second.native();
    await second.main.complete(proofB.revision);
    expect(first.main.status().owner).toBe('native');
    expect(second.main.status().owner).toBe('native');
    expect(first.main.status().revision).toBe(proofA.revision);
    added = await selectedFixture(
      { ...group, roomIds: [`${workspaceId}:mf:machine-c`] },
      databasePath,
      idb
    );
    expect(added.main.status().owner).toBe('legacy');
    expect(await added.gate.run(added.main.group.roomIds[0]!, () => 'new machine allowed')).toBe(
      'new machine allowed'
    );
  } finally {
    await Promise.allSettled([first.close(), second.close(), added?.close()]);
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('freezes disjoint groups concurrently and rejects an overlapping group without polluting either owner or an unclaimed room', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-mf-overlap-'));
  const databasePath = path.join(root, 'owners.sqlite3');
  const a = { ...group, roomIds: [group.roomIds[0]!] },
    b = { ...group, roomIds: [group.roomIds[1]!] };
  const c = `${workspaceId}:mf:machine-c`;
  const overlapping = { ...group, roomIds: [...group.roomIds, c] };
  const idb = new IDBFactory();
  const arrivedA = signal(),
    arrivedB = signal(),
    release = signal();
  const first = await selectedFixture(a, databasePath, idb, async () => {
    arrivedA.resolve();
    await release.promise;
  });
  const second = await selectedFixture(b, databasePath, idb, async () => {
    arrivedB.resolve();
    await release.promise;
  });
  const collision = await selectedFixture(overlapping, databasePath, idb);
  let third: Awaited<ReturnType<typeof selectedFixture>> | undefined;
  let pending: Array<Promise<unknown>> = [];
  const readRows = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return {
        owners: db.prepare('SELECT * FROM renderer_flock_group_owners ORDER BY scope').all(),
        rooms: db.prepare('SELECT * FROM renderer_flock_group_rooms ORDER BY room_id').all(),
      };
    } finally {
      db.close();
    }
  };
  try {
    const freezeA = first.main.freeze(),
      freezeB = second.main.freeze();
    pending = [freezeA, freezeB];
    await Promise.all([arrivedA.promise, arrivedB.promise]);
    expect(first.main.status().owner).toBe('frozen');
    expect(second.main.status().owner).toBe('frozen');
    const before = readRows();
    await expect(collision.main.freeze()).rejects.toThrow(/overlaps another/);
    expect(
      () =>
        new RendererFlockRoomGroupMigrationMainLegacy({
          group: overlapping,
          databasePath,
          registeredWindowIds: () => [1],
          readCommittedOwner: async () => 'legacy',
          send: () => {},
        })
    ).toThrow(/overlaps another/);
    expect(readRows()).toEqual(before);
    expect(before.owners).toHaveLength(2);
    expect(before.rooms).toHaveLength(2);
    release.resolve();
    const [receiptA, receiptB] = await Promise.all([freezeA, freezeB]);
    first.native();
    second.native();
    await Promise.all([
      first.main.complete(receiptA.revision),
      second.main.complete(receiptB.revision),
    ]);
    third = await selectedFixture({ ...group, roomIds: [c] }, databasePath, idb);
    expect(third.main.status().owner).toBe('legacy');
    const receiptC = await third.main.freeze();
    third.native();
    await third.main.complete(receiptC.revision);
    expect(readRows().owners).toHaveLength(3);
    expect(readRows().rooms).toHaveLength(3);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    await Promise.allSettled([first.close(), second.close(), collision.close(), third?.close()]);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('adopts the unpublished domain-scoped marker atomically without losing its frozen generation or blocking another machine', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-mf-marker-adopt-'));
  const databasePath = path.join(root, 'owners.sqlite3');
  const a = { ...group, roomIds: [group.roomIds[0]!] },
    b = { ...group, roomIds: [group.roomIds[1]!] };
  const oldScope = JSON.stringify([a.accountId, a.workspaceId, a.domain, a.contentMode]);
  const seed = new DatabaseSync(databasePath);
  seed.exec(
    'CREATE TABLE renderer_flock_group_owners(scope TEXT PRIMARY KEY,group_json TEXT NOT NULL,revision TEXT NOT NULL,owner TEXT NOT NULL) WITHOUT ROWID'
  );
  seed
    .prepare('INSERT INTO renderer_flock_group_owners VALUES (?,?,?,?)')
    .run(oldScope, rendererFlockGroupKey(a), 'old-frozen-generation', 'frozen');
  seed.close();
  const options = {
    databasePath,
    registeredWindowIds: () => [1],
    readCommittedOwner: async () => 'legacy' as const,
    send: () => {},
  };
  const first = new RendererFlockRoomGroupMigrationMainLegacy({ ...options, group: a });
  const second = new RendererFlockRoomGroupMigrationMainLegacy({ ...options, group: b });
  try {
    expect(first.status()).toMatchObject({ owner: 'frozen', revision: 'old-frozen-generation' });
    expect(second.status().owner).toBe('legacy');
    const read = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        read.prepare('SELECT scope,revision,owner FROM renderer_flock_group_owners').all()
      ).toEqual([
        { scope: rendererFlockGroupScope(a), revision: 'old-frozen-generation', owner: 'frozen' },
      ]);
      expect(read.prepare('SELECT room_id FROM renderer_flock_group_rooms').all()).toEqual([
        { room_id: a.roomIds[0] },
      ]);
    } finally {
      read.close();
    }
  } finally {
    first.close();
    second.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('exports every selected MF room and explicit SR absence from real IDB without rewriting CRDT clocks, tombstones or queues', async () => {
  const idb = new IDBFactory();
  const store = adapter(idb, name);
  const old = new Flock();
  old.put(['gone'], 'old device', 100);
  const changed = Flock.strictFromFile(old.exportFile());
  changed.delete(['gone'], 200);
  changed.put(['future', 'opaque'], { unknown: [1, { yes: true }] }, 201);
  try {
    await store.save({
      type: 'flock-doc-snapshot',
      flockDocId: group.roomIds[0]!,
      snapshot: old.exportFile(),
    });
    await store.save({
      type: 'flock-doc-update',
      flockDocId: group.roomIds[0]!,
      update: new TextEncoder().encode(JSON.stringify(changed.exportJson())),
    });
    const before = await dump(idb, name);
    const inventory = await captureFrozenRendererFlockRoomGroup({
      group,
      indexedDB: idb,
      freezeAndDrainAllWindows: async () => {},
    });
    expect(inventory.map((room) => room.present)).toEqual([true, false]);
    const merged = Flock.strictFromFile(inventory[0]!.sources[0]!.snapshot);
    merged.strictImportFile(old.exportFile());
    expect(merged.get(['gone'])).toBeUndefined();
    expect(merged.get(['future', 'opaque'])).toEqual({ unknown: [1, { yes: true }] });
    expect(inventory[1]!.sources[0]!.present).toBe(false);
    expect(Flock.strictFromFile(inventory[1]!.sources[0]!.snapshot).get(['gone'])).toBeUndefined();
    const sr = await captureFrozenRendererFlockRoomGroup({
      group: schedule,
      indexedDB: idb,
      freezeAndDrainAllWindows: async () => {},
    });
    expect(sr[0]!.present).toBe(false);
    expect(await dump(idb, name)).toEqual(before);
    const unselected = await captureFrozenRendererFlockRoomGroup({
      group: { ...group, roomIds: [group.roomIds[1]!] },
      indexedDB: idb,
      freezeAndDrainAllWindows: async () => {},
    });
    expect(unselected).toHaveLength(1);
    expect(unselected[0]!.roomId).toBe(group.roomIds[1]);
    expect(unselected[0]!.present).toBe(false);
    expect(await dump(idb, name)).toEqual(before);
    expect(() =>
      validateRendererFlockGroupInventory({ ...group, roomIds: [group.roomIds[1]!] }, inventory)
    ).toThrow(/every exact/);
    const empty = await captureFrozenRendererFlockRoomGroup({
      group,
      indexedDB: new IDBFactory(),
      freezeAndDrainAllWindows: async () => {},
    });
    expect(empty).toEqual(group.roomIds.map((roomId) => ({ roomId, present: false, sources: [] })));
    expect(() => validateRendererFlockGroupInventory(group, empty.slice(0, 1))).toThrow(
      /every exact/
    );
    expect(() =>
      rendererFlockGroupSchema.parse({ ...group, roomIds: [`${workspaceId}:wf:workspace`] })
    ).toThrow();
    expect(() => rendererFlockGroupSchema.parse({ ...schedule, roomIds: group.roomIds })).toThrow();
  } finally {
    await store.close();
  }
});

it('drains two real Repo windows, both MF transports and admitted persistence before per-window complete group inventories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-mf-group-'));
  const idb = new IDBFactory();
  const gates = new Map<number, RendererFlockRoomGroupFreeze>();
  const stores: IndexedDBStorageAdaptor[] = [];
  const repos: LoroRepo[] = [];
  const detached = [signal(), signal()];
  const live = new Set<string>();
  let captureStarted = false;
  let committed: 'legacy' | 'native' = 'legacy';
  const admitted = signal(),
    release = signal();
  let writing: Promise<void> | undefined;
  const main = new RendererFlockRoomGroupMigrationMainLegacy({
    group,
    databasePath: path.join(root, 'owners.sqlite3'),
    registeredWindowIds: () => [1, 2],
    readCommittedOwner: async () => committed,
    send: async (id, message) => {
      if (message.phase === 'capture') captureStarted = true;
      main.acceptAck(id, await gates.get(id)!.handle(message));
    },
    publishOwner: (id, owner) => gates.get(id)!.published(owner),
  });
  try {
    for (const id of [1, 2]) {
      const storage = adapter(idb, `${name}:window-${id}`);
      stores.push(storage);
      let gate: RendererFlockRoomGroupFreeze | undefined;
      const repo = await LoroRepo.create({
        storageAdapter: storage,
        metaDebounceCommitMs: 0,
        resolveRoomTransports: (room) => ({
          transportIds:
            room.kind === 'flock-doc' && !gate?.shouldRoute(room.id) ? [] : ['synthetic'],
        }),
      });
      repos.push(repo);
      const ports = createRendererFlockGroupRepoFreezePorts(repo, group);
      gate = new RendererFlockRoomGroupFreeze(group, {
        indexedDB: idb,
        readStartupOwner: async () => {
          const reg = main.register(id, main.beginRegistration(id));
          gate!.bindRegistration(reg.registrationId);
          return main.ready(id, reg.registrationId);
        },
        persistRooms: ports.persistRooms,
        detachRooms: async () => {
          await ports.detachRooms();
          detached[id - 1]!.resolve();
        },
      });
      gates.set(id, gate);
      await gate.startup();
      const sub = (roomId: string) => {
        const key = `${id}:${roomId}`;
        live.add(key);
        return {
          unsubscribe: () => {
            live.delete(key);
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
        joinMetaRoom: () => sub('meta'),
        joinDocRoom: sub,
        joinFlockDocRoom: sub,
      });
      for (const roomId of group.roomIds) {
        const handle = await repo.openFlockDoc(roomId);
        handle.flock.put(['unknown', `window-${id}`], { from: id }, id + 10);
        handle.flock.commit();
        await gate.observe(
          roomId,
          async (update) => {
            const joined = await handle.joinRoom();
            const unsubscribe = handle.flock.subscribe(() => update(handle.flock.get(['unknown'])));
            return {
              close() {
                unsubscribe();
                joined.unsubscribe();
              },
            };
          },
          () => {}
        );
      }
    }
    expect(live.has(`1:${group.roomIds[0]}`)).toBe(true);
    expect(live.has(`2:${group.roomIds[1]}`)).toBe(true);
    writing = gates.get(1)!.run(group.roomIds[1]!, async () => {
      admitted.resolve();
      await release.promise;
      const handle = await repos[0]!.openFlockDoc(group.roomIds[1]!);
      handle.flock.put(['late-admitted'], { persisted: true }, 999);
      handle.flock.commit();
    });
    await admitted.promise;
    const freezing = main.freeze();
    await Promise.all(detached.map((item) => item.promise));
    expect(captureStarted).toBe(false);
    for (const id of [1, 2])
      for (const roomId of group.roomIds) {
        expect(live.has(`${id}:${roomId}`)).toBe(false);
        await expect(gates.get(id)!.run(roomId, () => 'forbidden')).rejects.toThrow(/frozen/);
      }
    expect(await gates.get(1)!.run(schedule.roomIds[0]!, () => 'unrelated available')).toBe(
      'unrelated available'
    );
    release.resolve();
    await writing;
    const receipt = await freezing;
    expect(receipt.windows).toHaveLength(2);
    for (const frame of receipt.windows) {
      expect(frame.inventory.map((room) => room.roomId)).toEqual(group.roomIds);
      for (const room of frame.inventory) {
        expect(room.sources).toHaveLength(2);
        const merged = new Flock();
        for (const source of room.sources) merged.strictImportFile(source.snapshot);
        expect(merged.get(['unknown', 'window-2'])).toEqual({ from: 2 });
        if (room.roomId === group.roomIds[1])
          expect(merged.get(['late-admitted'])).toEqual({ persisted: true });
      }
    }
    await expect(main.complete(receipt.revision)).rejects.toThrow(/not durably native/);
    expect(main.status().owner).toBe('frozen');
    committed = 'native';
    await main.complete(receipt.revision);
    await main.complete(receipt.revision);
    expect(main.status().owner).toBe('native');
    for (const gate of gates.values()) {
      expect(gate.ownerKind()).toBe('native');
      expect(gate.shouldRoute(group.roomIds[0]!)).toBe(false);
      expect(() =>
        gate.published({ ...main.status(), registrationId: '11111111-1111-4111-8111-111111111111' })
      ).toThrow(/does not match/);
    }
  } finally {
    release.resolve();
    if (writing) await Promise.allSettled([writing]);
    await Promise.allSettled([...gates.values()].map((gate) => gate.close()));
    for (const repo of repos) await repo.destroy();
    for (const store of stores) await store.close();
    main.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'waits for a newly created window registration before durable group freeze (preflight=%s)',
  async (preflight) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-group-window-startup-'));
    const selected = { ...group, roomIds: [group.roomIds[0]!] };
    const idb = new IDBFactory();
    const ids = [1, 2];
    const gates = new Map<number, RendererFlockRoomGroupFreeze>();
    const stores: IndexedDBStorageAdaptor[] = [];
    const repos: LoroRepo[] = [];
    let native = false;
    let freezing: Promise<unknown> | undefined;
    const main = new RendererFlockRoomGroupMigrationMainLegacy({
      group: selected,
      databasePath: path.join(root, 'owners.sqlite3'),
      preflight,
      registeredWindowIds: () => ids,
      readCommittedOwner: async () => (native ? 'native' : 'legacy'),
      send: async (id, message) => main.acceptAck(id, await gates.get(id)!.handle(message)),
      publishOwner: (id, owner) => gates.get(id)!.published(owner),
    });
    try {
      // The auxiliary BrowserWindow already exists, but its renderer has not yet
      // registered. Its real persisted data must still join the complete capture.
      for (const id of ids) {
        const storage = adapter(idb, `${name}:startup-${id}`);
        stores.push(storage);
        const repo = await LoroRepo.create({ storageAdapter: storage, metaDebounceCommitMs: 0 });
        repos.push(repo);
        const handle = await repo.openFlockDoc(selected.roomIds[0]!);
        handle.flock.put(['window', String(id)], { from: id }, id);
        handle.flock.commit();
        await repo.flush();
        const ports = createRendererFlockGroupRepoFreezePorts(repo, selected);
        const gate = new RendererFlockRoomGroupFreeze(selected, {
          ...ports,
          indexedDB: idb,
          readStartupOwner: async () => {
            const registration = main.register(id, main.beginRegistration(id));
            gates.get(id)!.bindRegistration(registration.registrationId);
            return main.ready(id, registration.registrationId);
          },
        });
        gates.set(id, gate);
      }
      await gates.get(1)!.startup();
      const canceled = new AbortController();
      const incomplete = main.freeze(canceled.signal);
      const refused = expect(incomplete).rejects.toThrow('Synthetic registration wait canceled');
      canceled.abort(new Error('Synthetic registration wait canceled'));
      await refused;
      expect(main.status().owner).toBe('legacy');
      freezing = main.freeze();
      void freezing.catch(() => {});
      // No complete participant set yet: the actual first window remains legacy
      // and writable, instead of being stranded by an early frozen marker.
      expect(main.status().owner).toBe('legacy');
      await gates.get(1)!.run(selected.roomIds[0]!, async () => {
        const handle = await repos[0]!.openFlockDoc(selected.roomIds[0]!);
        handle.flock.put(['before-second-ready'], true, 100);
        handle.flock.commit();
        await repos[0]!.flush();
      });
      await gates.get(2)!.startup();
      const receipt = (await freezing) as Awaited<ReturnType<typeof main.freeze>>;
      expect(receipt.windows.map((row) => row.windowId).sort()).toEqual([1, 2]);
      const merged = new Flock();
      for (const source of receipt.windows[0]!.inventory[0]!.sources)
        merged.strictImportFile(source.snapshot);
      expect(merged.get(['window', '2'])).toEqual({ from: 2 });
      expect(merged.get(['before-second-ready'])).toBe(true);
      native = true;
      await main.complete(receipt.revision);
      ids.push(3);
      const later = main.register(3, main.beginRegistration(3));
      expect(later.owner).toBe('native');
      expect(main.ready(3, later.registrationId).owner).toBe('native');
      expect(main.status().revision).toBe(receipt.revision);
      await expect(main.freeze()).rejects.toThrow(/already active or native/);
    } finally {
      main.close();
      if (freezing) await Promise.allSettled([freezing]);
      await Promise.allSettled([...gates.values()].map((gate) => gate.close()));
      for (const repo of repos) await repo.destroy();
      for (const store of stores) await store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

it('persists exact-set maintenance across restart and refuses overlapping sets, late registrations and retired witnesses', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sr-group-'));
  const ids = [1];
  let requestInFlight: RendererFlockGroupRequest | undefined;
  const sent = signal();
  const options = {
    group: schedule,
    databasePath: path.join(root, 'owners.sqlite3'),
    registeredWindowIds: () => ids,
    readCommittedOwner: async () => 'legacy' as const,
    send: (_id: number, request: RendererFlockGroupRequest) => {
      requestInFlight = request;
      sent.resolve();
    },
  };
  const main = new RendererFlockRoomGroupMigrationMainLegacy(options);
  let restarted: RendererFlockRoomGroupMigrationMainLegacy | undefined;
  try {
    const obsolete = main.beginRegistration(1),
      current = main.beginRegistration(1);
    expect(() => main.register(1, obsolete)).toThrow(/attempt retired/);
    const registration = main.register(1, current);
    main.ready(1, registration.registrationId);
    const freezing = main.freeze();
    void freezing.catch(() => {});
    await sent.promise;
    const oldRevision = requestInFlight!.revision;
    main.retire(1, registration.registrationId);
    await expect(freezing).rejects.toThrow(/retired/);
    expect(main.status().owner).toBe('frozen');
    expect(main.status().revision).not.toBe(oldRevision);
    main.close();
    restarted = new RendererFlockRoomGroupMigrationMainLegacy(options);
    const fresh = restarted.register(1, restarted.beginRegistration(1));
    expect(fresh.owner).toBe('frozen');
    expect(fresh.revision).not.toBe(oldRevision);
    const gate = new RendererFlockRoomGroupFreeze(schedule, {
      readStartupOwner: async () => ({
        group: fresh.group,
        revision: fresh.revision,
        owner: fresh.owner,
      }),
      detachRooms: async () => {},
      persistRooms: async () => {},
    });
    gate.bindRegistration(fresh.registrationId);
    await gate.startup();
    await expect(gate.run(schedule.roomIds[0]!, () => 'forbidden')).rejects.toThrow(/frozen/);
    restarted.retire(1, registration.registrationId); // Old ticket cannot retire the new owner.
    expect(restarted.ready(1, fresh.registrationId).owner).toBe('frozen');
    expect(() =>
      restarted!.acceptAck(1, { ...requestInFlight, registrationId: registration.registrationId })
    ).toThrow(/registration retired/);
    await gate.close();
    const mf = new RendererFlockRoomGroupMigrationMainLegacy({ ...options, group });
    try {
      mf.register(1, mf.beginRegistration(1));
      const abort = new AbortController();
      abort.abort();
      await expect(mf.freeze(abort.signal)).rejects.toThrow();
      expect(
        () =>
          new RendererFlockRoomGroupMigrationMainLegacy({
            ...options,
            group: { ...group, roomIds: [group.roomIds[0]!] },
          })
      ).toThrow(/overlaps another/i);
    } finally {
      mf.close();
    }
  } finally {
    main.close();
    restarted?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('accepts a complete empty per-room inventory and rejects excessive binary inventory without clearing the group fence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-group-budget-'));
  const idb = new IDBFactory();
  let excessive = false;
  let gate!: RendererFlockRoomGroupFreeze;
  const main = new RendererFlockRoomGroupMigrationMainLegacy({
    group: schedule,
    databasePath: path.join(root, 'owners.sqlite3'),
    registeredWindowIds: () => [1],
    readCommittedOwner: async () => 'legacy',
    send: async (_id, req) => {
      const ack = await gate.handle(req);
      if (excessive && req.phase === 'capture')
        ack.inventory![0]!.sources = [
          {
            dbName: name,
            sourceId: `renderer-idb:loro-repo@0.25.0:${name}`,
            present: false,
            snapshot: new Uint8Array(FLOCK_GROUP_MAX_BYTES + 1),
          },
        ];
      main.acceptAck(1, ack);
    },
  });
  gate = new RendererFlockRoomGroupFreeze(schedule, {
    indexedDB: idb,
    readStartupOwner: async () => {
      const reg = main.register(1, main.beginRegistration(1));
      gate.bindRegistration(reg.registrationId);
      return main.ready(1, reg.registrationId);
    },
    detachRooms: async () => {},
    persistRooms: async () => {},
  });
  try {
    await gate.startup();
    const receipt = await main.freeze();
    expect(receipt.windows[0]!.inventory).toEqual([
      { roomId: schedule.roomIds[0], present: false, sources: [] },
    ]);
    main.assertFrozen(receipt.revision);
    excessive = true;
    await expect(main.freeze()).rejects.toThrow();
    expect(main.status().owner).toBe('frozen');
    expect(() => main.assertFrozen(receipt.revision)).toThrow(/absent or retired/);
  } finally {
    await gate.close();
    main.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('does not reuse a WF freeze or let an old capture ACK invalidate a new group generation; a new frame retires its persistent witness', async () => {
  const { RendererWorkspaceFlockMigrationMainLegacy } =
    await import('../../../apps/electron/src/main/services/renderer-workspace-flock-migration');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-group-generation-'));
  const databasePath = path.join(root, 'owners.sqlite3');
  const wfBinding = {
    accountId: group.accountId,
    workspaceId,
    roomId: `${workspaceId}:wf:workspace`,
    contentMode: 'plaintext' as const,
  };
  const wf = new RendererWorkspaceFlockMigrationMainLegacy({
    databasePath,
    registeredWindowIds: () => [],
    send: () => {},
    readCommittedOwner: async () => 'legacy',
  });
  const ids = [1];
  let oldCapture: RendererFlockGroupRequest | undefined;
  const captured = signal();
  const inventory = group.roomIds.map((roomId) => ({ roomId, present: false, sources: [] }));
  let holdCapture = true;
  const main = new RendererFlockRoomGroupMigrationMainLegacy({
    group,
    databasePath,
    registeredWindowIds: () => ids,
    readCommittedOwner: async () => 'legacy',
    send: (_id, req) => {
      if (req.phase === 'capture' && holdCapture) {
        oldCapture = req;
        captured.resolve();
        return;
      }
      main.acceptAck(1, req.phase === 'freeze' ? req : { ...req, inventory });
    },
  });
  let restarted: RendererFlockRoomGroupMigrationMainLegacy | undefined;
  try {
    const abort = new AbortController();
    abort.abort();
    await expect(wf.freeze(wfBinding, abort.signal)).rejects.toThrow();
    expect(wf.status(wfBinding).owner).toBe('frozen');
    expect(main.status().owner).toBe('legacy');
    const registration = main.register(1, main.beginRegistration(1));
    main.ready(1, registration.registrationId);
    const cancellation = new AbortController();
    const first = main.freeze(cancellation.signal);
    void first.catch(() => {});
    await captured.promise;
    cancellation.abort(new Error('First capture retired'));
    await expect(first).rejects.toThrow(/retired/);
    holdCapture = false;
    const second = await main.freeze();
    expect(second.revision).not.toBe(oldCapture!.revision);
    expect(() => main.acceptAck(1, { ...oldCapture, inventory })).toThrow(/Unknown/);
    main.assertFrozen(second.revision);
    ids.push(2);
    const newcomer = main.register(2, main.beginRegistration(2));
    expect(newcomer.owner).toBe('frozen');
    expect(newcomer.revision).not.toBe(second.revision);
    expect(() => main.assertFrozen(second.revision)).toThrow(/absent or retired/);
    main.close();
    restarted = new RendererFlockRoomGroupMigrationMainLegacy({
      group,
      databasePath,
      registeredWindowIds: () => ids,
      readCommittedOwner: async () => 'legacy',
      send: () => {},
    });
    expect(restarted.status().owner).toBe('frozen');
    expect(restarted.status().revision).toBe(newcomer.revision);
    expect(wf.status(wfBinding).owner).toBe('frozen');
  } finally {
    wf.close();
    main.close();
    restarted?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('retains a failed actual observer release, detaches independent transport and retries the same owner without reopening legacy', async () => {
  const flock = new Flock();
  const updates: unknown[] = [];
  let refused = true;
  let observerOpen = false;
  let transportConnected = true;
  const gate = new RendererFlockRoomGroupFreeze(schedule, {
    readStartupOwner: async () => ({
      group: schedule,
      owner: 'legacy',
      revision: 'legacy-group-v1',
    }),
    detachRooms: async () => {
      transportConnected = false;
    },
    persistRooms: async () => {},
    indexedDB: new IDBFactory(),
  });
  await gate.startup();
  await gate.observe(
    schedule.roomIds[0]!,
    async (update) => {
      observerOpen = true;
      const unsubscribe = flock.subscribe(() => update(flock.get(['value'])));
      return {
        close() {
          if (refused) throw new Error('Synthetic subscription release failure');
          unsubscribe();
          observerOpen = false;
        },
      };
    },
    (value) => updates.push(value)
  );
  const { randomUUID } = await import('node:crypto');
  const req = {
    group: schedule,
    phase: 'freeze' as const,
    revision: 'freeze-1',
    requestId: randomUUID(),
    registrationId: randomUUID(),
  };
  gate.bindRegistration(req.registrationId);
  try {
    flock.put(['value'], 'before');
    flock.commit();
    expect(updates).toEqual(['before']);
    await expect(gate.handle(req)).rejects.toThrow(/drain failed/);
    expect(observerOpen).toBe(true);
    expect(transportConnected).toBe(false);
    flock.put(['value'], 'late');
    flock.commit();
    expect(updates).toEqual(['before']); // Retained callback fenced immediately.
    await expect(gate.run(schedule.roomIds[0]!, () => 'unsafe')).rejects.toThrow(/frozen/);
    refused = false;
    await gate.handle({ ...req, revision: 'freeze-2', requestId: randomUUID() });
    expect(observerOpen).toBe(false);
    await expect(gate.run(schedule.roomIds[0]!, () => 'unsafe')).rejects.toThrow(/frozen/);
  } finally {
    refused = false;
    await gate.close();
  }
});

it('reports a late observer-open release failure to the waiting freeze and retries that retained subscription on the next generation', async () => {
  const { randomUUID } = await import('node:crypto');
  const flock = new Flock();
  const opened = signal(),
    allowOpen = signal(),
    detached = signal();
  let open = false,
    refuseClose = true;
  const gate = new RendererFlockRoomGroupFreeze(schedule, {
    readStartupOwner: async () => ({
      group: schedule,
      owner: 'legacy',
      revision: 'legacy-group-v1',
    }),
    detachRooms: async () => {
      detached.resolve();
    },
    persistRooms: async () => {},
    indexedDB: new IDBFactory(),
  });
  const registrationId = randomUUID();
  gate.bindRegistration(registrationId);
  await gate.startup();
  const observer = gate.observe(
    schedule.roomIds[0]!,
    async (update) => {
      const unsubscribe = flock.subscribe(() => update(flock.get(['value'])));
      open = true;
      opened.resolve();
      await allowOpen.promise;
      return {
        close() {
          if (refuseClose) throw new Error('Late observer could not unsubscribe');
          unsubscribe();
          open = false;
        },
      };
    },
    () => {}
  );
  void observer.catch(() => {});
  await opened.promise;
  const request = {
    group: schedule,
    revision: 'late-open-1',
    phase: 'freeze' as const,
    requestId: randomUUID(),
    registrationId,
  };
  const freezing = gate.handle(request);
  void freezing.catch(() => {});
  try {
    await detached.promise;
    allowOpen.resolve();
    await expect(observer).rejects.toThrow(/could not unsubscribe/);
    await expect(freezing).rejects.toThrow(/observer release failed/);
    expect(open).toBe(true);
    refuseClose = false;
    await gate.handle({ ...request, revision: 'late-open-2', requestId: randomUUID() });
    expect(open).toBe(false);
    await expect(gate.run(schedule.roomIds[0]!, () => 'forbidden')).rejects.toThrow(/frozen/);
  } finally {
    refuseClose = false;
    allowOpen.resolve();
    await Promise.allSettled([observer, freezing]);
    await gate.close();
  }
});

it('vetoes another machine in a readonly Meta preflight before changing the durable group owner or legacy admission', async () => {
  const idb = new IDBFactory();
  const selected = { ...group, roomIds: [group.roomIds[0]!] };
  const storage = adapter(idb, name);
  const repo = await LoroRepo.create({ storageAdapter: storage });
  repo.getMeta().put(['m', 'agent-other'], {
    id: 'other',
    machineId: 'machine-b',
    name: 'Other owner',
    cliType: 'custom',
    agentType: 'custom',
    env: { TOKEN: 'SYNTHETIC' },
  });
  await repo.flush();
  await repo.destroy();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-mf-preflight-'));
  let gate!: RendererFlockRoomGroupFreeze;
  const pending = new Set<Promise<void>>();
  const main = new RendererFlockRoomGroupMigrationMainLegacy({
    group: selected,
    databasePath: path.join(root, 'owners.sqlite3'),
    preflight: true,
    registeredWindowIds: () => [1],
    readCommittedOwner: async () => 'legacy',
    send(_id, message) {
      const work = gate.handle(message).then((ack) => {
        main.acceptAck(1, ack);
      });
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => {});
    },
  });
  try {
    const registration = main.register(1, main.beginRegistration(1));
    main.ready(1, registration.registrationId);
    gate = new RendererFlockRoomGroupFreeze(selected, {
      indexedDB: idb,
      readStartupOwner: async () => ({
        group: registration.group,
        owner: registration.owner,
        revision: registration.revision,
      }),
      detachRooms: async () => {},
      persistRooms: async () => {},
    });
    gate.bindRegistration(registration.registrationId);
    await gate.startup();
    await expect(main.freeze()).rejects.toThrow(/single-machine/);
    expect(main.status().owner).toBe('legacy');
    expect(gate.shouldRoute(selected.roomIds[0]!)).toBe(true);
    expect(await gate.run(selected.roomIds[0]!, () => 'legacy remains available')).toBe(
      'legacy remains available'
    );
    await Promise.all(pending);
  } finally {
    await gate?.close();
    main.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('captures complete renderer Meta with each MF source and never persists the old replica again after native publication', async () => {
  const idb = new IDBFactory();
  const selected = { ...group, roomIds: [group.roomIds[0]!] };
  const storage = adapter(idb, name);
  const repo = await LoroRepo.create({ storageAdapter: storage });
  repo.getMeta().put(['m', 'agent-a'], {
    machineId: 'machine-a',
    unknown: { retained: true },
    env: { TOKEN: 'SYNTHETIC' },
  });
  repo.getMeta().put(['m', 'agent-deleted'], { machineId: 'machine-a' }, 1);
  repo.getMeta().delete(['m', 'agent-deleted'], 2);
  await repo.flush();
  await repo.destroy();
  const inventory = await captureFrozenRendererFlockRoomGroup({
    group: selected,
    indexedDB: idb,
    freezeAndDrainAllWindows: async () => {},
  });
  const meta = Flock.strictFromFile(inventory[0]!.sources[0]!.metaSnapshot!);
  expect(meta.get(['m', 'agent-a'])).toMatchObject({
    unknown: { retained: true },
    env: { TOKEN: 'SYNTHETIC' },
  });
  expect(meta.get(['m', 'agent-deleted'])).toBeUndefined();
  const old = new Flock('old-offline');
  old.put(['m', 'agent-deleted'], { machineId: 'machine-a' }, 1);
  meta.strictImportFile(old.exportFile());
  expect(meta.get(['m', 'agent-deleted'])).toBeUndefined();
  let persistence = 'before-freeze';
  const registration = '11111111-1111-4111-8111-111111111111';
  const gate = new RendererFlockRoomGroupFreeze(selected, {
    indexedDB: idb,
    readStartupOwner: async () => ({ group: selected, owner: 'legacy', revision: 'legacy' }),
    detachRooms: async () => {},
    persistRooms: async () => {
      if (persistence !== 'before-freeze')
        throw new Error('Retired legacy persistence was reopened');
      persistence = 'final-frozen-snapshot';
    },
  });
  gate.bindRegistration(registration);
  await gate.startup();
  await gate.handle({
    group: selected,
    revision: 'frozen-revision',
    registrationId: registration,
    requestId: '22222222-2222-4222-8222-222222222222',
    phase: 'freeze',
  });
  gate.published({
    group: selected,
    revision: 'frozen-revision',
    registrationId: registration,
    owner: 'native',
  });
  await gate.close();
  expect(persistence).toBe('final-frozen-snapshot');
});

it('captures the independent whole-Meta scope without named-room reads or i64 rounding and leaves every source byte unchanged', async () => {
  const idb = new IDBFactory();
  const metadata: RendererFlockGroup = { ...group, domain: 'meta', roomIds: ['meta'] };
  const repo = await LoroRepo.create({ storageAdapter: adapter(idb, name) });
  repo.getMeta().put(['m', 'retained'], { unknown: { keep: true } }, 1);
  repo.getMeta().put(['m', 'deleted'], { old: true }, 1);
  repo.getMeta().delete(['m', 'deleted'], 2);
  await repo.flush();
  await repo.destroy();
  const capture = () =>
    captureFrozenRendererFlockRoomGroup({
      group: metadata,
      indexedDB: idb,
      freezeAndDrainAllWindows: async () => {},
    });
  const baseline = (await capture())[0]!.sources[0]!.snapshot;
  const queued = new Flock('queued-meta');
  queued.put(['m', 'i64'], 1, 3);
  const bundle = queued.exportJson();
  const json = JSON.stringify(bundle).replace('"d":1}', '"d":9007199254740993}');
  const completeBundle = structuredClone(bundle) as { entries: Record<string, { d: unknown }> };
  Object.values(completeBundle.entries)[0]!.d = 9007199254740993n;
  const expected = new Flock('capture-proof');
  expected.strictImportFile(baseline);
  expected.importJson(completeBundle as Parameters<Flock['importJson']>[0]);
  const db = await request(idb.open(name));
  try {
    const tx = db.transaction(['meta-updates', 'flock-docs'], 'readwrite');
    const complete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    tx.objectStore('meta-updates').put(new TextEncoder().encode(json), 'synthetic-json-update');
    // An unrelated unsupported room is outside the Meta witness and must stay untouched.
    tx.objectStore('flock-docs').put(new Uint8Array([255]), group.roomIds[0]!);
    await complete;
  } finally {
    db.close();
  }
  const before = await dump(idb, name);
  const result = await capture();
  expect(result.map((row) => row.roomId)).toEqual(['meta']);
  const actual = new Flock('capture-proof');
  actual.strictImportFile(result[0]!.sources[0]!.snapshot);
  expect(actual.exportFile()).toEqual(expected.exportFile());
  expect(actual.get(['m', 'retained'])).toEqual({ unknown: { keep: true } });
  expect(actual.get(['m', 'deleted'])).toBeUndefined();
  expect(await dump(idb, name)).toEqual(before);
  expect(rendererFlockGroupScope(metadata)).not.toBe(rendererFlockGroupScope(group));
});

it('freezes one actual Session in every window before capturing all IDB bases/logs while unrelated Sessions remain writable', async () => {
  const { LoroDoc } = await import('loro-crdt');
  const { RendererSessionBodyFreeze } =
    await import('../src/providers/renderer-session-body-migration');
  const { RendererSessionBodyMigrationMainLegacy } =
    await import('../../../apps/electron/src/main/services/renderer-session-body-migration');
  const idb = new IDBFactory(),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-session-window-freeze-'));
  const storages = [
    adapter(idb, name),
    adapter(idb, `${name}:window-a`),
    adapter(idb, `${name}:empty`),
  ];
  const repositories = await Promise.all(
    storages.map((storage) => LoroRepo.create({ storageAdapter: storage }))
  );
  const sessionId = 'synthetic-session',
    roomId = `session-${sessionId}`;
  const base = await repositories[0]!.openPersistedDoc(roomId);
  base.doc.getMap('session').set('id', sessionId);
  base.doc.getText('future').insert(0, 'before');
  base.doc.getMap('opaque').set('unknown', { retained: true });
  base.doc.commit();
  await repositories[0]!.persistDocNow(roomId, base.doc);
  const other = await repositories[0]!.openPersistedDoc('session-independent');
  other.doc.getText('future').insert(0, 'independent');
  other.doc.commit();
  await repositories[0]!.persistDocNow('session-independent', other.doc);
  const writing = signal(),
    release = signal(),
    freezing = signal();
  let owner: 'frozen' | 'native' = 'frozen';
  const binding = { accountId: 'local:fixture', workspaceId, contentMode: 'plaintext' as const };
  const registrations = new Map([
    [1, '11111111-1111-4111-8111-111111111111'],
    [2, '22222222-2222-4222-8222-222222222222'],
  ]);
  const gates = new Map<number, InstanceType<typeof RendererSessionBodyFreeze>>();
  let main!: InstanceType<typeof RendererSessionBodyMigrationMainLegacy>;
  for (const windowId of registrations.keys())
    gates.set(
      windowId,
      new RendererSessionBodyFreeze({
        indexedDB: idb,
        beginFreeze() {
          freezing.resolve();
        },
        async drainLegacySession(id) {
          const repo = repositories[windowId - 1]!;
          await repo.flush();
          await repo.unloadDoc(`session-${id}`);
        },
      })
    );
  main = new RendererSessionBodyMigrationMainLegacy({
    binding,
    databasePath: path.join(directory, 'fences.sqlite3'),
    admit(window, registration) {
      if (registrations.get(window) !== registration) throw new Error('Foreign window');
    },
    registeredWindowIds: () => [...registrations.keys()],
    readCommittedOwner: () => owner,
    send(window, message) {
      void gates
        .get(window)!
        .handle(message)
        .then((ack) => main.acknowledge(window, ack));
    },
  });
  for (const [window, registration] of registrations) {
    gates.get(window)!.bind(main.register(window, registration));
    main.ready(window, registration);
  }
  const operation = gates.get(1)!.run(sessionId, async () => {
    writing.resolve();
    await release.promise;
    base.doc.getText('future').insert(6, ':accepted-before-freeze');
    base.doc.commit();
    await repositories[0]!.persistDocNow(roomId, base.doc);
  });
  await writing.promise;
  await main.enumerate(sessionId);
  const capture = main.freezeAndCapture(sessionId, 'revision-1');
  await freezing.promise;
  try {
    await expect(
      gates.get(1)!.run(sessionId, () => {
        base.doc.getText('future').insert(0, 'forbidden');
      })
    ).rejects.toThrow('frozen');
    await gates.get(1)!.run('independent', async () => {
      other.doc.getText('future').insert(11, ':still-usable');
      other.doc.commit();
      await repositories[0]!.persistDocNow('session-independent', other.doc);
    });
    release.resolve();
    await operation;
    const receipt = await capture;
    main.assertFrozen(receipt);
    expect(receipt.sources).toHaveLength(3);
    const present = receipt.sources.filter((source) => source.present);
    expect(present).toHaveLength(1);
    const frozen = LoroDoc.fromSnapshot(present[0]!.snapshot);
    try {
      expect(frozen.getText('future').toString()).toBe('before:accepted-before-freeze');
      expect(frozen.getMap('opaque').get('unknown')).toEqual({ retained: true });
    } finally {
      frozen.free();
    }
    const before = await Promise.all(
      [name, `${name}:window-a`, `${name}:empty`].map((dbName) => dump(idb, dbName))
    );
    const { captureFrozenRendererSessionBody } =
      await import('../src/providers/renderer-session-body-migration');
    expect(
      await captureFrozenRendererSessionBody({ workspaceId, sessionId, indexedDB: idb })
    ).toEqual(receipt.sources);
    expect(
      await Promise.all(
        [name, `${name}:window-a`, `${name}:empty`].map((dbName) => dump(idb, dbName))
      )
    ).toEqual(before);
    owner = 'native';
    await main.published(receipt);
    expect(gates.get(1)!.shouldRoute(roomId)).toBe(false);
    expect(gates.get(1)!.shouldRoute('session-independent')).toBe(true);
  } finally {
    release.resolve();
    await operation;
    await main.close();
    for (const repo of repositories) await repo.destroy();
    for (const storage of storages) await storage.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('finishes a native route migration while its actual store cache creation is pending, and publishes legacy owners before their gate drains', async () => {
  const { LoroDoc } = await import('loro-crdt');
  const { RendererSessionBodyFreeze } =
    await import('../src/providers/renderer-session-body-migration');
  const { RendererSessionBodyMigrationMainLegacy } =
    await import('../../../apps/electron/src/main/services/renderer-session-body-migration');
  const { createManagedStoreCache } = await import('../src/providers/store-ref-tracker');
  const { openSessionBodyStore, drainLegacySessionBodyStore } =
    await import('../src/providers/session-body-store-lifecycle');
  const idb = new IDBFactory(),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-session-cache-route-'));
  const storage = adapter(idb, name),
    repo = await LoroRepo.create({ storageAdapter: storage });
  const first = 'native-probe-pending',
    second = 'legacy-create-pending',
    firstRoom = `session-${first}`;
  const existing = await repo.openPersistedDoc(firstRoom);
  existing.doc.getText('future').insert(0, 'Stored before native probe');
  existing.doc.getMap('unknown').set('kept', new Uint8Array([0, 255]));
  existing.doc.commit();
  await repo.persistDocNow(firstRoom, existing.doc);
  await repo.unloadDoc(firstRoom);
  type Store = { doc: InstanceType<typeof LoroDoc> | undefined; read(): string; dispose(): void };
  const legacy = new Map<string, Store>(),
    native = new Map<string, Store>();
  const owners = new Map<string, 'legacy' | 'frozen' | 'native'>();
  const registration = '11111111-1111-4111-8111-111111111111';
  const physicalDrain = signal(),
    continueDrain = signal(),
    pendingReleaseAttempt = signal(),
    legacyCreating = signal(),
    finishLegacyCreate = signal(),
    secondFreezing = signal();
  const handlers = new Set<Promise<unknown>>();
  let closed = false;
  let main!: InstanceType<typeof RendererSessionBodyMigrationMainLegacy>;
  let cache!: ReturnType<typeof createManagedStoreCache<string, Store>>;
  const gate = new RendererSessionBodyFreeze({
    indexedDB: idb,
    beginFreeze(id) {
      if (id === second) secondFreezing.resolve();
    },
    async drainLegacySession(id) {
      const original = legacy.get(id);
      if (id === second && !original)
        throw new Error('Actual legacy owner was not published before its operation gate released');
      await drainLegacySessionBodyStore(original, {
        refreshRoutes: () => repo.refreshTransportRoutes(),
        unload: async () => {
          if (id === first) {
            physicalDrain.resolve();
            await continueDrain.promise;
          }
          await repo.unloadDoc(`session-${id}`);
        },
        releaseMaterializedLegacy: () => {
          if (id === first) pendingReleaseAttempt.resolve();
          return cache.release(id);
        },
        forgetLegacy: () => {
          legacy.delete(id);
        },
      });
    },
  });
  main = new RendererSessionBodyMigrationMainLegacy({
    binding: { accountId: 'local:fixture', workspaceId, contentMode: 'plaintext' },
    databasePath: path.join(directory, 'window.sqlite3'),
    admit: (window, reg) => {
      if (window !== 1 || reg !== registration) throw new Error('Retired window');
    },
    registeredWindowIds: () => [1],
    readCommittedOwner: (id) => owners.get(id) ?? 'legacy',
    send: (window, request) => {
      const work = gate.handle(request).then(
        (ack) => {
          if (!closed) main.acknowledge(window, ack);
        },
        () => {
          if (!closed) main.acknowledge(window, { ...request, failure: 'freeze_unconfirmed' });
        }
      );
      handlers.add(work);
      void work.finally(() => handlers.delete(work)).catch(() => {});
    },
  });
  gate.bind(main.register(1, registration));
  main.ready(1, registration);
  const nativeFrom = (id: string, snapshot: Uint8Array) => {
    const decoded = LoroDoc.fromSnapshot(snapshot);
    let value: string;
    try {
      value = decoded.getText('future').toString();
      expect(decoded.getMap('unknown').get('kept')).toEqual(new Uint8Array([0, 255]));
    } finally {
      decoded.free();
    }
    let live = true;
    const result: Store = {
      doc: undefined,
      read() {
        if (!live) throw new Error('Store retired');
        return value;
      },
      dispose() {
        live = false;
      },
    };
    native.set(id, result);
    return result;
  };
  let heldLegacyText: ReturnType<InstanceType<typeof LoroDoc>['getText']> | undefined;
  cache = createManagedStoreCache<string, Store>({
    releaseDelayMs: 60000,
    create: (id) =>
      openSessionBodyStore<Store>({
        openNative: async () => {
          if (native.has(id)) return native.get(id);
          if (id !== first) return undefined;
          await main.enumerate(id);
          owners.set(id, 'frozen');
          const receipt = await main.freezeAndCapture(id, 'first-migration');
          const source = receipt.sources.find((source) => source.present);
          if (!source) throw new Error('Existing Session source missing');
          const result = nativeFrom(id, source.snapshot);
          owners.set(id, 'native');
          await main.published(receipt);
          return result;
        },
        createLegacy: async () => {
          const handle = await repo.openPersistedDoc(`session-${id}`);
          let live = true;
          if (id === second) {
            heldLegacyText = handle.doc.getText('future');
            heldLegacyText.insert(0, 'Accepted legacy creation');
            handle.doc.getMap('unknown').set('kept', new Uint8Array([0, 255]));
            handle.doc.commit();
            legacyCreating.resolve();
            await finishLegacyCreate.promise;
          }
          return {
            doc: handle.doc,
            read() {
              if (!live) throw new Error('Store retired');
              return handle.doc.getText('future').toString();
            },
            dispose() {
              live = false;
            },
          };
        },
        runLegacy: (work) => gate.run(id, work),
        publishLegacy: (store) => {
          legacy.set(id, store);
        },
      }),
    unload: async (id) => {
      if (legacy.has(id)) await repo.unloadDoc(`session-${id}`);
    },
  });
  const firstAcquire = cache.acquire(first);
  void firstAcquire.catch(() => {});
  let secondAcquire: Promise<Store> | undefined,
    secondCapture: ReturnType<typeof main.freezeAndCapture> | undefined;
  try {
    await physicalDrain.promise;
    expect(cache.peek(first)).toBeUndefined();
    const sibling = await cache.acquire('independent');
    sibling.doc!.getText('future').insert(0, 'Other Session remains writable');
    sibling.doc!.commit();
    await repo.persistDocNow('session-independent', sibling.doc!);
    continueDrain.resolve();
    const outcome = await Promise.race([
      firstAcquire.then((store) => ({ kind: 'ready' as const, store })),
      pendingReleaseAttempt.promise.then(() => ({ kind: 'self-wait' as const })),
    ]);
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('Native route waited on its own cache creation');
    expect(outcome.store.read()).toBe('Stored before native probe');
    expect(cache.peek(first)).toBe(outcome.store);
    expect(sibling.read()).toBe('Other Session remains writable');
    secondAcquire = cache.acquire(second);
    void secondAcquire.catch(() => {});
    await legacyCreating.promise;
    await main.enumerate(second);
    owners.set(second, 'frozen');
    secondCapture = main.freezeAndCapture(second, 'second-migration');
    void secondCapture.catch(() => {});
    await secondFreezing.promise;
    finishLegacyCreate.resolve();
    const receipt = await secondCapture;
    await secondAcquire;
    expect(() => heldLegacyText!.insert(0, 'late')).toThrow();
    const source = receipt.sources.find((source) => source.present);
    if (!source) throw new Error('Legacy created Session was lost');
    nativeFrom(second, source.snapshot);
    owners.set(second, 'native');
    await main.published(receipt);
    const reopened = await cache.acquire(second);
    expect(reopened.doc).toBeUndefined();
    expect(reopened.read()).toBe('Accepted legacy creation');
    expect(sibling.read()).toBe('Other Session remains writable');
  } finally {
    continueDrain.resolve();
    finishLegacyCreate.resolve();
    closed = true;
    await main.close();
    gate.retire();
    await Promise.allSettled([
      firstAcquire,
      ...(secondAcquire ? [secondAcquire] : []),
      ...(secondCapture ? [secondCapture] : []),
    ]);
    await Promise.allSettled([...handlers]);
    await cache.disposeAll();
    await repo.destroy();
    await storage.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('freezes each leaf Doc independently, drains admitted writes and captures every persisted renderer source including absence', async () => {
  const { LoroDoc } = await import('loro-crdt');
  const { RendererDocumentDomainFreeze } =
    await import('../src/providers/renderer-document-domain-migration');
  const { documentDomainMigrationScope } =
    await import('@lody/shared/renderer-document-domain-migration');
  const idb = new IDBFactory();
  const store = adapter(idb, name),
    absent = adapter(idb, `${name}:other-window`);
  const scope = documentDomainMigrationScope({ domain: 'preview_comments', id: 'preview-fixture' });
  const doc = new LoroDoc();
  doc.getMap('meta').set('sessionId', scope.id);
  doc.getMap('opaque').set('preserve', 'unknown');
  await store.save({
    type: 'doc-snapshot',
    docId: scope.roomId,
    snapshot: doc.export({ mode: 'snapshot' }),
  });
  // Creating another real database must not silently remove it from the source witness.
  await absent.save({
    type: 'doc-snapshot',
    docId: 'unrelated',
    snapshot: doc.export({ mode: 'snapshot' }),
  });
  const admitted = signal(),
    complete = signal(),
    detached = signal();
  let drained = false;
  const gate = new RendererDocumentDomainFreeze({
    indexedDB: idb,
    beginFreeze: () => detached.resolve(),
    drainLegacy: async () => {
      drained = true;
    },
  });
  const registrationId = '7716b50c-35fd-47da-a4ba-48573dc59803';
  const binding = { accountId: 'local:fixture', workspaceId, contentMode: 'plaintext' as const };
  gate.bind({ binding, metadataGeneration: 'actual-meta-owner', registrationId, rooms: [] });
  const request = {
    binding,
    metadataGeneration: 'actual-meta-owner',
    registrationId,
    requestId: '17d6cf6b-e4e8-4561-bbd7-df6b21a77914',
    scope,
    revision: 'leaf-fence',
    phase: 'freeze' as const,
  };
  const writing = gate.run(scope, async () => {
    admitted.resolve();
    await complete.promise;
  });
  try {
    await admitted.promise;
    const freezing = gate.handle(request);
    await detached.promise;
    expect(drained).toBe(false);
    expect(gate.owner(scope.roomId)).toBe('frozen');
    expect(() => gate.runSync(scope, () => doc.getMap('opaque').set('late', true))).toThrow(
      'frozen'
    );
    expect(gate.shouldRoute('session-preview-fixture')).toBe(true);
    expect(gate.shouldRoute('schedule-unrelated')).toBe(true);
    complete.resolve();
    await writing;
    await freezing;
    const captured = await gate.handle({ ...request, phase: 'capture' });
    if (!('sources' in captured) || !captured.sources) throw new Error('Complete sources missing');
    expect(captured.sources.map((entry) => [entry.dbName, entry.present])).toEqual([
      [name, true],
      [`${name}:other-window`, false],
    ]);
    const restored = new LoroDoc();
    try {
      restored.import(captured.sources[0]!.snapshot);
      expect(restored.toJSON()).toEqual(doc.toJSON());
    } finally {
      restored.free();
    }
    expect(captured.sources[1]!.snapshot.byteLength).toBe(0);
    await expect(
      gate.handle({
        ...request,
        scope: documentDomainMigrationScope({ domain: 'schedule_definition', id: scope.id }),
        phase: 'capture',
      })
    ).rejects.toThrow('exact completed freeze');
    await gate.handle({ ...request, phase: 'publish' });
    expect(gate.owner(scope.roomId)).toBe('native');
    expect(gate.shouldRoute(scope.roomId)).toBe(false);
    expect(() => gate.assertLegacy(scope.roomId)).toThrow('frozen');
    const oldOpening = idb.open(`${name}:old-layout`, 3);
    const oldLayout = await new Promise<IDBDatabase>((resolve, reject) => {
      oldOpening.onsuccess = () => resolve(oldOpening.result);
      oldOpening.onerror = () => reject(oldOpening.error);
    });
    oldLayout.close();
    const unrelated = documentDomainMigrationScope({
      domain: 'schedule_definition',
      id: 'legacy-layout',
    });
    await expect(gate.handle({ ...request, scope: unrelated, phase: 'enumerate' })).rejects.toThrow(
      'Unsupported document IndexedDB layout'
    );
    expect(gate.owner(unrelated.roomId)).toBe('legacy');
    gate.runSync(unrelated, () => doc.getMap('opaque').set('independent', 'still writable'));
    expect(doc.getMap('opaque').get('independent')).toBe('still writable');
  } finally {
    complete.resolve();
    await writing;
    gate.retire();
    doc.free();
    await store.close();
    await absent.close();
  }
});
