import { Flock } from '@loro-dev/flock-wasm';
import { getWorkspaceFlockDocId } from '@lody/shared';
import type { WorkspaceId } from '@lody/shared';
import {
  RENDERER_WF_MAX_SOURCES,
  RENDERER_WF_MAX_BYTES,
} from '@lody/shared/renderer-room-migration';

/** Compatibility reader for the installed loro-repo@0.25.0 default IDB layout. */
const STORES = ['flock-docs', 'flock-doc-updates'] as const;
const request = <A>(operation: IDBRequest<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () =>
      reject(operation.error ?? new Error('Renderer migration IDB read failed'));
  });
const binary = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  throw new Error('Unknown renderer Flock persisted binary representation');
};
const hydrate = (parts: readonly Uint8Array[]) => {
  const flock = new Flock();
  for (const bytes of parts) {
    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    if (magic === 'FLOK' || magic === 'FLK2') flock.strictImportFile(bytes);
    else {
      // Released IDB queues may contain complete ExportBundle JSON, including
      // clocks/tombstones/unknown keys. Import the bundle; never rebuild rows.
      const bundle = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        (_key, value, context?: { source?: string }) => {
          if (typeof value !== 'number' || !Number.isInteger(value) || Number.isSafeInteger(value))
            return value;
          // Chromium and Node expose the original numeric token. Preserve it
          // through the WASM i64 bridge; never reserialize a rounded JS Number.
          if (!context?.source || !/^-?\d+$/.test(context.source))
            throw new Error('Renderer Flock update integer cannot be read losslessly');
          return BigInt(context.source);
        }
      );
      flock.importJson(bundle);
    }
  }
  return flock.exportFile();
};

/** Read all selected room bases/logs in one readonly transaction; never open a live Repo. */
export async function exportExistingFlockDatabaseRooms(
  idb: IDBFactory,
  dbName: string,
  roomIds: readonly string[],
  options: { includeMeta?: boolean; listRoomIds?: boolean; metaOnly?: boolean } = {}
) {
  if (options.metaOnly && (options.listRoomIds || roomIds.length !== 1 || roomIds[0] !== 'meta'))
    throw new Error('Meta capture requires the exact workspace Meta room');
  const includeMeta = options.includeMeta || options.metaOnly;
  const stores = [
    ...(options.metaOnly ? [] : STORES),
    ...(includeMeta ? ['meta', 'meta-updates'] : []),
  ];
  const opening = idb.open(dbName);
  opening.onupgradeneeded = () => opening.transaction?.abort(); // Never create/upgrade a source.
  const database = await request(opening);
  try {
    if (
      database.version !== 4 ||
      stores.some((store) => !database.objectStoreNames.contains(store))
    )
      throw new Error('Unsupported renderer Flock IndexedDB layout');
    const transaction = database.transaction(stores, 'readonly');
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error('Renderer migration IDB transaction failed'));
    });
    // Queue both reads synchronously so one readonly transaction captures base+log.
    const metaRead = includeMeta
      ? Promise.all([
          request(transaction.objectStore('meta').get('snapshot')),
          request(transaction.objectStore('meta-updates').getAllKeys()),
          request(transaction.objectStore('meta-updates').getAll()),
        ])
      : Promise.resolve(undefined);
    const roomKeys = options.listRoomIds
      ? Promise.all([
          request(transaction.objectStore(STORES[0]).getAllKeys()),
          request(transaction.objectStore(STORES[1]).getAllKeys()),
        ])
      : Promise.resolve(undefined);
    const [rows, meta, keys] = await Promise.all([
      Promise.all(
        roomIds.map((roomId) =>
          Promise.all([
            options.metaOnly
              ? Promise.resolve(undefined)
              : request(transaction.objectStore(STORES[0]).get(roomId)),
            options.metaOnly
              ? Promise.resolve(undefined)
              : request(transaction.objectStore(STORES[1]).get(roomId)),
          ])
        )
      ),
      metaRead,
      roomKeys,
      completed,
    ]);
    let metaSnapshot: Uint8Array | undefined;
    let metaPresent = false;
    if (meta) {
      const [base, keys, values] = meta;
      const parts = base === undefined || base === null ? [] : [binary(base)];
      for (const [index, key] of keys.entries()) {
        if (String(key).startsWith('lineage:')) continue;
        const value: unknown = values[index];
        if (key === 'queue') {
          const queue = Array.isArray(value)
            ? value
            : value &&
                typeof value === 'object' &&
                'updates' in value &&
                Array.isArray(value.updates)
              ? value.updates
              : undefined;
          if (!queue) throw new Error('Unsupported renderer Meta update queue');
          parts.push(...queue.map(binary));
        } else parts.push(binary(value));
      }
      metaPresent = parts.length > 0;
      metaSnapshot = hydrate(parts);
    }
    return rows.map(([base, rawQueue]) => {
      if (options.metaOnly) {
        if (!metaSnapshot) throw new Error('Incomplete renderer Meta capture');
        return {
          present: metaPresent,
          snapshot: metaSnapshot,
          metaSnapshot: undefined,
          existingRoomIds: undefined,
        };
      }
      let queue: unknown[] = [];
      if (rawQueue !== undefined && rawQueue !== null) {
        if (Array.isArray(rawQueue)) queue = rawQueue;
        else if (typeof rawQueue === 'object' && Array.isArray(rawQueue.updates))
          queue = rawQueue.updates;
        else throw new Error('Unknown renderer Flock persisted update queue');
      }
      const parts = [
        ...(base === undefined || base === null ? [] : [binary(base)]),
        ...queue.map(binary),
      ];
      return {
        present: parts.length > 0,
        snapshot: hydrate(parts),
        ...(metaSnapshot ? { metaSnapshot } : {}),
        ...(keys
          ? {
              existingRoomIds: [
                ...new Set(keys.flat().filter((key): key is string => typeof key === 'string')),
              ],
            }
          : {}),
      };
    });
  } finally {
    database.close();
  }
}

