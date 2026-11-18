import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Flock } from '@loro-dev/flock-wasm';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  nativeMachineCatalogMigrationInputSchema,
  nativeMachineCatalogMigrationReceiptSchema,
} from '@lody/shared/native-machine-catalog-migration';
import {
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
import { projectWorkspaceDirectory } from '@lody/shared/workspace-directory';
import {
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  getMachineFlockAgentConfigs,
  parseMachineFlockRow,
  getMachineRoomId,
  getAcpCapabilityCacheKey,
  isAgentConfigDocRoomId,
  type MachineId,
  type LocalProjectId,
  type MachineFlockKey,
} from '@lody/shared';
import { assertNativeFlockRewriteValue } from '@lody/shared/node/native-flock-value';
import { readLegacySqliteFlockSource } from './legacy-sqlite-flock-source';
import { NativeRepoMigrationJournal, readNativeFlockSnapshot } from './native-repo-migration';
import {
  NativeRoomMigrationAdmission,
  createNativeRoomMigrationCoordinatorLegacy,
} from './native-repo-room-migration';
import { publishMachineRateLimits } from '../machine-acp-capability-plan';
import { normalizeAgentConfigMeta } from '../agent-config-machine-flock';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
/** Explicit legacy fallback translation, after all original binary sources are
 * archived. MF keys including tombstones always defeat an old Meta fallback.
 * Retired workspacePaths/legacy session queues remain in the untouched Meta
 * archive; the current daemon does not execute those legacy queue fields. */
export function prepareLegacyMachineMetaOverlay(options: {
  meta: Uint8Array;
  flock: Uint8Array;
  workspaceId: string;
  machineId: string;
}) {
  const meta = Flock.strictFromFile(options.meta),
    mf = Flock.strictFromFile(options.flock);
  // Public legacy WASM cannot project unsafe i64. Such a source fails closed;
  // the caller retains its original binary archive, never a rounded projection.
  const entries = projectWorkspaceDirectory(meta.scan({ includeRaw: false })).entries;
  const present = new Set(mf.scan({ includeRaw: false }).map((row) => JSON.stringify(row.key)));
  const overlay = new Flock(
    hash(
      JSON.stringify(['local-mf-meta-overlay-v1', options.workspaceId, options.machineId])
    ).slice(0, 16)
  );
  const put = (key: MachineFlockKey, value: unknown) => {
    if (present.has(JSON.stringify(key))) return false;
    assertNativeFlockRewriteValue(value);
    if (!parseMachineFlockRow(key, value))
      throw new Error('Legacy MF metadata requires explicit repair');
    overlay.put(key, value as never, 0);
    present.add(JSON.stringify(key));
    return true;
  };
  const configs = Object.values(
    getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(mf))
  ).filter((config) => config.machineId === options.machineId);
  for (const entry of entries) {
    if (entry.deleted || !isAgentConfigDocRoomId(entry.docId)) continue;
    const config = normalizeAgentConfigMeta(entry.meta);
    if (!config || config.machineId !== options.machineId) continue;
    if (entry.docId !== `agent-${config.id}`) throw new Error('Legacy Agent binding mismatch');
    if (put(machineFlockKeys.agentConfig(config.id), { ...entry.meta, ...config }))
      configs.push(config);
  }
  const machine = entries.find(
    (entry) => entry.docId === getMachineRoomId(options.machineId as MachineId) && !entry.deleted
  )?.meta;
  if (machine) {
    if (record(machine.localProjects))
      for (const [id, value] of Object.entries(machine.localProjects).sort(([a], [b]) =>
        a.localeCompare(b)
      ))
        put(machineFlockKeys.localProject(id as LocalProjectId), value);
    if (record(machine.acpCapabilities))
      for (const config of configs) {
        const value = machine.acpCapabilities[getAcpCapabilityCacheKey(config.id)];
        if (value !== undefined && value !== null)
          put(machineFlockKeys.acpCapability(config.id), value);
      }
    if (record(machine.raceLimits))
      for (const [cliType, value] of Object.entries(machine.raceLimits)) {
        if (!record(value)) throw new Error('Invalid legacy quota source');
        publishMachineRateLimits(
          {
            scan: () => [],
            set: (key, value) => put(key as MachineFlockKey, value),
            delete: () => false,
            commit() {},
          },
          undefined,
          cliType,
          value as never
        );
      }
  }
  return overlay.exportFile();
}

