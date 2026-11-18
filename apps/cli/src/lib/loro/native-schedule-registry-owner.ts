import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rendererFlockGroupSchema,
  rendererFlockGroupScope,
  rendererFlockGroupKey,
} from '@lody/shared/renderer-flock-room-group';
import { isLocalUserId, isLocalWorkspaceId } from '@lody/shared/platform-kind';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { getCliNodeExecutable } from '../managed-daemon-release';
import { toShared } from '@/platform/process-options';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { createNativeScheduleRegistry } from '@lody/shared/node/native-schedule-registry';
import { getScheduleRegistryFlockDocId, type WorkspaceId } from '@lody/shared';
import { NativeRepoMigrationJournal } from './native-repo-migration';
import {
  createNativeRoomMigrationCoordinatorLegacy,
  NativeRoomMigrationAdmission,
  type NativeRoomMigrationSource,
} from './native-repo-room-migration';

/** Explicit local plaintext composition. This does not select native by a flag,
 * start an engine, own the borrowed host, or substitute the WF window fence. */
export async function createNativeLocalScheduleRegistryLegacy(options: {
  accountId: string;
  workspaceId: WorkspaceId;
  dataRoot: string;
  /** Must be the independent descriptor's existing trusted host lease. */
  getClient(): Promise<RepoClient>;
  /** Freeze the COMPLETE SR inventory: every renderer, daemon and one-shot writer.
   * Callers must keep this SR-specific fence durable through publish/rollback. */
  freezeExternalOwners(roomId: string): Promise<void>;
  flushNative(): Promise<void>;
}) {
  if (!isLocalUserId(options.accountId) || !isLocalWorkspaceId(options.workspaceId))
    throw new Error('Local SR identity is required');
  const selected = resolveLocalIndependentRepo({ platform: 'local', ...options });
  if (existsSync(join(selected.classicDirectory, 'routes.sqlite3')))
    throw new Error('Classic SR ownership requires explicit migration');
  await mkdir(selected.directory, { recursive: true, mode: 0o700 });
  const journal = new NativeRepoMigrationJournal(join(selected.directory, 'routes.sqlite3'));
  const binding = JSON.stringify([options.accountId, options.workspaceId]);
  const room = { kind: 'flock' as const, id: getScheduleRegistryFlockDocId(options.workspaceId) };
  const admission = new NativeRoomMigrationAdmission(journal, binding);
  let closed = false;
  let operation: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) throw new Error('SR owner is closed');
  };
  const assertNative = () => {
    assertOpen();
    const route = journal.routeGroup(binding, [room]);
    if (
      journal.isMaintained(binding, room) ||
      route.owner !== 'native' ||
      route.targetGeneration !== 'engine-0.1.0-v1'
    )
      throw new Error('SR migration is pending');
    const database = new Database(
      join(
        selected.dataDir,
        'namespaces',
        `ns_${Buffer.from(options.workspaceId).toString('hex')}.sqlite3`
      ),
      { readonly: true, fileMustExist: true, timeout: 0 }
    );
    try {
      const version = database.prepare("SELECT v FROM v2_meta WHERE k='schema_version'").get() as
        | { v: number }
        | undefined;
      const stored = database
        .prepare('SELECT encryption FROM v2_rooms WHERE room_kind=2 AND room_id=?')
        .get(room.id) as { encryption: number } | undefined;
      if (version?.v !== 1 || stored?.encryption !== 0)
        throw new Error('Published SR storage requires recovery');
    } finally {
      database.close();
    }
  };
  const registry = createNativeScheduleRegistry({
    workspaceId: options.workspaceId,
    namespace: options.workspaceId,
    writer: `local-sr:${binding}`,
    getClient: options.getClient,
    assertAccess: assertNative,
    flush: options.flushNative,
    authority: {
      current: () => {
        try {
          assertNative();
          return true;
        } catch {
          return false;
        }
      },
      subscribe: () => () => {},
    },
  });
  const coordinator = async () => {
    assertOpen();
    const client = await options.getClient();
    assertOpen();
    return createNativeRoomMigrationCoordinatorLegacy({
      binding,
      namespace: options.workspaceId,
      targetGeneration: 'engine-0.1.0-v1',
      directory: selected.directory,
      dataDir: selected.dataDir,
      journal,
      client,
      admission,
      freezeExternalOwners: async () => {
        assertOpen();
        await options.freezeExternalOwners(room.id);
        assertOpen();
      },
      beforePublish: async () => assertOpen(),
    });
  };
  const run = (work: () => Promise<void>): Promise<void> => {
    assertOpen();
    if (operation) return Promise.reject(new Error('SR migration already active'));
    const pending = work().finally(() => {
      if (operation === pending) operation = undefined;
    });
    operation = pending;
    return pending;
  };
  return {
    registry,
    owner: () =>
      journal.isMaintained(binding, room)
        ? ('frozen' as const)
        : journal.routeGroup(binding, [room]).owner,
    /** An unknown ACK resumes the journal's original binary archive, not new input. */
    migrate(sources: readonly NativeRoomMigrationSource[]) {
      return run(async () => {
        const migration = await coordinator();
        await migration.migrate([
          {
            room,
            sources: sources.map((source) => ({
              sourceId: source.sourceId,
              snapshot: async () => {
                assertOpen();
                const bytes = await source.snapshot();
                assertOpen();
                return bytes;
              },
            })),
          },
        ]);
      });
    },
    rollback(legacy: {
      mergeAndPersist(native: Uint8Array): Promise<{ before: Uint8Array; after: Uint8Array }>;
    }) {
      return run(async () => {
        // Retire this native port and join its sent writes before export. Other
        // processes and legacy replicas are covered by the separate SR fence.
        await registry.close();
        const migration = await coordinator();
        await migration.rollback([room], {
          mergeAndPersist: async (_room, native) => {
            assertOpen();
            const result = await legacy.mergeAndPersist(native);
            assertOpen();
            return result;
          },
        });
      });
    },
    async close() {
      closed = true;
      // The composition releases its borrowed host lease independently, then may
      // retry this exact owner after transport loss proves an uncertain unsubscribe.
      const failures: unknown[] = [];
      try {
        await registry.close();
      } catch (error) {
        failures.push(error);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (operation)
          await Promise.race([
            operation.catch(() => {}),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('SR migration drain remains pending')),
                5000
              );
            }),
          ]);
      } catch (error) {
        failures.push(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (failures.length) throw new AggregateError(failures, 'SR owner cleanup unconfirmed');
      journal.close();
    },
  };
}

