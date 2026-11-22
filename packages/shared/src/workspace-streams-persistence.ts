import { z } from 'zod';
import { getLoroStreamsRemoteCursorUrlAliases } from './loro-streams-routing';
import type { IncompleteRecoveryStore } from '@loro-dev/streams-crdt';
import type { JsonObject, RemoteCursor, StreamsAuthProvider } from '@loro-dev/streams-crdt';
import type {
  StreamsReplicaPersistence,
  StreamsTransportAdapter,
} from 'loro-repo/transport/streams';

const MIN_CATCHUP_BYTES = 1024 * 1024;
const SNAPSHOT_COST_FACTOR = 2n;
const PROBE_TIMEOUT_MS = 1500;
const recoveryByOwner = new WeakMap<
  object,
  { forced: WeakSet<object>; recovered: WeakSet<object> }
>();
// Stream positions are twenty decimal byte digits, beyond Number's exact range.
const byteOffset = (value: string | null | undefined): bigint | null =>
  value && /^\d{20}$/.test(value) ? BigInt(value) : null;

function covers(local: JsonObject, remote: JsonObject): boolean {
  // Flock versions contain per-peer HLCs. Exact equality is conservative: any
  // unknown shape or extra local peer keeps the existing incremental path.
  return Object.entries(local).every(([peer, clock]) => {
    const known = remote[peer];
    return (
      clock !== null &&
      typeof clock === 'object' &&
      !Array.isArray(clock) &&
      known !== null &&
      typeof known === 'object' &&
      !Array.isArray(known) &&
      typeof clock.physicalTime === 'number' &&
      typeof clock.logicalCounter === 'number' &&
      clock.physicalTime === known.physicalTime &&
      clock.logicalCounter === known.logicalCounter
    );
  });
}