export type FrozenRendererWorkspaceFlockSource = {
  readonly sourceId: string;
  readonly dbName: string;
  readonly present: boolean;
  readonly snapshot: Uint8Array;
};

/**
 * Called by trusted renderer composition after host migration admission. The
 * required port must reject new runtimes/writes in ALL windows and drain each
 * in-memory replica to its IDB persistence barrier, including failed/retrying
 * writes. It must retain that freeze after this call until the host route commit.
 * This function never opens a live Repo, upgrades, compacts, deletes, or writes IDB.
 */
export async function captureFrozenRendererWorkspaceFlockSources(options: {
  readonly workspaceId: WorkspaceId;
  readonly contentMode: 'plaintext';
  readonly indexedDB?: IDBFactory;
  freezeAndDrainAllWindows(): Promise<void>;
}): Promise<readonly FrozenRendererWorkspaceFlockSource[]> {
  if (
    options.contentMode !== 'plaintext' ||
    !options.workspaceId ||
    options.workspaceId.includes(':')
  )
    throw new Error('Renderer Flock migration requires a plaintext workspace binding');
  await options.freezeAndDrainAllWindows();
  const idb = options.indexedDB ?? globalThis.indexedDB;
  if (!idb || typeof idb.databases !== 'function')
    throw new Error('Renderer migration requires complete IndexedDB enumeration');
  const prefix = `lody-loro-repo-db-${options.workspaceId}`;
  const inventory = async () =>
    (await idb.databases())
      .filter((database) => database.name === prefix || database.name?.startsWith(`${prefix}:`))
      .map((database) => ({ name: database.name!, version: database.version }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const before = await inventory();
  if (before.length > RENDERER_WF_MAX_SOURCES)
    throw new Error('Renderer WF source inventory exceeds budget');
  const roomId = getWorkspaceFlockDocId(options.workspaceId);
  const sources: FrozenRendererWorkspaceFlockSource[] = [];
  let bytes = 0;
  for (const database of before) {
    const source = {
      sourceId: `renderer-idb:loro-repo@0.25.0:${database.name}`,
      dbName: database.name,
      ...(await exportExistingFlockDatabaseRooms(idb, database.name, [roomId]))[0]!,
    };
    bytes +=
      source.snapshot.byteLength +
      new TextEncoder().encode(source.sourceId + source.dbName).length +
      32;
    if (bytes > RENDERER_WF_MAX_BYTES - 4096)
      throw new Error('Renderer WF complete source inventory exceeds byte budget');
    sources.push(source);
  }
  if (JSON.stringify(before) !== JSON.stringify(await inventory()))
    throw new Error('Renderer replica inventory changed after the freeze barrier');
  return sources;
}
