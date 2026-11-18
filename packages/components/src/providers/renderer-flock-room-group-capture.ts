import {
  FLOCK_GROUP_MAX_SOURCES,
  rendererFlockGroupSchema,
  validateRendererFlockGroupInventory,
  type RendererFlockGroup,
  type RendererFlockGroupInventory,
} from '@lody/shared/renderer-flock-room-group';
import { exportExistingFlockDatabaseRooms } from './renderer-workspace-flock-migration';

/** Caller must first hold this exact group's all-window freeze witness. */
export async function captureFrozenRendererFlockRoomGroup(options: {
  group: RendererFlockGroup;
  indexedDB?: IDBFactory;
  freezeAndDrainAllWindows(): Promise<void>;
}): Promise<RendererFlockGroupInventory> {
  const group = rendererFlockGroupSchema.parse(options.group);
  await options.freezeAndDrainAllWindows();
  const idb = options.indexedDB ?? globalThis.indexedDB;
  if (!idb || typeof idb.databases !== 'function')
    throw new Error('Complete renderer IndexedDB enumeration is required');
  const prefix = `lody-loro-repo-db-${group.workspaceId}`;
  const enumerate = async () =>
    (await idb.databases())
      .filter((db) => db.name === prefix || db.name?.startsWith(`${prefix}:`))
      .map((db) => ({ name: db.name!, version: db.version }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const databases = await enumerate();
  if (databases.length > FLOCK_GROUP_MAX_SOURCES)
    throw new Error('Complete group replica inventory exceeds budget');
  const inventory: RendererFlockGroupInventory = group.roomIds.map((roomId) => ({
    roomId,
    present: false,
    sources: [],
  }));
  for (const db of databases) {
    const rows = await exportExistingFlockDatabaseRooms(idb, db.name, group.roomIds, {
      includeMeta: group.domain === 'machine',
      metaOnly: group.domain === 'meta',
    });
    for (const [index, row] of rows.entries()) {
      inventory[index]!.present ||= row.present;
      inventory[index]!.sources.push({
        dbName: db.name,
        sourceId: `renderer-idb:loro-repo@0.25.0:${db.name}`,
        present: row.present,
        snapshot: Uint8Array.from(row.snapshot),
        ...(row.metaSnapshot ? { metaSnapshot: Uint8Array.from(row.metaSnapshot) } : {}),
      });
    }
    validateRendererFlockGroupInventory(group, inventory);
  }
  if (JSON.stringify(databases) !== JSON.stringify(await enumerate()))
    throw new Error('Renderer database inventory changed after group freeze');
  return validateRendererFlockGroupInventory(group, inventory);
}