/** Advisory, header-only probes. Failures preserve normal SDK catch-up/auth recovery. */
async function snapshotIsCheaper(
  url: string,
  cursor: RemoteCursor,
  auth: StreamsAuthProvider | undefined
): Promise<boolean> {
  const local = byteOffset(cursor.nextOffset);
  if (local === null) return false;
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const request = async (endpoint: string, method: 'HEAD' | 'GET'): Promise<Response> => {
    const token =
      typeof auth === 'function'
        ? await Promise.race([Promise.resolve(auth({ reason: 'request' }, signal)), aborted])
        : auth;
    signal.throwIfAborted();
    return Promise.race([
      fetch(endpoint, {
        method,
        signal,
        redirect: 'error',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
      aborted,
    ]);
  };
  try {
    const response = await request(url, 'HEAD');
    if (!response.ok) return false;
    const tail = byteOffset(response.headers.get('Stream-Next-Offset'));
    const snapshot = byteOffset(response.headers.get('Stream-Snapshot-Offset'));
    if (
      tail === null ||
      snapshot === null ||
      snapshot <= local ||
      tail < snapshot ||
      tail - local <= BigInt(MIN_CATCHUP_BYTES)
    )
      return false;
    // Pin the estimate to this snapshot, rather than /snapshot's moving latest.
    const sizeResponse = await request(
      `${url}/snapshot/${snapshot.toString().padStart(20, '0')}`,
      'GET'
    );
    // Snapshot routes expose GET, not HEAD. Cancel the body after reading its
    // Content-Length; do not download/decrypt it twice or treat it as trusted data.
    await Promise.race([sizeResponse.body?.cancel(), aborted]);
    const length = sizeResponse.headers.get('Content-Length');
    if (!sizeResponse.ok || !length || !/^\d{1,20}$/.test(length)) return false;
    const bytes = BigInt(length);
    if (bytes <= 0n) return false;
    const cost = SNAPSHOT_COST_FACTOR * bytes + tail - snapshot;
    return tail - local > (cost > BigInt(MIN_CATCHUP_BYTES) ? cost : BigInt(MIN_CATCHUP_BYTES));
  } catch {
    return false;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Keeps Repo's resource barriers and replica-bound stores. Only the read strategy
 * changes; the SDK still verifies, merges, persists and then checkpoints bootstrap.
 */
export function createWorkspaceStreamsTransportAdapter<
  Adapter extends Pick<StreamsTransportAdapter, 'joinFlockDocRoom' | 'syncFlockDoc'>,
>(
  createAdapter: (persistence: StreamsReplicaPersistence) => Adapter,
  options: {
    persistence: StreamsReplicaPersistence;
    owner: object;
    auth: StreamsAuthProvider | undefined;
    recoverFlockCheckpointsOnTimeout?: boolean;
  }
): Adapter {
  const persistence = options.persistence;
  const owner = options.owner;
  let recovery = recoveryByOwner.get(owner);
  if (!recovery) {
    recovery = { forced: new WeakSet(), recovered: new WeakSet() };
    recoveryByOwner.set(owner, recovery);
  }
  const { forced, recovered } = recovery;
  const adapter = createAdapter({
    ...persistence,
    cursorStoreFor: (target) => {
      const store = persistence.cursorStoreFor(target);
      return {
        async load(url) {
          const cursor = await store.load(url);
          if (!cursor) {
            forced.delete(target.flock);
            return null;
          }
          if (
            forced.has(target.flock) ||
            (covers(target.flock.version(), cursor.serverLowerBoundVersion) &&
              (await snapshotIsCheaper(url, cursor, options.auth)) &&
              covers(target.flock.version(), cursor.serverLowerBoundVersion))
          ) {
            // Delete progress only. Bootstrap merges into the same replica;
            // SDK exports writes made before or during that merge afterwards.
            await store.delete?.(url);
            forced.delete(target.flock);
            return null;
          }
          return cursor;
        },
        save: (cursor) => store.save(cursor),
        delete: store.delete ? (url) => store.delete!(url) : undefined,
      };
    },
  });
  const requestBootstrap = (flock: object) => {
    if (!options.recoverFlockCheckpointsOnTimeout || recovered.has(flock)) return;
    recovered.add(flock);
    forced.add(flock);
  };
  // Keep the caller's SDK instance: CLI and renderer can resolve different
  // pnpm peer graphs with separate nominal Repo/transport classes.
  const join = adapter.joinFlockDocRoom.bind(adapter);
  adapter.joinFlockDocRoom = (id, flock, params) => {
    const subscription = join(id, flock, params);
    void subscription.firstSyncedWithRemote.catch((error: unknown) => {
      // Only the SDK hard deadline qualifies, never authentication, crypto or
      // persistence errors. The existing room owner schedules the next attempt.
      if (
        error &&
        typeof error === 'object' &&
        'streamsCode' in error &&
        error.streamsCode === 'initial_sync_timeout'
      )
        requestBootstrap(flock);
    });
    return subscription;
  };
  const sync = adapter.syncFlockDoc.bind(adapter);
  adapter.syncFlockDoc = async (id, flock, params) => {
    const result = await sync(id, flock, params);
    if (!result.ok && result.error?.streamsCode === 'initial_sync_timeout') requestBootstrap(flock);
    return result;
  };
  return adapter;
}

const incompleteRecoveryRecord = z.object({
  streamUrl: z.string().url(),
  observedTailOffset: z.string().min(1),
  observedSnapshotOffset: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  updatedAtMs: z.number().finite(),
});

/** Advisory recovery metadata is separate from replica-bound replay cursors. */
export function createAliasedIncompleteRecoveryStore(backend: {
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}): IncompleteRecoveryStore {
  const keyOf = (url: string) =>
    [url, ...getLoroStreamsRemoteCursorUrlAliases(url)].sort().at(0) ?? url;
  return {
    async load(streamUrl) {
      const record = incompleteRecoveryRecord.safeParse(await backend.load(keyOf(streamUrl)));
      return record.success && keyOf(record.data.streamUrl) === keyOf(streamUrl)
        ? { ...record.data, streamUrl }
        : null;
    },
    save: (record) => backend.save(keyOf(record.streamUrl), record),
    delete: (url) => backend.delete(keyOf(url)),
  };
}