/** Read-only inventory veto. It grants no owner and creates no database. */
export function inspectLegacyMachineCatalogOwners(input: unknown): string[] {
  const request = nativeMachineCatalogMigrationInputSchema.parse(input),
    group = request.group;
  const databasePath = join(request.dataRoot, 'loro-repo', group.workspaceId, 'repo.sqlite3');
  if (!existsSync(databasePath)) return [];
  const selected = new Set(
    group.roomIds.map((room) => room.slice(`${group.workspaceId}:mf:`.length))
  );
  const others = new Set<string>();
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    const rows = db
      .prepare(
        'SELECT flock_doc_id FROM flock_docs UNION SELECT flock_doc_id FROM flock_doc_updates'
      )
      .all() as Array<{ flock_doc_id: string }>;
    for (const row of rows)
      if (row.flock_doc_id.startsWith(`${group.workspaceId}:mf:`)) {
        const machineId = row.flock_doc_id.slice(`${group.workspaceId}:mf:`.length);
        if (!selected.has(machineId)) others.add(machineId);
      }
  } finally {
    db.close();
  }
  const meta = Flock.strictFromFile(
    readLegacySqliteFlockSource({ databasePath, room: { kind: 'meta', id: 'meta' } }).snapshot
  );
  for (const entry of projectWorkspaceDirectory(meta.scan({ includeRaw: false })).entries) {
    if (entry.deleted || !isAgentConfigDocRoomId(entry.docId)) continue;
    const machineId = entry.meta.machineId;
    if (typeof machineId === 'string' && !selected.has(machineId)) others.add(machineId);
  }
  return [...others].sort();
}

/** One-shot local helper. Strong legacy writer lease plus exact all-window MF
 * freeze protects source reads through group publication; no cloud transport. */
