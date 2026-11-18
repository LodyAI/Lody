import type {
  RepoClient,
  FlockScanQuery,
  RoomKey,
  UpdateInfo,
  TxId,
} from '@loro-dev/loro-repo-client';
import type { NativeRepoSdkCompatibility } from './native-repo-sdk-compatibility';
export type NativeFlockStateEntry = {
  readonly key: readonly unknown[];
  readonly deleted: boolean;
  readonly value: unknown;
};
export type NativeFlockEntriesSnapshot = {
  txId: TxId;
  roomTxId: TxId;
  entries: NativeFlockStateEntry[];
};
export type NativeFlockEntriesSubscription = {
  readonly isClosed: boolean;
  readonly currentValue: NativeFlockStateEntry[];
  unsubscribe(): Promise<void>;
};
export class NativeFlockEntriesUnavailable extends Error {
  readonly code = 'unavailable';
  constructor() {
    super('Complete native Flock entries are unavailable');
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const tx = (value: unknown): value is TxId =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function readNativeFlockStateEntries(value: unknown): NativeFlockStateEntry[] {
  if (!Array.isArray(value)) throw new NativeFlockEntriesUnavailable();
  return value.map((row) => {
    if (
      !object(row) ||
      !Array.isArray(row.key) ||
      typeof row.deleted !== 'boolean' ||
      !Object.hasOwn(row, 'value') ||
      row.value === undefined ||
      (row.deleted && row.value !== null)
    )
      throw new NativeFlockEntriesUnavailable();
    return { key: row.key, deleted: row.deleted, value: row.value };
  });
}
/** Runtime feature boundary for formal 0.1.0 types. The trusted caller binds
 * the verified three-package/addon receipt to this exact authenticated host
 * generation; a method name or semver alone proves no capability. */
export function requireNativeFlockEntries(
  client: RepoClient,
  access: {
    readonly compatibility: NativeRepoSdkCompatibility | undefined;
    readonly sdkArtifactId: string | undefined;
  }
) {
  if (
    !access.compatibility?.flockStateEntries ||
    access.sdkArtifactId !== access.compatibility.artifactId
  )
    throw new NativeFlockEntriesUnavailable();
  const scan: unknown = Reflect.get(client, 'flockScanEntries');
  const subscribe: unknown = Reflect.get(client, 'flockSubscribeEntries');
  if (typeof scan !== 'function' || typeof subscribe !== 'function')
    throw new NativeFlockEntriesUnavailable();
  return {
    async scan(
      namespace: string,
      room: RoomKey,
      query: FlockScanQuery = {}
    ): Promise<NativeFlockEntriesSnapshot> {
      const value: unknown = await Reflect.apply(scan, client, [namespace, room, query]);
      if (!object(value) || !tx(value.txId) || !tx(value.roomTxId))
        throw new NativeFlockEntriesUnavailable();
      return {
        txId: value.txId,
        roomTxId: value.roomTxId,
        entries: readNativeFlockStateEntries(value.entries),
      };
    },
    async subscribe(
      namespace: string,
      room: RoomKey,
      query: FlockScanQuery,
      listener: (
        rows: NativeFlockStateEntry[],
        info: Pick<UpdateInfo, 'txId' | 'roomTxId' | 'origin' | 'resetReason'>
      ) => void
    ): Promise<NativeFlockEntriesSubscription> {
      const receive = (rows: unknown, info: unknown) => {
        if (
          !object(info) ||
          !tx(info.txId) ||
          !tx(info.roomTxId) ||
          (info.origin !== undefined && info.origin !== 'local' && info.origin !== 'remote') ||
          (info.resetReason !== undefined && typeof info.resetReason !== 'string')
        )
          throw new NativeFlockEntriesUnavailable();
        listener(readNativeFlockStateEntries(rows), {
          txId: info.txId,
          roomTxId: info.roomTxId,
          origin: info.origin,
          resetReason: info.resetReason,
        });
      };
      const handle: unknown = await Reflect.apply(subscribe, client, [
        namespace,
        room,
        query,
        receive,
      ]);
      if (
        !object(handle) ||
        typeof handle.unsubscribe !== 'function' ||
        typeof handle.isClosed !== 'boolean'
      )
        throw new NativeFlockEntriesUnavailable();
      const unsubscribe = handle.unsubscribe;
      return {
        get isClosed() {
          return Reflect.get(handle, 'isClosed') === true;
        },
        get currentValue() {
          return readNativeFlockStateEntries(Reflect.get(handle, 'currentValue'));
        },
        async unsubscribe() {
          await Reflect.apply(unsubscribe, handle, []);
        },
      };
    },
  };
}

/** Complete binary export is independent of the tombstone view API. Never
 * decode it through the legacy JSON/WASM value projection. */
export async function exportNativeFlockRaw(
  client: RepoClient,
  access: {
    readonly compatibility: NativeRepoSdkCompatibility | undefined;
    readonly sdkArtifactId: string | undefined;
  },
  namespace: string,
  room: RoomKey
): Promise<{ txId: TxId; roomTxId: TxId; bytes: Uint8Array }> {
  if (
    !access.compatibility?.rawFlockExport ||
    access.sdkArtifactId !== access.compatibility.artifactId
  )
    throw new NativeFlockEntriesUnavailable();
  const method: unknown = Reflect.get(client, 'exportFlockRaw');
  if (typeof method !== 'function') throw new NativeFlockEntriesUnavailable();
  const value: unknown = await Reflect.apply(method, client, [namespace, room]);
  if (
    !object(value) ||
    !tx(value.txId) ||
    !tx(value.roomTxId) ||
    !(value.bytes instanceof Uint8Array)
  )
    throw new NativeFlockEntriesUnavailable();
  return { txId: value.txId, roomTxId: value.roomTxId, bytes: value.bytes };
}
