import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { isPidAliveSyncLegacy } from '@lody/shared/node/process';
import {
  LocalDaemonRunFileMissingError,
  readLocalDaemonRunFile,
} from '@lody/shared/node/local-ipc';
import { rendererWfBindingKey } from '@lody/shared/renderer-room-migration';
import {
  nativeWorkspaceCatalogMigrationInputSchema,
  nativeWorkspaceCatalogMigrationReceiptSchema,
} from '@lody/shared/native-workspace-catalog-migration';
import { readLegacySqliteFlockSource } from './legacy-sqlite-flock-source';
import { NativeRepoMigrationJournal, readNativeFlockSnapshot } from './native-repo-migration';
import {
  NativeRoomMigrationAdmission,
  createNativeRoomMigrationCoordinatorLegacy,
} from './native-repo-room-migration';

/** Trusted one-shot local migration owner. No cloud configuration or generic SDK protocol. */
export async function migrateLocalWorkspaceCatalogLegacy(
  input: unknown,
  options: { hostEntry: string; executable: string }
) {
  const request = nativeWorkspaceCatalogMigrationInputSchema.parse(input);
  const descriptor = resolveLocalIndependentRepo({ platform: 'local', ...request });
  const room = { kind: 'flock' as const, id: `${request.workspaceId}:wf:workspace` };
  const binding = JSON.stringify([request.accountId, request.workspaceId]);
  const assertFrozen = async () => {
    const database = new Database(
      path.join(request.dataRoot, 'native-repo', 'renderer-wf-owners.sqlite3'),
      { readonly: true, fileMustExist: true, timeout: 0 }
    );
    try {
      const state = database
        .prepare('SELECT owner, revision FROM renderer_wf_owners WHERE binding = ?')
        .get(
          rendererWfBindingKey({
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            roomId: room.id,
            contentMode: 'plaintext',
          })
        ) as { owner: string; revision: string } | undefined;
      if (state?.owner !== 'frozen' || state.revision !== request.revision)
        throw new Error('Renderer WF freeze receipt does not match');
    } finally {
      database.close();
    }
    try {
      const run = readLocalDaemonRunFile(path.join(request.dataRoot, 'run', 'daemon.json'));
      if (isPidAliveSyncLegacy(run.pid)) throw new Error('Legacy daemon remains alive');
    } catch (error) {
      if (!(error instanceof LocalDaemonRunFileMissingError)) throw error;
    }
  };
  await assertFrozen();
  // Keep the old database's strong-identity writer token throughout source read,
  // archive, imports and publish. SDK recovery only removes a proven dead token.
  const oldDirectory = path.join(request.dataRoot, 'loro-repo', request.workspaceId);
  await mkdir(oldDirectory, { recursive: true, mode: 0o700 });
  const oldPath = path.join(oldDirectory, 'repo.sqlite3');
  const old = await SqliteRepoStore.open({ path: oldPath, recoverStaleWriter: true });
  let lease: Awaited<ReturnType<NonNullable<typeof old.storage.acquireWriterLease>>> | undefined;
  let host: IndependentNativeRepoHostLegacy | undefined;
  let journal: NativeRepoMigrationJournal | undefined;
  let failure: unknown;
  try {
    if (!old.storage.acquireWriterLease) throw new Error('Legacy writer lease unavailable');
    lease = await old.storage.acquireWriterLease();
    await assertFrozen();
    // Refuse classic data until its own explicit migration has completed.
    try {
      await stat(descriptor.classicDirectory);
      throw new Error('Classic native profile requires explicit migration');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(descriptor.directory, { recursive: true, mode: 0o700 });
    journal = new NativeRepoMigrationJournal(path.join(descriptor.directory, 'routes.sqlite3'));
    // A frozen/native journal resumes its archived inventory, never fresh replicas.
    let sources: Array<{ sourceId: string; snapshot: Uint8Array }> = [];
    if (journal.routeGroup(binding, [room]).owner === 'legacy') {
      const daemon = readLegacySqliteFlockSource({ databasePath: oldPath, room });
      sources = [
        { sourceId: 'daemon-sqlite', snapshot: daemon.snapshot },
        ...request.sources.map((source) => ({
          sourceId: source.sourceId,
          snapshot: Uint8Array.from(Buffer.from(source.snapshotBase64, 'base64')),
        })),
      ];
    }
    host = new IndependentNativeRepoHostLegacy({
      dataDir: descriptor.dataDir,
      binding: descriptor.binding,
      entry: options.hostEntry,
      executable: options.executable,
    });
    const client = await host.client();
    const coordinator = createNativeRoomMigrationCoordinatorLegacy({
      binding,
      namespace: request.workspaceId,
      targetGeneration: 'engine-0.1.0-v1',
      directory: descriptor.directory,
      dataDir: descriptor.dataDir,
      journal,
      client,
      admission: new NativeRoomMigrationAdmission(journal, binding),
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
            return source.snapshot;
          },
        })),
      },
    ]);
    await assertFrozen();
    await client.compactRoom(request.workspaceId, room);
    const snapshot = readNativeFlockSnapshot({
      dataDir: descriptor.dataDir,
      namespace: request.workspaceId,
      room,
    });
    const intent = journal.getIntent(binding, room);
    if (!intent) throw new Error('Native migration receipt missing');
    const receipt = nativeWorkspaceCatalogMigrationReceiptSchema.parse({
      version: 1,
      sourceCount: intent.sources.length,
      sourceSha256: createHash('sha256').update(JSON.stringify(intent.sources)).digest('hex'),
      engineRunId: (await host.leaseInfo(client)).engineRunId,
      roomTxId: snapshot.roomTxId,
      targetSha256: snapshot.sha256,
    });
    return receipt;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const failures: unknown[] = [];
    try {
      await host?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      journal?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await lease?.release();
    } catch (error) {
      failures.push(error);
    }
    try {
      old.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...failures],
        'Local WF migration cleanup unconfirmed'
      );
  }
}
