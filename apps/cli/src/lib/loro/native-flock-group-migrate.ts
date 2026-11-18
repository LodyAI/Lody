import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isLocalUserId, isLocalWorkspaceId } from '@lody/shared/platform-kind';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  nativeScheduleRegistryMigrationInputSchema,
  nativeScheduleRegistryMigrationReceiptSchema,
} from '@lody/shared/native-schedule-registry-migration';
import {
  nativeWorkspaceMetaMigrationInputSchema,
  nativeWorkspaceMetaMigrationReceiptSchema,
} from '@lody/shared/native-workspace-meta-migration';
import {
  FLOCK_GROUP_MAX_BYTES,
  rendererFlockGroupKey,
  rendererFlockGroupScope,
} from '@lody/shared/renderer-flock-room-group';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { isPidAliveSyncLegacy } from '@lody/shared/node/process';
import {
  readLocalDaemonRunFile,
  LocalDaemonRunFileMissingError,
} from '@lody/shared/node/local-ipc';
import { readLegacySqliteFlockSource } from './legacy-sqlite-flock-source';
import { NativeRepoMigrationJournal, readNativeFlockSnapshot } from './native-repo-migration';
import {
  NativeRoomMigrationAdmission,
  createNativeRoomMigrationCoordinatorLegacy,
} from './native-repo-room-migration';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const makeArchiveSchema = (
  inputSchema:
    | typeof nativeScheduleRegistryMigrationInputSchema
    | typeof nativeWorkspaceMetaMigrationInputSchema
) =>
  z
    .object({
      version: z.literal(1),
      request: inputSchema,
      daemon: z.object({ present: z.boolean(), snapshotBase64: z.string().min(1) }).strict(),
    })
    .strict();

/** One exact local Flock room group, under both the persistent all-window witness and
 * the legacy strong writer lease. No value reconstruction or dual write. */
