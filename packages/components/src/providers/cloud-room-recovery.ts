import type { RepoTransportRoomEntry } from 'loro-repo';

const CLOUD_ROOM_BASE_DELAY_MS = 30_000;
const CLOUD_ROOM_MAX_DELAY_MS = 300_000;
const CLOUD_REJOIN_SWEEP_CONCURRENCY = 4;
const CLOUD_REJOIN_SWEEP_BUDGET_MS = 30_000;
const roomKey = (entry: RepoTransportRoomEntry) => `${entry.room.kind}:${entry.room.id}`;

/** Room policy for the runtime-owned cloud retry loop; raw rejoins remain runtime-owned. */
export function createCloudRoomRecovery(options: {
  listRooms: () => readonly RepoTransportRoomEntry[];
  reconnect: (force: boolean) => Promise<unknown>;
  rejoin: (entry: RepoTransportRoomEntry) => Promise<void>;
  isClosing: () => boolean;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const backoff = new Map<string, { attempts: number; nextAtMs: number }>();
  const problemRooms = () => {
    const rooms = options.listRooms();
    const erroredKeys = new Set(
      rooms.filter((entry) => entry.subscription.status === 'error').map(roomKey)
    );
    for (const key of backoff.keys()) {
      if (!erroredKeys.has(key)) backoff.delete(key);
    }
    return rooms.filter(
      (entry) =>
        entry.subscription.status === 'error' || entry.subscription.status === 'disconnected'
    );
  };
  return {
    update: () => {
      problemRooms();
    },
    // Reading on every state update clears a recovered/closed room immediately.
    getRetryDelayMs(defaultDelayMs: number): number {
      const rooms = problemRooms();
      if (rooms.length === 0) return defaultDelayMs;
      let earliest = Infinity;
      for (const entry of rooms) {
        const retry = backoff.get(roomKey(entry));
        if (!retry) return Math.min(defaultDelayMs, CLOUD_ROOM_BASE_DELAY_MS);
        earliest = Math.min(earliest, retry.nextAtMs);
      }
      return Math.max(0, earliest - now());
    },
    async recover(force: boolean): Promise<void> {
      const rooms = problemRooms();
      // Even resetBackoff:false reconnects every errored adapter session. Use
      // room-local repair whenever errors exist, so the sweep budget and room
      // deadlines apply to every periodic attempt, including the first one.
      if (force || !rooms.some((entry) => entry.subscription.status === 'error')) {
        await options.reconnect(force);
      }
      const retryAt = (entry: RepoTransportRoomEntry) => backoff.get(roomKey(entry))?.nextAtMs ?? 0;
      const due = problemRooms()
        .filter((entry) => force || retryAt(entry) <= now())
        // Untouched leftovers/new errors precede older retries, even if those
        // retries became due while a slow batch consumed the sweep budget.
        .sort((left, right) => retryAt(left) - retryAt(right));
      const deadline = now() + CLOUD_REJOIN_SWEEP_BUDGET_MS;
      for (let index = 0; index < due.length; index += CLOUD_REJOIN_SWEEP_CONCURRENCY) {
        if (options.isClosing() || now() >= deadline) break;
        await Promise.all(
          due.slice(index, index + CLOUD_REJOIN_SWEEP_CONCURRENCY).map(async (entry) => {
            if (entry.subscription.status === 'error') {
              const attempts = backoff.get(roomKey(entry))?.attempts ?? 0;
              backoff.set(roomKey(entry), {
                attempts: Math.min(attempts + 1, 4),
                nextAtMs:
                  now() +
                  Math.min(CLOUD_ROOM_MAX_DELAY_MS, CLOUD_ROOM_BASE_DELAY_MS * 2 ** attempts),
              });
            } else if (entry.subscription.status !== 'disconnected') {
              return;
            }
            await options.rejoin(entry);
          })
        );
      }
      problemRooms();
    },
  };
}
