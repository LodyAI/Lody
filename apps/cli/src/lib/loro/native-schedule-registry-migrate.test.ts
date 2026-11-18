import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import { NativeScheduleRegistryMainLegacy } from '../../../../electron/src/main/services/native-schedule-registry';
import { NativeWorkspaceMetaOwnerLegacy } from '../../../../electron/src/main/services/native-workspace-meta-owner';
import { createNativeScheduleRegistryIpc } from '../../../../../packages/components/src/providers/native-schedule-registry-ipc';
import {
  ScheduleRegistryIpcError,
  type ScheduleRegistryIpcEvent,
} from '@lody/shared/schedule-registry-ipc';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroRepo } from 'loro-repo';
import { LoroDocumentManager } from './doc';
import { getLogger } from '../../utils/logger';
import { Layer } from 'effect';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import { presencePlatformLayer } from '@/platform/presence';
import { WorkspacePresenceOwnersLive } from './workspace-presence';
import {
  bindWorkspacePresenceApplicationLegacy,
  recoverCliPresenceApplicationShutdown,
  WorkspacePresenceLegacyFailure,
} from './presence-legacy';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import { ScheduleRegistryRowSchema, scheduleRegistryKeys, type WorkspaceId } from '@lody/shared';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { nativeScheduleRegistryMigrationInputSchema } from '@lody/shared/native-schedule-registry-migration';
import {
  rendererFlockGroupScope,
  type RendererFlockGroup,
} from '@lody/shared/renderer-flock-room-group';
import { RendererFlockRoomGroupMigrationMainLegacy } from '../../../../electron/src/main/services/renderer-flock-room-group-migration';
import { migrateLocalScheduleRegistryLegacy } from './native-schedule-registry-migrate';
import { migrateLocalWorkspaceMetaLegacy } from './native-workspace-meta-migrate';
import { createNativeWorkspaceMeta } from '@lody/shared/node/native-workspace-meta';
import {
  openNativeLocalWorkspaceMetaLegacy,
  createRepoWithNativeWorkspaceMetaLegacy,
} from './native-workspace-meta-owner';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import {
  createNativeLocalScheduleRegistryLegacy,
  openNativeLocalScheduleRegistryLegacy,
  readLocalScheduleRegistryOwner,
} from './native-schedule-registry-owner';
import { NativeRepoMigrationJournal, readNativeFlockSnapshot } from './native-repo-migration';
import { readLegacySqliteFlockSource } from './legacy-sqlite-flock-source';
const require = createRequire(import.meta.url);
const roots = new Set<string>();
const cleanup: Array<() => unknown | Promise<unknown>> = [];
let compiled: string;
const accountId = 'local:sr-helper';
const workspaceId = 'lw_sr_helper' as WorkspaceId;
const room = { kind: 'flock' as const, id: `${workspaceId}:sr` };
const group: RendererFlockGroup = {
  accountId,
  workspaceId,
  domain: 'schedule',
  contentMode: 'plaintext',
  roomIds: [room.id],
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const row = ScheduleRegistryRowSchema.parse({
  scheduleId: 'synthetic-sr',
  title: 'Legacy schedule',
  ownerId: accountId,
  machineId: 'synthetic-machine',
  enabled: true,
  activationId: 'original',
  activeFrom: 1,
  trigger: { kind: 'manual' },
  destination: { kind: 'new_session' },
  createdAt: 1,
  updatedAt: 1,
  definitionFingerprint: 'a'.repeat(64),
  agentConfigId: 'synthetic-agent',
});
beforeAll(async () => {
  compiled = path.resolve(
    import.meta.dirname,
    '../../..',
    'node_modules/.cache',
    `sr-helper-${randomUUID()}`
  );
  await mkdir(compiled, { recursive: true });
  await build({
    entryPoints: {
      'native-repo-independent-host': path.join(
        import.meta.dirname,
        'native-repo-independent-host-entry.ts'
      ),
      'native-repo-independent-engine': path.join(
        import.meta.dirname,
        'native-repo-independent-engine-entry.ts'
      ),
    },
    outdir: compiled,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire as __req } from 'node:module'; const require = __req(import.meta.url);",
    },
    plugins: [
      {
        name: 'shared-node-source',
        setup(builder) {
          builder.onResolve({ filter: /^@lody\/shared\/node\// }, (args) => ({
            path: path.resolve(
              import.meta.dirname,
              '../../../../../packages/shared/src/node',
              `${args.path.split('/').at(-1)}.ts`
            ),
          }));
        },
      },
    ],
  });
});
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse())
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length)
    throw new AggregateError(failures, 'SR migration fixture release unconfirmed');
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});
afterAll(async () => {
  if (!roots.size) await rm(compiled, { recursive: true, force: true });
});
const launch = () => ({
  executable: process.execPath,
  entry: path.join(compiled, 'native-repo-independent-host.js'),
});
async function profile() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'lody-sr-helper-'));
  roots.add(dataRoot);
  const descriptor = resolveLocalIndependentRepo({
    platform: 'local',
    dataRoot,
    accountId,
    workspaceId,
  });
  const databasePath = path.join(dataRoot, 'loro-repo', workspaceId, 'repo.sqlite3');
  await mkdir(path.dirname(databasePath), { recursive: true });
  const store = await SqliteRepoStore.open({ path: databasePath });
  const repo = await LoroRepo.create({ storageAdapter: store.storage });
  const legacy = await repo.openFlockDoc(room.id);
  legacy.flock.put(scheduleRegistryKeys.schedule(row.scheduleId), {
    ...row,
    future: { retained: true },
  });
  legacy.flock.put(['deleted'], 'old', 1);
  legacy.flock.delete(['deleted'], 2);
  legacy.flock.putWithMeta(
    ['opaque'],
    { retained: true },
    { metadata: { future: { retained: true } } }
  );
  const wf = await repo.openFlockDoc(`${workspaceId}:wf:workspace`);
  wf.flock.put(['untouched'], true);
  repo.getMeta().put(['m', 'schedule-synthetic-sr'], { title: 'Definition metadata stays legacy' });
  await repo.persistFlockDocNow(room.id, legacy.flock);
  await repo.persistFlockDocNow(`${workspaceId}:wf:workspace`, wf.flock);
  await repo.flush();
  await repo.destroy();
  await store.close();
  const renderer = Flock.strictFromFile(
    readLegacySqliteFlockSource({ databasePath, room }).snapshot
  );
  renderer.put(scheduleRegistryKeys.manual(row.scheduleId, 'renderer'), {
    scheduleId: row.scheduleId,
    actorId: accountId,
    activationId: row.activationId,
    manualRunId: 'renderer',
    requestedAt: 2,
  });
  const absent = new Flock('absent-idb');
  return {
    dataRoot,
    descriptor,
    databasePath,
    renderers: [renderer.exportFile(), absent.exportFile()],
  };
}
function windows(
  dataRoot: string,
  snapshots: Uint8Array[],
  selectedGroup: RendererFlockGroup = group
) {
  const group = selectedGroup;
  const room = {
    kind: group.domain === 'meta' ? ('meta' as const) : ('flock' as const),
    id: group.roomIds[0]!,
  };
  const databasePath = path.join(dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3');
  let main: RendererFlockRoomGroupMigrationMainLegacy;
  main = new RendererFlockRoomGroupMigrationMainLegacy({
    group,
    databasePath,
    registeredWindowIds: () => [1, 2],
    send(windowId, request) {
      const dbName = `lody-loro-repo-db-${workspaceId}:${windowId}`;
      main.acceptAck(windowId, {
        ...request,
        ...(request.phase === 'capture'
          ? {
              inventory: [
                {
                  roomId: room.id,
                  present: windowId === 1,
                  sources: [
                    {
                      sourceId: `renderer-idb:loro-repo@0.25.0:${dbName}`,
                      dbName,
                      present: windowId === 1,
                      snapshot: snapshots[windowId - 1]!,
                    },
                  ],
                },
              ],
            }
          : {}),
      });
    },
    readCommittedOwner: async () => {
      const file = path.join(
        resolveLocalIndependentRepo({ platform: 'local', dataRoot, accountId, workspaceId })
          .directory,
        'routes.sqlite3'
      );
      if (!existsSync(file)) return 'legacy';
      const journal = new NativeRepoMigrationJournal(file);
      try {
        const owner = journal.route(JSON.stringify([accountId, workspaceId]), room).owner;
        if (owner === 'native')
          readNativeFlockSnapshot({
            dataDir: resolveLocalIndependentRepo({
              platform: 'local',
              dataRoot,
              accountId,
              workspaceId,
            }).dataDir,
            namespace: workspaceId,
            room,
          });
        return owner;
      } finally {
        journal.close();
      }
    },
  });
  cleanup.push(() => main.close());
  for (const id of [1, 2]) {
    const registration = main.register(id, main.beginRegistration(id));
    main.ready(id, registration.registrationId);
  }
  return main;
}
async function request(
  main: RendererFlockRoomGroupMigrationMainLegacy,
  dataRoot: string,
  selectedGroup: RendererFlockGroup = group
) {
  const frozen = await main.freeze();
  const sources = frozen.windows.flatMap((window) =>
    window.inventory[0]!.sources.map((source) => ({
      sourceId: `${window.windowId}:${source.sourceId}`,
      present: source.present,
      snapshotBase64: Buffer.from(source.snapshot).toString('base64'),
    }))
  );
  return {
    version: 1 as const,
    dataRoot,
    group: selectedGroup,
    revision: frozen.revision,
    sources,
  };
}
function deferred<A>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function domainBridge() {
  const fixture = await profile();
  await mkdir(path.join(fixture.dataRoot, 'native-repo'), { recursive: true });
  const main = windows(fixture.dataRoot, fixture.renderers);
  const input = await request(main, fixture.dataRoot);
  await migrateLocalScheduleRegistryLegacy(input, {
    executable: process.execPath,
    hostEntry: launch().entry,
  });
  await main.complete(input.revision);
  const registration = main.register(1, main.beginRegistration(1));
  main.ready(1, registration.registrationId);
  const host = new IndependentNativeRepoHostLegacy({
    dataDir: fixture.descriptor.dataDir,
    binding: fixture.descriptor.binding,
    ...launch(),
  });
  cleanup.push(() => host.close());
  const client = await host.client();
  const rival = await connectEngine(fixture.descriptor.dataDir);
  cleanup.push(() => rival.close());
  const info = await host.leaseInfo(client);
  const generation = `${info.engineRunId}:${info.clientGeneration}`;
  const listeners = new Set<(event: unknown) => void>(),
    events: ScheduleRegistryIpcEvent[] = [];
  let gate: Promise<void> | undefined, entered: (() => void) | undefined;
  const service = new NativeScheduleRegistryMainLegacy({
    acquire: async (windowId, registrationId) => {
      entered?.();
      await gate;
      if (windowId !== 1 || registrationId !== registration.registrationId)
        throw new ScheduleRegistryIpcError('access_denied');
      return {
        generation,
        actorId: accountId,
        machineId: row.machineId,
        client,
        options: {
          workspaceId,
          namespace: workspaceId,
          writer: 'trusted-main-sr',
          flush: async () => {},
          authority: { current: () => true, subscribe: () => () => {} },
        },
        assertCurrent() {
          if (
            main.ready(1, registrationId).owner !== 'native' ||
            readLocalScheduleRegistryOwner({ ...fixture, accountId, workspaceId }) !== 'native'
          )
            throw new ScheduleRegistryIpcError('restart_required');
        },
      };
    },
    send(_windowId, event) {
      events.push(event);
      for (const listener of listeners) listener(structuredClone(event));
    },
  });
  cleanup.push(() => service.close());
  const transport = {
    read: (r: { registrationId: string }) => service.read(1, r.registrationId),
    execute: (r: { registrationId: string; command: unknown; expectedGeneration: string }) =>
      service.execute(1, r.registrationId, r.command, r.expectedGeneration),
    flush: (r: { registrationId: string; expectedGeneration: string }) =>
      service.flush(1, r.registrationId, r.expectedGeneration),
    observe: (r: { registrationId: string; requestId: string }) =>
      service.observe(1, r.registrationId, r.requestId),
    unobserve: (r: { registrationId: string; requestId: string; leaseId: string }) =>
      service.unsubscribe(1, r.registrationId, r.requestId, r.leaseId),
    cancelObservation: (r: { registrationId: string; requestId: string }) =>
      service.cancelObservation(1, r.registrationId, r.requestId),
  };
  const makeSource = (overrides: Partial<typeof transport> = {}) => {
    const source = createNativeScheduleRegistryIpc({
      workspaceId,
      actorId: accountId,
      registrationId: registration.registrationId,
      transport: { ...transport, ...overrides },
      listen(receive) {
        listeners.add(receive);
        return () => {
          listeners.delete(receive);
        };
      },
    });
    cleanup.push(() => source.close());
    return source;
  };
  return {
    ...fixture,
    main,
    host,
    client,
    rival,
    generation,
    registrationId: registration.registrationId,
    service,
    transport,
    events,
    makeSource,
    holdAcquisition(value: Promise<void>) {
      gate = value;
      const signal = deferred<void>();
      entered = () => signal.resolve();
      return signal.promise;
    },
  };
}
describe.skipIf(process.platform === 'win32')(
  'actual local SR migration and owner selection',
  () => {
    it('migrates complete whole-workspace Meta under its own two-window witness and retains legacy source bytes', async () => {
      const fixture = await profile();
      const metaRoom = { kind: 'meta' as const, id: 'meta' };
      expect(
        await openNativeLocalWorkspaceMetaLegacy({
          ...fixture,
          accountId,
          workspaceId,
          encrypted: false,
          cloud: false,
          launch: launch(),
        })
      ).toBeNull();
      const metaGroup: RendererFlockGroup = { ...group, domain: 'meta', roomIds: ['meta'] };
      const before = readLegacySqliteFlockSource({
        databasePath: fixture.databasePath,
        room: metaRoom,
      }).snapshot;
      const renderer = Flock.strictFromFile(before);
      renderer.put(['e', 'session-meta'], true);
      renderer.put(['m', 'session-meta'], { title: 'Renderer legacy', future: { retained: true } });
      renderer.put(['m', 'session-meta', 'removed'], 'old');
      renderer.delete(['m', 'session-meta', 'removed']);
      await mkdir(path.join(fixture.dataRoot, 'native-repo'), { recursive: true });
      const wrongWitness = await profile();
      await mkdir(path.join(wrongWitness.dataRoot, 'native-repo'), { recursive: true });
      const srMain = windows(wrongWitness.dataRoot, wrongWitness.renderers);
      const srInput = await request(srMain, wrongWitness.dataRoot);
      await expect(
        migrateLocalWorkspaceMetaLegacy(
          { ...srInput, group: metaGroup },
          { executable: process.execPath, hostEntry: launch().entry }
        )
      ).rejects.toThrow('witness');
      expect(existsSync(wrongWitness.descriptor.dataDir)).toBe(false);
      const main = windows(
        fixture.dataRoot,
        [renderer.exportFile(), new Flock('absent-meta-idb').exportFile()],
        metaGroup
      );
      const input = await request(main, fixture.dataRoot, metaGroup);
      const receipt = await migrateLocalWorkspaceMetaLegacy(input, {
        executable: process.execPath,
        hostEntry: launch().entry,
      });
      expect(receipt.sourceCount).toBe(3);
      expect(receipt.roomId).toBe('meta');
      const journal = new NativeRepoMigrationJournal(
        path.join(fixture.descriptor.directory, 'routes.sqlite3')
      );
      try {
        expect(journal.route(JSON.stringify([accountId, workspaceId]), metaRoom).owner).toBe(
          'native'
        );
      } finally {
        journal.close();
      }
      await expect(
        openNativeLocalWorkspaceMetaLegacy({
          ...fixture,
          accountId,
          workspaceId,
          encrypted: false,
          cloud: false,
          launch: launch(),
        })
      ).rejects.toThrow('pending');
      await main.complete(input.revision);
      expect(main.status().owner).toBe('native');
      const cliOwner = await openNativeLocalWorkspaceMetaLegacy({
        ...fixture,
        accountId,
        workspaceId,
        encrypted: false,
        cloud: false,
        launch: launch(),
      });
      if (!cliOwner) throw new Error('Native Meta owner was not selected');
      cleanup.push(() => cliOwner.close());
      expect(await cliOwner.metadata.document('session-meta').read()).toMatchObject({
        title: 'Renderer legacy',
      });
      const bodyStore = await SqliteRepoStore.open({ path: fixture.databasePath });
      const storage = bodyStore.storage;
      const trap = async (): Promise<never> => {
        throw new Error('Legacy Meta persistence was reached');
      };
      const guarded = {
        ...storage,
        loadMeta: trap,
        loadMetaReplica: trap,
        compactMeta: trap,
        save: async (payload: Parameters<typeof storage.save>[0]) => {
          if (payload.type.startsWith('meta-')) await trap();
          return storage.save(payload);
        },
        ...(storage.saveMany
          ? {
              saveMany: async (payloads: Parameters<NonNullable<typeof storage.saveMany>>[0]) => {
                if (payloads.some((payload) => payload.type.startsWith('meta-'))) await trap();
                return storage.saveMany!(payloads);
              },
            }
          : {}),
      };
      try {
        if (Reflect.get(LoroRepo, 'externalMetadataCapability') !== 'loro-external-metadata-v1') {
          await expect(
            createRepoWithNativeWorkspaceMetaLegacy({ storageAdapter: guarded }, cliOwner)
          ).rejects.toThrow('unavailable');
        } else {
          const bodyRepo = await createRepoWithNativeWorkspaceMetaLegacy(
            { storageAdapter: guarded },
            cliOwner
          );
          try {
            expect(() => bodyRepo.getMeta()).toThrow();
            const doc = await bodyRepo.openPersistedDoc('session-body-meta');
            doc.doc.getText('body').insert(0, 'Synthetic persisted body');
            await bodyRepo.persistDocNow('session-body-meta', doc.doc);
            expect(
              (await cliOwner.externalMetadata.read()).docs.find(
                (row) => row.docId === 'session-body-meta'
              )
            ).toMatchObject({ deleted: false });
            const flock = await bodyRepo.openFlockDoc('synthetic-legacy-body');
            flock.flock.put(['body'], true);
            await bodyRepo.persistFlockDocNow('synthetic-legacy-body', flock.flock);
            expect(
              (await cliOwner.externalMetadata.read()).flockDocs.find(
                (row) => row.flockDocId === 'synthetic-legacy-body'
              )
            ).toMatchObject({ deleted: false });
            await bodyRepo.upsertDocMeta('session-body-meta', { title: 'Native implicit owner' });
            expect((await bodyRepo.getDocMeta('session-body-meta'))?.meta).toMatchObject({
              title: 'Native implicit owner',
            });
            await bodyRepo.deleteDoc('session-body-meta');
            await bodyRepo.restoreDoc('session-body-meta');
            await bodyRepo.flush();
            expect(await cliOwner.metadata.document('session-body-meta').read()).toMatchObject({
              title: 'Native implicit owner',
            });
          } finally {
            await bodyRepo.destroy();
          }
        }
      } finally {
        await bodyStore.close();
      }
      await cliOwner.close();
      const compiledHost = new IndependentNativeRepoHostLegacy({
        dataDir: fixture.descriptor.dataDir,
        binding: fixture.descriptor.binding,
        ...launch(),
      });
      cleanup.push(() => compiledHost.close());
      const client = await compiledHost.client();
      const owner = createNativeWorkspaceMeta({
        binding: { accountId, workspaceId },
        generation: 'synthetic-whole-meta',
        client,
        sdkCompatibility: await loadNativeRepoSdkCompatibility(import.meta.url),
        sdkArtifactId: (await compiledHost.leaseInfo(client)).sdkArtifactId,
        assertCurrent() {},
      });
      cleanup.push(() => owner.close());
      expect(await owner.document('session-meta').read()).toMatchObject({
        title: 'Renderer legacy',
        removed: null,
        future: { retained: true },
      });
      await owner.document('session-meta').patch({ title: 'Native persisted' });
      await owner.document('session-meta').flush();
      await owner.close();
      await compiledHost.close();
      const restartHost = new IndependentNativeRepoHostLegacy({
        dataDir: fixture.descriptor.dataDir,
        binding: fixture.descriptor.binding,
        ...launch(),
      });
      cleanup.push(() => restartHost.close());
      const restarted = await restartHost.client();
      const reopened = createNativeWorkspaceMeta({
        binding: { accountId, workspaceId },
        generation: 'synthetic-restart',
        client: restarted,
        sdkCompatibility: await loadNativeRepoSdkCompatibility(import.meta.url),
        sdkArtifactId: (await restartHost.leaseInfo(restarted)).sdkArtifactId,
        assertCurrent() {},
      });
      cleanup.push(() => reopened.close());
      expect(await reopened.document('session-meta').read()).toMatchObject({
        title: 'Native persisted',
        removed: null,
      });
      const previousRoot = process.env.LODY_DATA_DIR,
        previousPlatform = process.env.LODY_PLATFORM;
      process.env.LODY_DATA_DIR = fixture.dataRoot;
      process.env.LODY_PLATFORM = 'local';
      const presenceApplication = makeApplicationRuntime(
        WorkspacePresenceOwnersLive.pipe(
          Layer.provide(
            presencePlatformLayer(getLogger('native-meta-test'), async () => {
              throw new Error('No cloud access in local Meta acceptance');
            })
          )
        ),
        {
          recover: recoverCliPresenceApplicationShutdown,
          project: (cause) => new WorkspacePresenceLegacyFailure(cause),
        }
      );
      bindWorkspacePresenceApplicationLegacy(presenceApplication);
      let manager: LoroDocumentManager | undefined;
      try {
        manager = await LoroDocumentManager.create(
          workspaceId,
          accountId,
          getLogger('native-meta-test'),
          { nativeWorkspaceMetaLaunch: launch() }
        );
        expect(Reflect.get(manager.repo, 'metadataMode')).toBe('external');
        const managerRepo = manager.repo;
        expect(() => managerRepo.getMeta()).toThrow();
        const body = await manager.repo.openPersistedDoc('session-manager');
        body.doc.getText('body').insert(0, 'Actual manager persisted body');
        await manager.repo.persistDocNow('session-manager', body.doc);
        await manager.repo.upsertDocMeta('session-manager', {
          id: 'manager',
          title: 'Manager native Meta',
        });
        expect(await manager.workspaceDirectory.getEntry('session-manager')).toMatchObject({
          exists: true,
          meta: { title: 'Manager native Meta' },
        });
        expect(await reopened.document('session-manager').read()).toMatchObject({
          title: 'Manager native Meta',
        });
        await manager.syncMetaOrThrow();
        expect(await manager.waitUntilMetaSynced()).toBe(true);
        expect(await manager.exportNativeMetaSnapshot()).toBeInstanceOf(Uint8Array);
        await manager.cleanUp({ preserveSessionStatus: true });
      } finally {
        try {
          await manager?.cleanUp({ preserveSessionStatus: true });
        } finally {
          await presenceApplication.closeLegacy();
        }
        if (previousRoot === undefined) delete process.env.LODY_DATA_DIR;
        else process.env.LODY_DATA_DIR = previousRoot;
        if (previousPlatform === undefined) delete process.env.LODY_PLATFORM;
        else process.env.LODY_PLATFORM = previousPlatform;
      }
      expect(
        readLegacySqliteFlockSource({ databasePath: fixture.databasePath, room: metaRoom }).snapshot
      ).toEqual(before);
      const archives = (await readdir(fixture.descriptor.directory)).filter((name) =>
        name.startsWith('meta-sources-')
      );
      expect(archives).toHaveLength(1);
      const compatibility = await loadNativeRepoSdkCompatibility(import.meta.url);
      if (!compatibility) throw new Error('Synthetic SDK proof unavailable');
      const mainMeta = new NativeWorkspaceMetaOwnerLegacy({
        acquire: async () => {
          const currentClient = await restartHost.client();
          const lease = await restartHost.leaseInfo(currentClient);
          if (!lease.sdkArtifactId) throw new Error('Synthetic host artifact unavailable');
          return {
            binding: { accountId, workspaceId },
            generation: JSON.stringify([
              lease.engineRunId,
              lease.clientGeneration,
              lease.sdkArtifactId,
            ]),
            client: currentClient,
            sdkCompatibility: compatibility,
            sdkArtifactId: lease.sdkArtifactId,
            assertCurrent() {},
          };
        },
      });
      cleanup.push(() => mainMeta.close());
      const [mainFirst, mainShared] = await Promise.all([mainMeta.get(), mainMeta.get()]);
      expect(mainFirst).toBe(mainShared);
      expect(await mainFirst.document('session-meta').read()).toMatchObject({
        title: 'Native persisted',
      });
      await restarted.close();
      const replacement = await mainMeta.get();
      expect(replacement).not.toBe(mainFirst);
      expect(() => mainFirst.assertCurrent()).toThrow();
      expect(await replacement.document('session-manager').read()).toMatchObject({
        title: 'Manager native Meta',
      });
      const actualClient = await restartHost.client();
      const write = actualClient.flockBatch.bind(actualClient);
      const lostAck = new Error('Synthetic main Meta accepted ACK lost');
      const acceptedWrite = vi
        .spyOn(actualClient, 'flockBatch')
        .mockImplementationOnce(async (...args) => {
          await write(...args);
          throw lostAck;
        });
      await expect(
        replacement.document('session-manager').patch({ title: 'Accepted before lost ACK' })
      ).rejects.toBe(lostAck);
      acceptedWrite.mockRestore();
      expect(replacement.isWriteBlocked()).toBe(true);
      const acceptedHead = (await actualClient.flockScan(workspaceId, metaRoom)).roomTxId;
      const reconciled = await mainMeta.get();
      expect(reconciled.generation).not.toBe(replacement.generation);
      expect(reconciled.isWriteBlocked()).toBe(false);
      expect(() => replacement.assertCurrent()).toThrow();
      expect(await reconciled.document('session-manager').read()).toMatchObject({
        title: 'Accepted before lost ACK',
      });
      expect((await actualClient.flockScan(workspaceId, metaRoom)).roomTxId).toBe(acceptedHead);
      await reconciled.document('session-manager').patch({ title: 'New scope author' });
      expect((await actualClient.flockScan(workspaceId, metaRoom)).roomTxId).toBeGreaterThan(
        acceptedHead
      );
      await mainMeta.close();
      expect(
        (await (await restartHost.client()).flockScan(workspaceId, metaRoom)).entries.length
      ).toBeGreaterThan(0);
    });

    it('migrates complete SQLite and both window sources, preserves unrelated WF/Meta, and restarts the actual native registry consumer', async () => {
      const fixture = await profile();
      expect(
        await openNativeLocalScheduleRegistryLegacy({
          ...fixture,
          accountId,
          workspaceId,
          cloud: false,
          encrypted: false,
          launch: launch(),
        })
      ).toBeNull();
      expect(existsSync(fixture.descriptor.dataDir)).toBe(false);
      const oldSR = readLegacySqliteFlockSource({ databasePath: fixture.databasePath, room });
      const oldMeta = readLegacySqliteFlockSource({
        databasePath: fixture.databasePath,
        room: { kind: 'meta', id: 'meta' },
      });
      const oldWF = readLegacySqliteFlockSource({
        databasePath: fixture.databasePath,
        room: { kind: 'flock', id: `${workspaceId}:wf:workspace` },
      });
      await mkdir(path.join(fixture.dataRoot, 'native-repo'), { recursive: true });
      const main = windows(fixture.dataRoot, fixture.renderers);
      const input = await request(main, fixture.dataRoot);
      expect(readLocalScheduleRegistryOwner({ ...fixture, accountId, workspaceId })).toBe('frozen');
      await expect(
        openNativeLocalScheduleRegistryLegacy({
          ...fixture,
          accountId,
          workspaceId,
          cloud: false,
          encrypted: false,
          launch: launch(),
        })
      ).rejects.toThrow(/pending/);
      const receipt = await migrateLocalScheduleRegistryLegacy(input, {
        executable: process.execPath,
        hostEntry: launch().entry,
      });
      expect(receipt.sourceCount).toBe(3);
      expect(readLocalScheduleRegistryOwner({ ...fixture, accountId, workspaceId })).toBe('frozen');
      await main.complete(input.revision);
      expect(readLocalScheduleRegistryOwner({ ...fixture, accountId, workspaceId })).toBe('native');
      expect(
        digest(readLegacySqliteFlockSource({ databasePath: fixture.databasePath, room }).snapshot)
      ).toBe(digest(oldSR.snapshot));
      expect(
        digest(
          readLegacySqliteFlockSource({
            databasePath: fixture.databasePath,
            room: { kind: 'meta', id: 'meta' },
          }).snapshot
        )
      ).toBe(digest(oldMeta.snapshot));
      expect(
        digest(
          readLegacySqliteFlockSource({
            databasePath: fixture.databasePath,
            room: { kind: 'flock', id: `${workspaceId}:wf:workspace` },
          }).snapshot
        )
      ).toBe(digest(oldWF.snapshot));
      const owner = await openNativeLocalScheduleRegistryLegacy({
        ...fixture,
        accountId,
        workspaceId,
        cloud: false,
        encrypted: false,
        launch: launch(),
      });
      if (!owner) throw new Error('Missing native SR owner');
      cleanup.push(() => owner.close());
      expect((await owner.registry.read()).manuals).toHaveLength(1);
      let updated!: () => void;
      let failed!: (error: unknown) => void;
      const visible = new Promise<void>((resolve, reject) => {
        updated = resolve;
        failed = reject;
      });
      const observation = await owner.registry.observe((state) => {
        if (state.schedules[0]?.title === 'Native edited') updated();
      }, failed);
      cleanup.push(() => observation.close());
      await owner.registry.execute({ kind: 'publish', row: { ...row, title: 'Native edited' } });
      await visible;
      await observation.close();
      await owner.close();
      const reopened = await openNativeLocalScheduleRegistryLegacy({
        ...fixture,
        accountId,
        workspaceId,
        cloud: false,
        encrypted: false,
        launch: launch(),
      });
      if (!reopened) throw new Error('Missing reopened SR owner');
      cleanup.push(() => reopened.close());
      expect((await reopened.registry.read()).schedules[0]?.title).toBe('Native edited');
      await expect(
        openNativeLocalScheduleRegistryLegacy({
          ...fixture,
          accountId,
          workspaceId,
          cloud: true,
          encrypted: false,
          launch: launch(),
        })
      ).rejects.toThrow(/unsupported/);
      await reopened.close();
      await rm(fixture.descriptor.dataDir, { recursive: true });
      await expect(
        openNativeLocalScheduleRegistryLegacy({
          ...fixture,
          accountId,
          workspaceId,
          cloud: false,
          encrypted: false,
          launch: launch(),
        })
      ).rejects.toThrow();
      expect(existsSync(fixture.descriptor.dataDir)).toBe(false);
    });

    it('preserves a complete binary rollback and starts a new source epoch for later legacy edits', async () => {
      const fixture = await profile();
      await mkdir(path.join(fixture.dataRoot, 'native-repo'), { recursive: true });
      const main = windows(fixture.dataRoot, fixture.renderers);
      const input = await request(main, fixture.dataRoot);
      const first = await migrateLocalScheduleRegistryLegacy(input, {
        executable: process.execPath,
        hostEntry: launch().entry,
      });
      await main.complete(input.revision);
      const native = await openNativeLocalScheduleRegistryLegacy({
        ...fixture,
        accountId,
        workspaceId,
        cloud: false,
        encrypted: false,
        launch: launch(),
      });
      if (!native) throw new Error('Missing native SR owner');
      cleanup.push(() => native.close());
      await native.registry.execute({
        kind: 'publish',
        row: { ...row, title: 'Native before rollback' },
      });
      await native.close();
      main.close();
      // Trusted rollback maintenance starts only after all original producers have
      // retired. Its SR marker stays frozen until an explicit forward publication.
      const marker = new Database(
        path.join(fixture.dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3')
      );
      try {
        marker.pragma('synchronous = FULL');
        marker
          .prepare("UPDATE renderer_flock_group_owners SET owner='frozen',revision=? WHERE scope=?")
          .run(randomUUID(), rendererFlockGroupScope(group));
      } finally {
        marker.close();
      }
      const host = new IndependentNativeRepoHostLegacy({
        dataDir: fixture.descriptor.dataDir,
        binding: fixture.descriptor.binding,
        ...launch(),
      });
      cleanup.push(() => host.close());
      const client = await host.client();
      const store = await SqliteRepoStore.open({ path: fixture.databasePath });
      cleanup.push(() => store.close());
      const repo = await LoroRepo.create({ storageAdapter: store.storage });
      cleanup.push(() => repo.destroy());
      const legacy = await repo.openFlockDoc(room.id);
      const rollback = await createNativeLocalScheduleRegistryLegacy({
        accountId,
        workspaceId,
        dataRoot: fixture.dataRoot,
        getClient: () => host.client(),
        flushNative: async () => {
          await client.compactRoom(workspaceId, room);
        },
        freezeExternalOwners: async (id) => {
          expect(id).toBe(room.id);
          expect(readLocalScheduleRegistryOwner({ ...fixture, accountId, workspaceId })).toBe(
            'frozen'
          );
        },
      });
      cleanup.push(() => rollback.close());
      await rollback.rollback({
        async mergeAndPersist(snapshot) {
          const before = readLegacySqliteFlockSource({
            databasePath: fixture.databasePath,
            room,
          }).snapshot;
          legacy.flock.strictImportFile(snapshot);
          await repo.persistFlockDocNow(room.id, legacy.flock);
          await repo.flush();
          return {
            before,
            after: readLegacySqliteFlockSource({ databasePath: fixture.databasePath, room })
              .snapshot,
          };
        },
      });
      expect(rollback.owner()).toBe('legacy');
      expect(legacy.flock.get(scheduleRegistryKeys.schedule(row.scheduleId))).toMatchObject({
        title: 'Native before rollback',
        future: { retained: true },
      });
      expect(legacy.flock.get(['deleted'])).toBeUndefined();
      // The maintenance owner authors this new legacy generation while ordinary
      // readers/writers remain fenced; no renderer or daemon is re-admitted here.
      legacy.flock.put(scheduleRegistryKeys.schedule(row.scheduleId), {
        ...row,
        title: 'Legacy after rollback',
        future: { retained: true },
      });
      await repo.persistFlockDocNow(room.id, legacy.flock);
      await repo.flush();
      await repo.destroy();
      await store.close();
      await rollback.close();
      await host.close();
      expect(readLocalScheduleRegistryOwner({ ...fixture, accountId, workspaceId })).toBe('frozen');
      const nextMain = windows(fixture.dataRoot, fixture.renderers);
      const nextInput = await request(nextMain, fixture.dataRoot);
      const second = await migrateLocalScheduleRegistryLegacy(nextInput, {
        executable: process.execPath,
        hostEntry: launch().entry,
      });
      expect(second.sourceSha256).not.toBe(first.sourceSha256);
      await nextMain.complete(nextInput.revision);
      const reopened = await openNativeLocalScheduleRegistryLegacy({
        ...fixture,
        accountId,
        workspaceId,
        cloud: false,
        encrypted: false,
        launch: launch(),
      });
      if (!reopened) throw new Error('Missing remigrated SR owner');
      cleanup.push(() => reopened.close());
      expect((await reopened.registry.read()).schedules[0]?.title).toBe('Legacy after rollback');
      expect(
        (await readdir(fixture.descriptor.directory)).filter((name) =>
          /^sr-sources-.*\.json$/.test(name)
        )
      ).toHaveLength(2);
    });
    it('rejects incomplete MF window admission as an SR witness and preserves the SR source', async () => {
      const fixture = await profile();
      await mkdir(path.join(fixture.dataRoot, 'native-repo'), { recursive: true });
      const machine = new RendererFlockRoomGroupMigrationMainLegacy({
        group: { ...group, domain: 'machine', roomIds: [`${workspaceId}:mf:synthetic-machine`] },
        databasePath: path.join(
          fixture.dataRoot,
          'native-repo',
          'renderer-flock-group-owners.sqlite3'
        ),
        registeredWindowIds: () => [],
        send() {},
        readCommittedOwner: async () => 'legacy',
      });
      cleanup.push(() => machine.close());
      const initialStatus = machine.status();
      await expect(machine.freeze()).rejects.toThrow(/window/);
      expect(machine.status().owner).toBe('legacy');
      expect(machine.status()).toEqual(initialStatus);
      const before = readLegacySqliteFlockSource({
        databasePath: fixture.databasePath,
        room,
      }).snapshot;
      expect(readLocalScheduleRegistryOwner({ ...fixture, accountId, workspaceId })).toBe('legacy');
      const input = {
        version: 1,
        dataRoot: fixture.dataRoot,
        revision: machine.status().revision,
        group,
        sources: [],
      };
      await expect(
        migrateLocalScheduleRegistryLegacy(input, {
          executable: process.execPath,
          hostEntry: launch().entry,
        })
      ).rejects.toThrow(/freeze witness/);
      expect(
        readLegacySqliteFlockSource({ databasePath: fixture.databasePath, room }).snapshot
      ).toEqual(before);
      expect(existsSync(fixture.descriptor.dataDir)).toBe(false);
      expect(
        nativeScheduleRegistryMigrationInputSchema.safeParse({ ...input, group: machine.group })
          .success
      ).toBe(false);
      expect(
        nativeScheduleRegistryMigrationInputSchema.safeParse({
          ...input,
          group: { ...group, roomIds: ['meta'] },
        }).success
      ).toBe(false);
    });
    it('uses the real shared SR backend through finite main/renderer ports and keeps private rows and daemon writes out of IPC', async () => {
      const f = await domainBridge();
      const stored = await f.client.flockGet(
        workspaceId,
        room,
        scheduleRegistryKeys.schedule(row.scheduleId)
      );
      await f.client.flockBatch(workspaceId, room, [
        {
          op: 'put',
          key: scheduleRegistryKeys.schedule(row.scheduleId),
          value: {
            ...(stored.value as Record<string, never>),
            privateFuture: 'SYNTHETIC_SR_PRIVATE_FUTURE',
          },
        },
      ]);
      const source = f.makeSource();
      await source.start();
      expect(JSON.stringify(await source.registry.read())).not.toContain(
        'SYNTHETIC_SR_PRIVATE_FUTURE'
      );
      const seen = deferred<void>();
      const errors: unknown[] = [];
      const observation = await source.registry.observe(
        (state) => {
          if (state.schedules[0]?.title === 'UI authored through main') seen.resolve();
        },
        (error) => errors.push(error)
      );
      cleanup.push(() => observation.close());
      await source.registry.execute({
        kind: 'publish',
        row: { ...row, title: 'UI authored through main' },
      });
      await seen.promise;
      await source.registry.flush();
      expect(
        (await f.client.flockGet(workspaceId, room, scheduleRegistryKeys.schedule(row.scheduleId)))
          .value
      ).toMatchObject({
        title: 'UI authored through main',
        ownerId: accountId,
        privateFuture: 'SYNTHETIC_SR_PRIVATE_FUTURE',
        future: { retained: true },
      });
      expect(JSON.stringify(f.events)).not.toContain('SYNTHETIC_SR_PRIVATE_FUTURE');
      await source.registry.execute({
        kind: 'request-run',
        request: {
          scheduleId: row.scheduleId,
          actorId: accountId,
          activationId: row.activationId,
          manualRunId: 'ui-request',
          requestedAt: 3,
        },
      });
      expect(
        (
          await f.client.flockGet(
            workspaceId,
            room,
            scheduleRegistryKeys.manual(row.scheduleId, 'ui-request')
          )
        ).value
      ).toMatchObject({ actorId: accountId });
      const before = await f.client.flockScan(workspaceId, room);
      await expect(
        f.service.execute(
          1,
          f.registrationId,
          { kind: 'tombstone', scheduleId: row.scheduleId, actorId: 'forged', now: 4 },
          f.generation
        )
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        source.registry.execute({
          kind: 'tombstone',
          scheduleId: row.scheduleId,
          actorId: 'forged',
          now: 4,
        })
      ).rejects.toMatchObject({ code: 'access_denied' });
      await expect(
        f.service.execute(1, f.registrationId, { kind: 'put-runtime', runtime: {} }, f.generation)
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        f.service.execute(
          1,
          f.registrationId,
          { kind: 'publish', row: { ...row, title: 'stale owner' } },
          'stale-generation'
        )
      ).rejects.toMatchObject({ code: 'restart_required' });
      expect((await f.client.flockScan(workspaceId, room)).roomTxId).toBe(before.roomTxId);
      await observation.close();
      await source.close();
      expect(errors).toEqual([]);
    });
    it('rechecks ownership inside the actual SR CAS snapshot before publishing a UI command', async () => {
      const f = await domainBridge();
      const source = f.makeSource();
      await source.start();
      const scan = f.client.flockScan.bind(f.client);
      let mutate = true;
      const intercept = vi.spyOn(f.client, 'flockScan').mockImplementation(async (...args) => {
        const state = await scan(...args);
        if (mutate) {
          mutate = false;
          await f.rival.flockBatch(workspaceId, room, [
            {
              op: 'put',
              key: scheduleRegistryKeys.schedule(row.scheduleId),
              value: { ...row, ownerId: 'foreign-owner', title: 'Ownership changed' },
            },
          ]);
        }
        return state;
      });
      cleanup.push(() => intercept.mockRestore());
      await expect(
        source.registry.execute({ kind: 'publish', row: { ...row, title: 'must not overwrite' } })
      ).rejects.toMatchObject({ code: 'access_denied' });
      expect(
        (await f.rival.flockGet(workspaceId, room, scheduleRegistryKeys.schedule(row.scheduleId)))
          .value
      ).toMatchObject({ ownerId: 'foreign-owner', title: 'Ownership changed' });
      await f.rival.flockBatch(workspaceId, room, [
        {
          op: 'put',
          key: scheduleRegistryKeys.schedule(row.scheduleId),
          value: { ...row, ownerId: 'foreign-owner', title: 42 },
        },
      ]);
      const malformed = await f.rival.flockGet(
        workspaceId,
        room,
        scheduleRegistryKeys.schedule(row.scheduleId)
      );
      await expect(
        source.registry.execute({
          kind: 'publish',
          row: { ...row, title: 'must not claim a malformed foreign row' },
        })
      ).rejects.toMatchObject({ code: 'access_denied' });
      expect(
        (await f.rival.flockGet(workspaceId, room, scheduleRegistryKeys.schedule(row.scheduleId)))
          .roomTxId
      ).toBe(malformed.roomTxId);

      await source.close();
    });
    it('retains unknown native unsubscribe outcomes until actual transport loss without stopping a sibling host lease', async () => {
      const f = await domainBridge();
      const keepAlive = new IndependentNativeRepoHostLegacy({
        dataDir: f.descriptor.dataDir,
        binding: f.descriptor.binding,
        ...launch(),
      });
      cleanup.push(() => keepAlive.close());
      const sibling = await keepAlive.client();
      const subscribe = f.client.flockSubscribe.bind(f.client);
      const intercept = vi.spyOn(f.client, 'flockSubscribe').mockImplementation(async (...args) => {
        const handle = await subscribe(...args),
          unsubscribe = handle.unsubscribe.bind(handle);
        handle.unsubscribe = async () => {
          await unsubscribe();
          throw new Error('Synthetic native unsubscribe ACK lost');
        };
        return handle;
      });
      cleanup.push(() => intercept.mockRestore());
      const requestId = randomUUID();
      const lease = await f.service.observe(1, f.registrationId, requestId);
      await expect(
        f.service.unsubscribe(1, f.registrationId, requestId, lease.leaseId)
      ).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      await expect(f.service.close()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      await expect(f.service.close()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      await f.client.close();
      await f.service.close();
      expect(
        (await sibling.flockGet(workspaceId, room, scheduleRegistryKeys.schedule(row.scheduleId)))
          .value
      ).toMatchObject({ ownerId: accountId });
      expect((await keepAlive.leaseInfo(sibling)).engineRunId).toBe(
        (await f.host.leaseInfo()).engineRunId
      );
    });
    it('retains an unknown renderer observe/cancel ACK and proves release using the same exact logical request', async () => {
      const f = await domainBridge();
      let cancelLost = true;
      const canceled = new Set<string>();
      const source = f.makeSource({
        observe: async (request) => {
          await f.transport.observe(request);
          throw new Error('Synthetic observe ACK lost');
        },
        cancelObservation: async (request) => {
          canceled.add(request.requestId);
          const result = await f.transport.cancelObservation(request);
          if (cancelLost) {
            cancelLost = false;
            throw new Error('Synthetic cancellation ACK lost');
          }
          return result;
        },
      });
      await source.start();
      await expect(
        source.registry.observe(
          () => {},
          () => {}
        )
      ).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      await source.retryCleanup();
      expect(canceled.size).toBe(1);
      const requestId = [...canceled][0];
      if (!requestId) throw new Error('Missing canceled request');
      await expect(f.service.observe(1, f.registrationId, requestId)).rejects.toMatchObject({
        code: 'restart_required',
      });
      expect(
        (await f.client.flockGet(workspaceId, room, scheduleRegistryKeys.schedule(row.scheduleId)))
          .value
      ).toMatchObject({ title: 'Legacy schedule' });
    });
    it('joins a late trusted grant on main close without publishing or opening a successor owner', async () => {
      const f = await domainBridge(),
        gate = deferred<void>();
      const before = await f.client.flockScan(workspaceId, room);
      const entered = f.holdAcquisition(gate.promise);
      const read = f.service.read(1, f.registrationId);
      const rejected = expect(read).rejects.toMatchObject({ code: 'restart_required' });
      await entered;
      const closed = f.service.close();
      gate.resolve();
      await rejected;
      await closed;
      expect(f.events).toEqual([]);
      expect((await f.client.flockScan(workspaceId, room)).roomTxId).toBe(before.roomTxId);
    });
  }
);

it.skipIf(process.platform === 'win32')(
  'switches the retained renderer SR domain observer from frozen admission to the actual native main port without reopening a legacy registry',
  async () => {
    const { createRendererScheduleRegistryOwner } =
      await import('../../../../../packages/components/src/providers/renderer-schedule-registry-owner');
    const { RendererFlockRoomGroupFreeze } =
      await import('../../../../../packages/components/src/providers/renderer-flock-room-group-freeze');
    const fixture = await domainBridge();
    const source = fixture.makeSource();
    await source.start();
    const revision = 'renderer-domain-fixture';
    const gate = new RendererFlockRoomGroupFreeze(group, {
      readStartupOwner: async () => ({ group, owner: 'frozen', revision }),
      detachRooms: async () => {},
      persistRooms: async () => {},
    });
    gate.bindRegistration(fixture.registrationId);
    await gate.startup();
    const dispatcher = createRendererScheduleRegistryOwner({
      workspaceId,
      gate,
      legacy() {
        throw new Error('Selected SR must never reopen the legacy room');
      },
      native: async () => {
        await source.start();
        return source.registry;
      },
    });
    cleanup.push(() => dispatcher.close());
    await expect(dispatcher.registry.read()).rejects.toMatchObject({ code: 'restart_required' });
    await expect(
      dispatcher.registry.execute({
        kind: 'request-run',
        request: {
          scheduleId: row.scheduleId,
          actorId: accountId,
          manualRunId: 'frozen-write',
          activationId: row.activationId,
          requestedAt: 50,
        },
      })
    ).rejects.toMatchObject({ code: 'restart_required' });
    const subscribed = deferred<void>(),
      delivered = deferred<void>();
    const snapshots: import('@lody/shared').ScheduleRegistrySnapshot[] = [];
    const observer = await dispatcher.registry.observe(
      (snapshot) => {
        snapshots.push(snapshot);
        if (snapshot.synced) subscribed.resolve();
        if (snapshot.manuals.some((manual) => manual.manualRunId === 'published-write'))
          delivered.resolve();
      },
      (cause) => {
        subscribed.reject(cause);
        delivered.reject(cause);
      }
    );
    cleanup.push(() => observer.close());
    expect(snapshots).toHaveLength(0);
    gate.published({ group, registrationId: fixture.registrationId, owner: 'native', revision });
    await subscribed.promise;
    expect(snapshots.at(-1)?.schedules[0]?.title).toBe('Legacy schedule');
    await dispatcher.registry.execute({
      kind: 'request-run',
      request: {
        scheduleId: row.scheduleId,
        actorId: accountId,
        manualRunId: 'published-write',
        activationId: row.activationId,
        requestedAt: 51,
      },
    });
    await delivered.promise;
    const persisted = await fixture.client.flockGet(
      workspaceId,
      room,
      scheduleRegistryKeys.manual(row.scheduleId, 'published-write')
    );
    expect(persisted.value).toMatchObject({ manualRunId: 'published-write', actorId: accountId });
    const frozen = await fixture.client.flockGet(
      workspaceId,
      room,
      scheduleRegistryKeys.manual(row.scheduleId, 'frozen-write')
    );
    expect(frozen.value).toBeNull();
    await observer.close();
    await dispatcher.close();
    await source.close();
    expect(
      (
        await fixture.rival.flockGet(
          workspaceId,
          room,
          scheduleRegistryKeys.schedule(row.scheduleId)
        )
      ).value
    ).toMatchObject({ title: 'Legacy schedule' });
  }
);