export async function migrateLocalFlockGroupLegacy(
  input: unknown,
  options: {
    domain: 'meta' | 'schedule';
    hostEntry: string;
    executable: string;
  }
) {
  const inputSchema =
    options.domain === 'meta'
      ? nativeWorkspaceMetaMigrationInputSchema
      : nativeScheduleRegistryMigrationInputSchema;
  const archiveSchema = makeArchiveSchema(inputSchema);
  const request = inputSchema.parse(input),
    group = request.group;
  if (!isLocalUserId(group.accountId) || !isLocalWorkspaceId(group.workspaceId))
    throw new Error('Local Flock group identity is required');
  if (process.platform === 'win32')
    throw new Error('Independent Flock group migration is unavailable on Windows');
  const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
  if (!proof || (options.domain === 'meta' && (!proof.flockStateEntries || !proof.rawFlockExport)))
    throw new Error('Flock group migration requires a verified compatible SDK artifact');
  const descriptor = resolveLocalIndependentRepo({
    platform: 'local',
    dataRoot: request.dataRoot,
    accountId: group.accountId,
    workspaceId: group.workspaceId,
  });
  const binding = JSON.stringify([group.accountId, group.workspaceId]);
  const roomId = group.roomIds[0];
  if (!roomId) throw new Error('Complete Flock group group is required');
  const room = {
    kind: options.domain === 'meta' ? ('meta' as const) : ('flock' as const),
    id: roomId,
  };
  const assertFrozen = async () => {
    const db = new Database(
      join(request.dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3'),
      {
        readonly: true,
        fileMustExist: true,
        timeout: 0,
      }
    );
    try {
      db.transaction(() => {
        const state = db
          .prepare(
            'SELECT owner,revision,group_json FROM renderer_flock_group_owners WHERE scope=?'
          )
          .get(rendererFlockGroupScope(group)) as
          | { owner: string; revision: string; group_json: string }
          | undefined;
        if (
          state?.owner !== 'frozen' ||
          state.revision !== request.revision ||
          state.group_json !== rendererFlockGroupKey(group)
        )
          throw new Error('Flock group freeze witness mismatch');
        const claim = db
          .prepare(
            'SELECT group_scope FROM renderer_flock_group_rooms WHERE binding=? AND room_id=?'
          )
          .get(JSON.stringify([group.accountId, group.workspaceId, 'plaintext']), room.id) as
          | { group_scope: string }
          | undefined;
        if (claim?.group_scope !== rendererFlockGroupScope(group))
          throw new Error('Flock group room claim mismatch');
      })();
    } finally {
      db.close();
    }
    try {
      const run = readLocalDaemonRunFile(join(request.dataRoot, 'run', 'daemon.json'));
      if (isPidAliveSyncLegacy(run.pid)) throw new Error('Legacy daemon remains alive');
    } catch (error) {
      if (!(error instanceof LocalDaemonRunFileMissingError)) throw error;
    }
  };
  await assertFrozen();
  if (existsSync(descriptor.classicDirectory))
    throw new Error('Classic native profile requires explicit migration');
  const oldPath = join(request.dataRoot, 'loro-repo', group.workspaceId, 'repo.sqlite3');
  await mkdir(dirname(oldPath), { recursive: true, mode: 0o700 });
  const old = await SqliteRepoStore.open({ path: oldPath, recoverStaleWriter: true });
  let lease: Awaited<ReturnType<NonNullable<typeof old.storage.acquireWriterLease>>> | undefined;
  let host: IndependentNativeRepoHostLegacy | undefined;
  let journal: NativeRepoMigrationJournal | undefined;
  let primary: unknown;
  try {
    if (!old.storage.acquireWriterLease) throw new Error('Legacy writer lease unavailable');
    lease = await old.storage.acquireWriterLease();
    await assertFrozen();
    await mkdir(descriptor.directory, { recursive: true, mode: 0o700 });
    journal = new NativeRepoMigrationJournal(join(descriptor.directory, 'routes.sqlite3'));
    let sources: Array<{ sourceId: string; present: boolean; snapshotBase64: string }> = [];
    // A rolled-back room starts a new legacy epoch. Old archives remain intact,
    // but must never hide edits made after that rollback. Frozen/native retries
    // use the coordinator's exact original migration archives instead.
    if (journal.routeGroup(binding, [room]).owner === 'legacy') {
      const prior = journal.getIntent(binding, room)?.migrationId ?? 'initial';
      const archivePath = join(
        descriptor.directory,
        `${options.domain === 'schedule' ? 'sr' : 'meta'}-sources-${hash(JSON.stringify([rendererFlockGroupKey(group), prior]))}.json`
      );
      let archived: z.infer<typeof archiveSchema>;
      if (existsSync(archivePath)) {
        const bytes = await readFile(archivePath);
        if (bytes.length > FLOCK_GROUP_MAX_BYTES * 2)
          throw new Error('Flock group archive exceeds budget');
        archived = archiveSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        );
        if (
          archived.request.dataRoot !== request.dataRoot ||
          rendererFlockGroupKey(archived.request.group) !== rendererFlockGroupKey(group)
        )
          throw new Error('Flock group archive binding mismatch');
      } else {
        const daemon = readLegacySqliteFlockSource({ databasePath: oldPath, room });
        archived = archiveSchema.parse({
          version: 1,
          request,
          daemon: {
            present: daemon.present,
            snapshotBase64: Buffer.from(daemon.snapshot).toString('base64'),
          },
        });
        const body = JSON.stringify(archived);
        if (Buffer.byteLength(body) > FLOCK_GROUP_MAX_BYTES * 2)
          throw new Error('Flock group archive exceeds budget');
        const temporary = `${archivePath}.${randomUUID()}.partial`;
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(body);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, archivePath);
        const directory = await open(descriptor.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      sources = [{ sourceId: 'daemon-sqlite', ...archived.daemon }, ...archived.request.sources];
      if (
        sources.reduce(
          (size, source) =>
            size +
            Buffer.from(source.snapshotBase64, 'base64').length +
            Buffer.byteLength(source.sourceId) +
            64,
          0
        ) > FLOCK_GROUP_MAX_BYTES
      )
        throw new Error('Complete Flock group source inventory exceeds budget');
    }
    await assertFrozen();
    host = new IndependentNativeRepoHostLegacy({
      dataDir: descriptor.dataDir,
      binding: descriptor.binding,
      entry: options.hostEntry,
      executable: options.executable,
      requiredSdkArtifactId: proof.artifactId,
    });
    const client = await host.client();
    const admission = new NativeRoomMigrationAdmission(journal, binding);
    const coordinator = createNativeRoomMigrationCoordinatorLegacy({
      binding,
      namespace: group.workspaceId,
      targetGeneration: 'engine-0.1.0-v1',
      directory: descriptor.directory,
      dataDir: descriptor.dataDir,
      journal,
      client,
      admission,
      freezeExternalOwners: assertFrozen,
      beforePublish: assertFrozen,
    });
    await coordinator.migrate([
      {
        room,
        sources: sources.map((source) => ({
          sourceId: source.sourceId,
          snapshot: async () => {
            await assertFrozen();
            return Uint8Array.from(Buffer.from(source.snapshotBase64, 'base64'));
          },
        })),
      },
    ]);
    await assertFrozen();
    await client.compactRoom(group.workspaceId, room);
    const state = readNativeFlockSnapshot({
      dataDir: descriptor.dataDir,
      namespace: group.workspaceId,
      room,
    });
    const receipts = journal.getIntent(binding, room)?.sources;
    if (!receipts?.length) throw new Error('Published Flock group source receipts are missing');
    return (
      options.domain === 'meta'
        ? nativeWorkspaceMetaMigrationReceiptSchema
        : nativeScheduleRegistryMigrationReceiptSchema
    ).parse({
      version: 1,
      runId: (await host.leaseInfo(client)).engineRunId,
      sourceCount: receipts.length,
      sourceSha256: hash(JSON.stringify(receipts)),
      roomId: room.id,
      roomTxId: state.roomTxId,
      targetSha256: state.sha256,
    });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const failures: unknown[] = [];
    for (const close of [
      () => host?.close(),
      () => journal?.close(),
      () => lease?.release(),
      () => old.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        [...(primary ? [primary] : []), ...failures],
        'Local Flock group migration cleanup unconfirmed'
      );
  }
}
