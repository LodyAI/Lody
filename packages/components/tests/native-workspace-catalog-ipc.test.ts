import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Flock } from '@loro-dev/flock-wasm';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { afterEach, expect, it } from 'vitest';
import {
  openNativeRepoTestHost,
  NativeRepoTestHostOpenFailed,
  type NativeRepoTestHost,
} from './native-repo-host.test-support';
import {
  getWorkspaceFlockDocId,
  createLegacyWorkspaceCatalogReader,
  workspaceFlockKeys,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import {
  NativeRepoMigrationJournal,
  readNativeFlockSnapshot,
  verifyFrozenFlockMigration,
} from '../../../apps/cli/src/lib/loro/native-repo-migration';
import { RendererWorkspaceFlockMigrationMainLegacy } from '../../../apps/electron/src/main/services/renderer-workspace-flock-migration';
import { NativeWorkspaceCatalogMainLegacy } from '../../../apps/electron/src/main/services/native-workspace-catalog';
import { readNativeWorkspaceFlockOwner } from '../../../apps/electron/src/main/services/native-workspace-routing';
import { createNativeWorkspaceCatalogIpc } from '../src/providers/native-workspace-catalog-ipc';
import { createRendererWorkspaceFlockIpcPort } from '../src/providers/renderer-workspace-flock-ipc';
import { RendererWorkspaceFlockFreeze } from '../src/providers/renderer-workspace-flock-freeze';
import { createWorkspaceCatalogOwnerDispatcher } from '../src/providers/workspace-catalog-owner-dispatcher';
import {
  workspaceCatalogIpcRequestSchema,
  workspaceCatalogIpcUnsubscribeSchema,
  type WorkspaceCatalogIpcEvent,
} from '@lody/shared/workspace-catalog-ipc';
import type {
  RendererWfRequest,
  RendererWfPublishedOwner,
} from '@lody/shared/renderer-room-migration';

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  const outcomes = await Promise.allSettled([...cleanups].map((close) => close()));
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  );
  if (failures.length)
    throw new AggregateError(failures, 'Native fixture cleanup remains unconfirmed');
});
const workspaceId = 'lw_native_catalog_test' as WorkspaceId;
const accountId = 'local:actor';
const roomId = getWorkspaceFlockDocId(workspaceId);
const room = { kind: 'flock' as const, id: roomId };
const binding = { accountId, workspaceId, roomId, contentMode: 'plaintext' as const };
const server = (name: string): WorkspaceMcpServerMeta => ({
  id: 'mcp-native' as WorkspaceMcpServerMeta['id'],
  name,
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'synthetic-mcp' },
  createdAt: 1,
  updatedAt: 1,
});
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwf-'));
  const selected = resolveLocalIndependentRepo({
    platform: 'local',
    dataRoot: root,
    accountId,
    workspaceId,
  });
  await fs.mkdir(selected.directory, { recursive: true, mode: 0o700 });
  let host: NativeRepoTestHost | undefined;
  let startupCleanup: (() => Promise<void>) | undefined;
  const resources: {
    catalog?: NativeWorkspaceCatalogMainLegacy;
    main?: RendererWorkspaceFlockMigrationMainLegacy;
    journal?: NativeRepoMigrationJournal;
  } = {};
  let released = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (released) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        resources.catalog?.close(),
        host?.close() ?? startupCleanup?.(),
      ]);
      const errors: unknown[] = outcomes[1]!.status === 'rejected' ? [outcomes[1]!.reason] : [];
      try {
        await resources.catalog?.close();
      } catch (error) {
        if (outcomes[0]!.status === 'rejected') errors.push(outcomes[0]!.reason);
        errors.push(error);
      }
      for (const release of [() => resources.main?.close(), () => resources.journal?.close()])
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length) throw new AggregateError(errors, 'Synthetic catalog cleanup failed');
      await fs.rm(root, { recursive: true, force: true });
      released = true;
      cleanups.delete(close);
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  cleanups.add(close); // Failed startup still has an actual Scope owner to release.
  try {
    host = await openNativeRepoTestHost(selected.dataDir);
  } catch (error) {
    if (error instanceof NativeRepoTestHostOpenFailed) startupCleanup = error.retryCleanup;
    throw error;
  }
  const client = host.client;
  expect(host.pid).toBeGreaterThan(0);
  expect(host.pid).not.toBe(process.pid);
  const endpoint = JSON.parse(
    await fs.readFile(path.join(selected.dataDir, 'engine.json'), 'utf8')
  ) as { pid: number };
  expect(endpoint.pid).toBe(host.pid);
  const images = (process.report.getReport() as { sharedObjects?: string[] }).sharedObjects ?? [];
  expect(
    images.some(
      (image) => path.basename(image).startsWith('loro-repo-engine.') && image.endsWith('.node')
    )
  ).toBe(false);
  const legacy = new Flock();
  legacy.put(workspaceFlockKeys.mcpServer(server('Legacy').id), server('Legacy'), 100);
  legacy.put(['futureRoot', 'opaque'], { notInProjection: true }, 101);
  legacy.put(
    ['agentRole', 'private-other'],
    {
      v: 1,
      id: 'private-other',
      ownerUserId: 'local:other',
      visibility: 'private',
      name: 'Private other',
      mentionSlug: 'private-other',
      machineId: 'machine-other',
      agentConfigId: 'agent-other',
      runConfig: {},
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    102
  );
  await client.createRoom(workspaceId, room, 'plaintext');
  await client.importRoomState(workspaceId, room, {
    snapshot: legacy.exportFile(),
    enqueueOutbox: false,
  });
  await client.compactRoom(workspaceId, room);
  const journal = (resources.journal = new NativeRepoMigrationJournal(
    path.join(selected.directory, 'routes.sqlite3')
  ));
  const publish = () => {
    const target = readNativeFlockSnapshot({
      dataDir: selected.dataDir,
      namespace: workspaceId,
      room,
    });
    const source = { sourceId: 'synthetic-complete', snapshot: legacy.exportFile() };
    const proof = verifyFrozenFlockMigration(target, [source]);
    journal.freeze({
      binding: JSON.stringify([accountId, workspaceId]),
      namespace: workspaceId,
      room,
      migrationId: 'synthetic-published',
      targetGeneration: 'engine-0.1.0',
      sources: [...proof.sources],
    });
    journal.verify(JSON.stringify([accountId, workspaceId]), 'synthetic-published', proof);
    journal.publish(JSON.stringify([accountId, workspaceId]), room, 'synthetic-published');
  };
  const requestListeners = new Set<(message: RendererWfRequest) => void>();
  const ownerListeners = new Set<(owner: RendererWfPublishedOwner) => void>();
  const catalogListeners = new Set<(event: WorkspaceCatalogIpcEvent) => void>();
  const main = (resources.main = new RendererWorkspaceFlockMigrationMainLegacy({
    databasePath: path.join(root, 'renderer.sqlite3'),
    registeredWindowIds: () => [1],
    send: (_id, request) => {
      for (const listener of requestListeners) listener(request);
    },
    publishOwner: (_id, owner) => {
      for (const listener of ownerListeners) listener(owner);
    },
    readCommittedOwner: async () => readNativeWorkspaceFlockOwner(root, binding),
  }));
  const catalog = (resources.catalog = new NativeWorkspaceCatalogMainLegacy({
    dataRoot: root,
    lease: () => ({ client: async () => client }),
    migration: () => main,
    send: (_id, event) => {
      for (const listener of catalogListeners) listener(event);
    },
  }));
  const migrationPort = createRendererWorkspaceFlockIpcPort(
    {
      registerWorkspaceFlock: async () => {
        const attempt = main.beginRegistration(1);
        await main.reconcileOwner(binding);
        return main.register(1, binding, attempt);
      },
      readyWorkspaceFlock: async (ticket) => {
        await main.reconcileOwner(binding);
        return main.ready(1, ticket);
      },
      retireWorkspaceFlock: async (ticket) => {
        main.retire(1, ticket);
        await catalog.retire(1, ticket);
      },
      acknowledgeWorkspaceFlock: async (ack) => main.acceptAck(1, ack),
    },
    (listener) => {
      requestListeners.add(listener);
      return () => {
        requestListeners.delete(listener);
      };
    },
    (listener) => {
      ownerListeners.add(listener);
      return () => {
        ownerListeners.delete(listener);
      };
    }
  );
  const native = (ticket: string) =>
    createNativeWorkspaceCatalogIpc(
      binding,
      ticket,
      {
        readWorkspaceCatalog: async (id) => catalog.read(1, id, binding),
        executeWorkspaceCatalog: async (id, command) => catalog.execute(1, id, binding, command),
        uploadWorkspaceCatalog: async (id) => catalog.upload(1, id, binding),
        observeWorkspaceCatalog: async (input) => {
          const parsed = workspaceCatalogIpcRequestSchema.parse(input);
          return catalog.observe(1, parsed.registrationId, binding, parsed.requestId);
        },
        unobserveWorkspaceCatalog: async (input) => {
          const parsed = workspaceCatalogIpcUnsubscribeSchema.parse(input);
          return catalog.unsubscribe(1, parsed.registrationId, parsed.requestId, parsed.leaseId);
        },
      },
      (listener) => {
        catalogListeners.add(listener);
        return () => {
          catalogListeners.delete(listener);
        };
      }
    );
  return {
    root,
    selected,
    client,
    legacy,
    publish,
    main,
    catalog,
    migrationPort,
    native,
    catalogListeners,
    close,
  };
}