export async function migrateLocalMachineCatalogLegacy(
  input: unknown,
  options: { hostEntry: string; executable: string }
) {
  const request = nativeMachineCatalogMigrationInputSchema.parse(input),
    group = request.group;
  const descriptor = resolveLocalIndependentRepo({
    platform: 'local',
    dataRoot: request.dataRoot,
    accountId: group.accountId,
    workspaceId: group.workspaceId,
  });
  const binding = JSON.stringify([group.accountId, group.workspaceId]);
  const rooms = group.roomIds.map((id) => ({ kind: 'flock' as const, id }));
  const assertFrozen = async () => {
    const db = new Database(
      join(request.dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3'),
      { readonly: true, fileMustExist: true, timeout: 0 }
    );
    try {
      const state = db
        .prepare('SELECT owner,revision,group_json FROM renderer_flock_group_owners WHERE scope=?')
        .get(rendererFlockGroupScope(group)) as
        | { owner: string; revision: string; group_json: string }
        | undefined;
      if (
        state?.owner !== 'frozen' ||
        state.revision !== request.revision ||
        state.group_json !== rendererFlockGroupKey(group)
      )
        throw new Error('MF freeze witness mismatch');
      for (const room of rooms) {
        const claim = db
          .prepare(
            'SELECT group_scope FROM renderer_flock_group_rooms WHERE binding=? AND room_id=?'
          )
          .get(JSON.stringify([group.accountId, group.workspaceId, 'plaintext']), room.id) as
          | { group_scope: string }
          | undefined;
        if (claim?.group_scope !== rendererFlockGroupScope(group))
          throw new Error('MF room claim mismatch');
      }
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
  const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
  if (!proof) throw new Error('MF migration requires a verified SDK artifact');
  if (existsSync(descriptor.classicDirectory))
    throw new Error('Classic native profile requires explicit migration');
  const oldPath = join(request.dataRoot, 'loro-repo', group.workspaceId, 'repo.sqlite3');
  await mkdir(dirname(oldPath), { recursive: true, mode: 0o700 });
  const old = await SqliteRepoStore.open({ path: oldPath, recoverStaleWriter: true });
  let lease: Awaited<ReturnType<NonNullable<typeof old.storage.acquireWriterLease>>> | undefined;
  let host: IndependentNativeRepoHostLegacy | undefined,
    journal: NativeRepoMigrationJournal | undefined,
    primary: unknown;
  try {
    if (!old.storage.acquireWriterLease) throw new Error('Legacy writer lease unavailable');
    lease = await old.storage.acquireWriterLease();
    await assertFrozen();
    if (inspectLegacyMachineCatalogOwners(request).length)
      throw new Error('MF migration requires complete single-machine inventory');
    await mkdir(descriptor.directory, { recursive: true, mode: 0o700 });
    journal = new NativeRepoMigrationJournal(join(descriptor.directory, 'routes.sqlite3'));
    const route = journal.routeGroup(binding, rooms);
    const prefix = 'legacy-meta-fallback-v1:';
    const previous = rooms.map(
      (room) => journal!.getIntent(binding, room)?.migrationId ?? 'initial'
    );
    const originalSource =
      route.owner === 'legacy'
        ? undefined
        : journal
            .getIntent(binding, rooms[0]!)
            ?.sources.find((source) => source.sourceId.startsWith(prefix))
            ?.sourceId.slice(prefix.length)
            .split(':');
    const epoch = route.owner === 'legacy' ? hash(JSON.stringify(previous)) : originalSource?.[0];
    if (!epoch || !/^[a-f0-9]{64}$/.test(epoch))
      throw new Error('Original MF Meta source epoch missing');
    const archivePath = join(
      descriptor.directory,
      `mf-sources-${hash(rendererFlockGroupKey(group))}-${epoch}.json`
    );
    const archiveSchema = nativeMachineCatalogMigrationInputSchema;
    let archived: ReturnType<typeof archiveSchema.parse>;
    if (existsSync(archivePath)) {
      const envelope: unknown = JSON.parse(await readFile(archivePath, 'utf8'));
      if (!record(envelope) || envelope.version !== 1 || typeof envelope.sha256 !== 'string')
        throw new Error('MF source archive receipt invalid');
      archived = archiveSchema.parse(envelope.input);
      if (hash(JSON.stringify(archived)) !== envelope.sha256)
        throw new Error('MF source archive checksum mismatch');
      if (
        rendererFlockGroupKey(archived.group) !== rendererFlockGroupKey(group) ||
        archived.dataRoot !== request.dataRoot
      )
        throw new Error('MF archive binding mismatch');
    } else {
      if (route.owner !== 'legacy') throw new Error('Original frozen MF source archive missing');
      const meta = readLegacySqliteFlockSource({
        databasePath: oldPath,
        room: { kind: 'meta', id: 'meta' },
      });
      archived = archiveSchema.parse({
        version: 1,
        revision: request.revision,
        dataRoot: request.dataRoot,
        group,
        sources: [
          {
            sourceId: 'daemon-sqlite',
            metaSnapshotBase64: Buffer.from(meta.snapshot).toString('base64'),
            rooms: rooms.map((room) => ({
              roomId: room.id,
              snapshotBase64: Buffer.from(
                readLegacySqliteFlockSource({ databasePath: oldPath, room }).snapshot
              ).toString('base64'),
            })),
          },
          ...request.sources,
        ],
      });
      const temporary = `${archivePath}.partial`;
      const file = await open(temporary, 'w', 0o600);
      try {
        await file.writeFile(
          JSON.stringify({ version: 1, sha256: hash(JSON.stringify(archived)), input: archived })
        );
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
    const archiveHash = hash(JSON.stringify(archived));
    if (route.owner !== 'legacy' && originalSource?.[1] !== archiveHash)
      throw new Error('MF source archive differs from the original migration receipt');
    await assertFrozen();
    host = new IndependentNativeRepoHostLegacy({
      dataDir: descriptor.dataDir,
      binding: descriptor.binding,
      ...options,
      entry: options.hostEntry,
      requiredSdkArtifactId: proof.artifactId,
    });
    const client = await host.client();
    const frozen = journal.routeGroup(binding, rooms).owner !== 'legacy';
    const meta = new Flock();
    if (!frozen)
      for (const source of archived.sources)
        meta.strictImportFile(Uint8Array.from(Buffer.from(source.metaSnapshotBase64, 'base64')));
    if (!frozen) {
      const selectedMachines = new Set(
        group.roomIds.map((room) => room.slice(`${group.workspaceId}:mf:`.length))
      );
      for (const entry of projectWorkspaceDirectory(meta.scan({ includeRaw: false })).entries) {
        const machineId = entry.meta.machineId;
        if (
          !entry.deleted &&
          isAgentConfigDocRoomId(entry.docId) &&
          typeof machineId === 'string' &&
          !selectedMachines.has(machineId)
        )
          throw new Error('MF frozen source contains another machine owner');
      }
    }
    const inputs = rooms.map((room) => {
      const sources: Array<{ sourceId: string; bytes: Uint8Array }> = frozen
        ? []
        : archived.sources.map((source) => ({
            sourceId: source.sourceId,
            bytes: Uint8Array.from(
              Buffer.from(
                source.rooms.find((value) => value.roomId === room.id)!.snapshotBase64,
                'base64'
              )
            ),
          }));
      if (!frozen) {
        const mf = new Flock();
        for (const source of sources) mf.strictImportFile(source.bytes);
        const machineId = room.id.slice(`${group.workspaceId}:mf:`.length);
        sources.push({
          sourceId: `${prefix}${epoch}:${archiveHash}`,
          bytes: prepareLegacyMachineMetaOverlay({
            meta: meta.exportFile(),
            flock: mf.exportFile(),
            workspaceId: group.workspaceId,
            machineId,
          }),
        });
      }
      return {
        room,
        sources: sources.map((source) => ({
          sourceId: source.sourceId,
          snapshot: async () => {
            await assertFrozen();
            return source.bytes;
          },
        })),
      };
    });
    const coordinator = createNativeRoomMigrationCoordinatorLegacy({
      binding,
      namespace: group.workspaceId,
      targetGeneration: 'engine-0.1.0-v1',
      directory: descriptor.directory,
      dataDir: descriptor.dataDir,
      journal,
      client,
      admission: new NativeRoomMigrationAdmission(journal, binding),
      freezeExternalOwners: assertFrozen,
      beforePublish: assertFrozen,
    });
    await coordinator.migrate(inputs);
    await assertFrozen();
    const receipts = [];
    for (const room of rooms) {
      await client.compactRoom(group.workspaceId, room);
      const state = readNativeFlockSnapshot({
        dataDir: descriptor.dataDir,
        namespace: group.workspaceId,
        room,
      });
      receipts.push({ roomId: room.id, roomTxId: state.roomTxId, targetSha256: state.sha256 });
    }
    return nativeMachineCatalogMigrationReceiptSchema.parse({
      version: 1,
      runId: (await host.leaseInfo(client)).engineRunId,
      sourceCount: archived.sources.length,
      sourceSha256: hash(JSON.stringify(archived.sources)),
      rooms: receipts,
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
    ])
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(
        [...(primary ? [primary] : []), ...failures],
        'Local MF migration cleanup unconfirmed'
      );
  }
}