/** Read the SR-specific persistent decision without creating a host or database.
 * A WF/MF selection grants no authority over this room. */
export function readLocalScheduleRegistryOwner(options: {
  dataRoot: string;
  accountId: string;
  workspaceId: string;
}): 'legacy' | 'frozen' | 'native' {
  return readLocalFlockGroupOwner(options, {
    domain: 'schedule',
    room: { kind: 'flock', id: getScheduleRegistryFlockDocId(options.workspaceId as WorkspaceId) },
  });
}

/** Read-only admission shared by the exact SR and whole-workspace Meta owners. */
export function readLocalFlockGroupOwner(
  options: { dataRoot: string; accountId: string; workspaceId: string },
  selection: { domain: 'schedule' | 'meta'; room: { kind: 'flock' | 'meta'; id: string } }
): 'legacy' | 'frozen' | 'native' {
  const roomId = selection.room.id;
  if (
    selection.domain === 'meta'
      ? selection.room.kind !== 'meta' || roomId !== 'meta'
      : selection.room.kind !== 'flock' ||
        roomId !== getScheduleRegistryFlockDocId(options.workspaceId as WorkspaceId)
  )
    throw new Error('Invalid local room owner selection');
  const descriptor = resolveLocalIndependentRepo({ platform: 'local', ...options });
  let main: 'legacy' | 'frozen' | 'native' = 'legacy';
  const marker = join(options.dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3');
  if (existsSync(marker)) {
    const db = new Database(marker, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      const group = rendererFlockGroupSchema.parse({
        accountId: options.accountId,
        workspaceId: options.workspaceId,
        domain: selection.domain,
        contentMode: 'plaintext',
        roomIds: [roomId],
      });
      const scope = rendererFlockGroupScope(group);
      const row = db
        .prepare('SELECT owner,group_json FROM renderer_flock_group_owners WHERE scope=?')
        .get(scope) as { owner: string; group_json: string } | undefined;
      const claim = db
        .prepare('SELECT group_scope FROM renderer_flock_group_rooms WHERE binding=? AND room_id=?')
        .get(JSON.stringify([options.accountId, options.workspaceId, 'plaintext']), roomId) as
        | { group_scope: string }
        | undefined;
      if (row || claim) {
        if (
          !row ||
          claim?.group_scope !== scope ||
          rendererFlockGroupKey(rendererFlockGroupSchema.parse(JSON.parse(row.group_json))) !==
            rendererFlockGroupKey(group) ||
          !['frozen', 'native'].includes(row.owner)
        )
          throw new Error('Unsupported local room group owner');
        main = row.owner as 'frozen' | 'native';
      }
    } finally {
      db.close();
    }
  }
  const file = join(descriptor.directory, 'routes.sqlite3');
  if (!existsSync(file)) return main === 'native' ? 'frozen' : main;
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    return db.transaction(() => {
      const binding = JSON.stringify([options.accountId, options.workspaceId]);
      const roomKey = JSON.stringify(selection.room);
      if (
        main === 'frozen' ||
        db
          .prepare('SELECT 1 FROM native_room_maintenance WHERE binding=? AND room_key=?')
          .get(binding, roomKey)
      )
        return 'frozen' as const;
      const row = db
        .prepare('SELECT stage FROM native_room_migrations WHERE binding=? AND room_key=?')
        .get(binding, roomKey) as { stage: string } | undefined;
      if (!row || row.stage === 'legacy')
        return main === 'native' ? ('frozen' as const) : ('legacy' as const);
      if (row.stage === 'native')
        return selection.domain === 'meta' && main !== 'native'
          ? ('frozen' as const)
          : ('native' as const);
      if (row.stage === 'frozen' || row.stage === 'verified') return 'frozen' as const;
      throw new Error('Unsupported local room migration stage');
    })();
  } finally {
    db.close();
  }
}