it('uses actual journal/native room state, actor-filtered summaries, finite commands, and exact observation leases', async () => {
  const f = await fixture();
  let registration: Awaited<ReturnType<typeof f.migrationPort.start>> | undefined;
  let backend: ReturnType<typeof f.native> | undefined;
  try {
    f.publish();
    registration = await f.migrationPort.start(binding, async (request) => ({ ...request }));
    expect(registration.owner.owner).toBe('native');
    backend = f.native(registration.registrationId);
    expect((await backend.reader.read(binding)).roles).toEqual([]);
    const ready = signal(),
      changed = signal();
    let latest = '';
    const observation = await backend.reader.observe(
      binding,
      (update) => {
        latest = update.projection.servers[0]?.name ?? '';
        if (latest === 'Legacy') ready.resolve();
        if (latest === 'Native') changed.resolve();
      },
      (cause) => {
        throw cause;
      }
    );
    await ready.promise;
    await backend.commands.execute(binding, { kind: 'put-mcp', entry: server('Native') });
    await changed.promise;
    expect(
      (await f.client.flockGet(workspaceId, room, workspaceFlockKeys.mcpServer(server('').id)))
        .value
    ).toMatchObject({ name: 'Native' });
    await expect(
      f.catalog.execute(1, registration.registrationId, binding, {
        kind: 'generic-patch',
        path: ['futureRoot'],
        value: null,
      })
    ).rejects.toThrow();
    await expect(
      f.catalog.execute(1, registration.registrationId, binding, {
        kind: 'put-role',
        role: {
          v: 1,
          id: 'private-other',
          ownerUserId: accountId,
          visibility: 'private',
          name: 'Unauthorized',
          machineId: 'machine-other',
          agentConfigId: 'agent-other',
          runConfig: {},
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
        },
      })
    ).rejects.toThrow();
    expect((await f.client.flockGet(workspaceId, room, ['futureRoot', 'opaque'])).value).toEqual({
      notInProjection: true,
    });
    await observation.close();
    const requestId = crypto.randomUUID();
    const first = await f.catalog.observe(1, registration.registrationId, binding, requestId);
    await f.catalog.unsubscribe(1, registration.registrationId, requestId, first.leaseId);
    const second = await f.catalog.observe(1, registration.registrationId, binding, requestId);
    expect(second.leaseId).not.toBe(first.leaseId);
    await f.catalog.unsubscribe(1, registration.registrationId, requestId, first.leaseId);
    const alive = signal();
    const listen = (event: WorkspaceCatalogIpcEvent) => {
      if (
        event.leaseId === second.leaseId &&
        event.type === 'snapshot' &&
        event.update.projection.servers[0]?.name === 'Still active'
      )
        alive.resolve();
    };
    f.catalogListeners.add(listen);
    await backend.commands.execute(binding, { kind: 'put-mcp', entry: server('Still active') });
    await alive.promise;
    expect(latest).toBe('Native');
    f.catalogListeners.delete(listen);
    await f.catalog.unsubscribe(1, registration.registrationId, requestId, second.leaseId);
  } finally {
    await backend?.close();
    await registration?.close();
    await f.close();
  }
}, 30_000);

