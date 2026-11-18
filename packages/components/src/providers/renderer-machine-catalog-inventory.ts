import { Flock } from '@loro-dev/flock-wasm';
import { projectWorkspaceDirectory } from '@lody/shared/workspace-directory';
import {
  FLOCK_GROUP_MAX_SOURCES,
  rendererFlockGroupSchema,
  type RendererFlockGroup,
} from '@lody/shared/renderer-flock-room-group';
import { exportExistingFlockDatabaseRooms } from './renderer-workspace-flock-migration';
/** First MF batch supports a single trusted local machine. This is only a veto,
 * never a grant, and leaves healthy legacy producers running on any failure. */
export async function inspectRendererMachineCatalogOwners(
  input: RendererFlockGroup,
  idb: IDBFactory = globalThis.indexedDB
): Promise<string[]> {
  const group = rendererFlockGroupSchema.parse(input);
  if (group.domain !== 'machine' || !idb || typeof idb.databases !== 'function')
    throw new Error('MF inventory unavailable');
  const prefix = `lody-loro-repo-db-${group.workspaceId}`;
  const databases = (await idb.databases())
    .flatMap((db) => (db.name === prefix || db.name?.startsWith(`${prefix}:`) ? [db.name] : []))
    .sort();
  if (databases.length > FLOCK_GROUP_MAX_SOURCES)
    throw new Error('MF replica inventory exceeds budget');
  const selected = new Set(
    group.roomIds.map((room) => room.slice(`${group.workspaceId}:mf:`.length))
  );
  const others = new Set<string>();
  for (const name of databases) {
    const rows = await exportExistingFlockDatabaseRooms(idb, name, group.roomIds, {
      includeMeta: true,
      listRoomIds: true,
    });
    for (const room of rows[0]?.existingRoomIds ?? []) {
      if (!room.startsWith(`${group.workspaceId}:mf:`)) continue;
      const machineId = room.slice(`${group.workspaceId}:mf:`.length);
      if (!selected.has(machineId)) others.add(machineId);
    }
    const snapshot = rows[0]?.metaSnapshot;
    if (!snapshot) throw new Error('Complete MF legacy Meta inventory missing');
    for (const entry of projectWorkspaceDirectory(
      Flock.strictFromFile(snapshot).scan({ includeRaw: false })
    ).entries) {
      if (entry.deleted || !entry.docId.startsWith('agent-')) continue;
      const machineId = entry.meta.machineId;
      if (typeof machineId === 'string' && !selected.has(machineId)) others.add(machineId);
    }
  }
  return [...others].sort();
}