export function isLegacyLocalScheduleRegistryCurrent(
  accountId: string,
  workspaceId: WorkspaceId
): boolean {
  return (
    !isLocalUserId(accountId) ||
    !isLocalWorkspaceId(workspaceId) ||
    readLocalScheduleRegistryOwner({
      dataRoot: getLodyDataDir('local'),
      accountId,
      workspaceId,
    }) === 'legacy'
  );
}

function assertLocalScheduleRegistryStorage(options: {
  dataRoot: string;
  accountId: string;
  workspaceId: WorkspaceId;
}): void {
  const selected = resolveLocalIndependentRepo({ platform: 'local', ...options });
  const database = new Database(
    join(
      selected.dataDir,
      'namespaces',
      `ns_${Buffer.from(options.workspaceId).toString('hex')}.sqlite3`
    ),
    {
      readonly: true,
      fileMustExist: true,
      timeout: 0,
    }
  );
  try {
    const version = database.prepare("SELECT v FROM v2_meta WHERE k='schema_version'").get() as
      | { v: number }
      | undefined;
    const room = database
      .prepare('SELECT encryption FROM v2_rooms WHERE room_kind=2 AND room_id=?')
      .get(getScheduleRegistryFlockDocId(options.workspaceId)) as
      | { encryption: number }
      | undefined;
    if (version?.v !== 1 || room?.encryption !== 0)
      throw new Error('Published SR storage requires recovery');
  } finally {
    database.close();
  }
}

/** Actual daemon/one-shot composition. Its private independent lease shares the
 * engine with main; retiring this owner never releases another process's lease. */
export class NativeLocalScheduleRegistryLegacy {
  readonly registry;
  private readonly host: IndependentNativeRepoHostLegacy;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly options: {
      accountId: string;
      workspaceId: WorkspaceId;
      dataRoot: string;
      requiredSdkArtifactId: string;
      launch?: { executable: string; entry: string };
    }
  ) {
    const descriptor = resolveLocalIndependentRepo({ platform: 'local', ...options });
    this.host = new IndependentNativeRepoHostLegacy(
      {
        dataDir: descriptor.dataDir,
        binding: descriptor.binding,
        requiredSdkArtifactId: options.requiredSdkArtifactId,
        ...(options.launch ?? {
          executable: getCliNodeExecutable(),
          entry: join(dirname(fileURLToPath(import.meta.url)), 'native-repo-independent-host.js'),
        }),
      },
      toShared()
    );
    const current = () => {
      if (this.closed || readLocalScheduleRegistryOwner(options) !== 'native')
        throw new Error('SR owner restart required');
      assertLocalScheduleRegistryStorage(options);
    };
    this.registry = createNativeScheduleRegistry({
      workspaceId: options.workspaceId,
      namespace: options.workspaceId,
      writer: `local-sr:${JSON.stringify([options.accountId, options.workspaceId])}`,
      getClient: async () => {
        current();
        const client = await this.host.client();
        current();
        return client;
      },
      assertAccess: current,
      flush: async () => current(),
      authority: {
        current: () => {
          try {
            current();
            return true;
          } catch {
            return false;
          }
        },
        subscribe: () => () => {},
      },
    });
  }
  async ready(): Promise<void> {
    await this.registry.read();
  }
  close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    const work = (async () => {
      const first = await Promise.allSettled([this.registry.close(), this.host.close()]);
      const failures: unknown[] = first[1].status === 'rejected' ? [first[1].reason] : [];
      if (first[0].status === 'rejected') {
        try {
          await this.registry.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Native SR owner cleanup unconfirmed');
    })();
    this.closing = work;
    void work
      .finally(() => {
        if (this.closing === work) this.closing = undefined;
      })
      .catch(() => {});
    return work;
  }
}

export async function openNativeLocalScheduleRegistryLegacy(options: {
  accountId: string;
  workspaceId: WorkspaceId;
  encrypted: boolean;
  cloud: boolean;
  dataRoot?: string;
  launch?: { executable: string; entry: string };
}): Promise<NativeLocalScheduleRegistryLegacy | null> {
  if (!isLocalUserId(options.accountId) || !isLocalWorkspaceId(options.workspaceId)) return null;
  const dataRoot = options.dataRoot ?? getLodyDataDir('local');
  const state = readLocalScheduleRegistryOwner({ ...options, dataRoot });
  if (state === 'legacy') return null;
  if (state !== 'native' || options.encrypted || options.cloud)
    throw new Error('Native SR migration is pending or unsupported');
  assertLocalScheduleRegistryStorage({ ...options, dataRoot });
  const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
  if (!proof) throw new Error('Native SR requires a verified compatible SDK artifact');
  const owner = new NativeLocalScheduleRegistryLegacy({
    ...options,
    dataRoot,
    requiredSdkArtifactId: proof.artifactId,
  });
  try {
    await owner.ready();
    return owner;
  } catch (error) {
    try {
      await owner.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native SR startup cleanup unconfirmed');
    }
    throw error;
  }
}