it('moves the same logical observer from drained legacy to native only after a trusted published owner push', async () => {
  const f = await fixture();
  const idb = new IDBFactory();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: idb });
  const storage = new IndexedDBStorageAdaptor({ dbName: `lody-loro-repo-db-${workspaceId}` });
  if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
  await storage.save({
    type: 'flock-doc-snapshot',
    flockDocId: roomId,
    snapshot: f.legacy.exportFile(),
  });
  let registration: Awaited<ReturnType<typeof f.migrationPort.start>> | undefined;
  let native: ReturnType<typeof f.native> | undefined;
  const gate = new RendererWorkspaceFlockFreeze(binding, {
    indexedDB: idb,
    readStartupOwner: async () => {
      registration = await f.migrationPort.start(
        binding,
        (request) => gate.handle(request),
        undefined,
        (owner) => gate.published(owner)
      );
      return registration.owner;
    },
    detachRoom: async () => {},
    persistRoom: async () => {
      await storage.save({
        type: 'flock-doc-snapshot',
        flockDocId: roomId,
        snapshot: f.legacy.exportFile(),
      });
    },
  });
  await gate.startup();
  const legacyReader = gate.reader(
    createLegacyWorkspaceCatalogReader({
      binding,
      open: async () => ({
        flock: f.legacy,
        joinRoom: async () => ({ unsubscribe: () => {}, firstSyncedWithRemote: Promise.resolve() }),
      }),
    })
  );
  const dispatcher = createWorkspaceCatalogOwnerDispatcher({
    owner: () => gate.ownerKind(),
    subscribeOwner: (listener) => gate.subscribeOwner(listener),
    legacy: {
      reader: legacyReader,
      commands: {
        execute: async () => {
          throw new Error('legacy mutation not admitted in this test');
        },
        upload: async () => {},
      },
    },
    native: () => {
      native ??= f.native(registration!.registrationId);
      return native;
    },
  });
  try {
    const initial = signal(),
      updated = signal();
    let latest = '';
    const view = await dispatcher.reader.observe(
      binding,
      (value) => {
        latest = value.projection.servers[0]?.name ?? '';
        if (latest === 'Legacy') initial.resolve();
        if (latest === 'Published native') updated.resolve();
      },
      (cause) => {
        throw cause;
      }
    );
    await initial.promise;
    const frozen = await f.main.freeze(binding);
    expect(gate.ownerKind()).toBe('frozen');
    await expect(dispatcher.reader.read(binding)).rejects.toThrow(/maintenance/);
    f.publish();
    await f.main.complete(binding, frozen.revision);
    expect(gate.ownerKind()).toBe('native');
    await dispatcher.commands.execute(binding, {
      kind: 'put-mcp',
      entry: server('Published native'),
    });
    await updated.promise;
    f.legacy.put(workspaceFlockKeys.mcpServer(server('').id), server('Obsolete legacy'), 9999);
    f.legacy.commit();
    expect((await dispatcher.reader.read(binding)).servers[0]?.name).toBe('Published native');
    expect(latest).toBe('Published native');
    await expect(gate.run(() => Promise.resolve())).rejects.toThrow(/frozen/);
    await view.close();
  } finally {
    await dispatcher.close();
    await native?.close();
    await gate.close();
    await registration?.close();
    await storage.close();
    await f.close();
  }
}, 30_000);
