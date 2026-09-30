import type { RepoRoomSubscription } from 'loro-repo';
import type { ManagedStoreCache } from './store-ref-tracker';

type Binding = ReturnType<RepoRoomSubscription['subscription']>;
/** Keep an authored room referenced through detach/reconnect until its write is acknowledged. */
export function waitForScheduleWriteSync(binding: Binding, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let checking = false;
    let finished = false;
    let generation = 0;
    let off = () => {};
    const done = () => {
      if (finished) return;
      finished = true;
      off();
      signal.removeEventListener('abort', done);
      resolve();
    };
    const check = async () => {
      if (checking || finished || binding.status !== 'joined') return;
      checking = true;
      const current = generation;
      try {
        await binding.waitUntilSynced();
        if (current === generation && binding.status === 'joined') done();
      } catch {
        // Keep the write referenced until the next connection edge retries.
      } finally {
        checking = false;
        if (current !== generation) void check();
      }
    };
    off = binding.onStatusChange(() => {
      generation++;
      void check();
    });
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
    else void check();
  });
}

/** Resolve on local durability; hold the uploader through idle eviction and reconnect. */
export async function withScheduleWrite<
  T,
  S extends {
    dispose(): void;
    waitUntilSynced(): Promise<void>;
    getState(): unknown;
    firstSynced: Promise<void>;
  },
>(
  cache: ManagedStoreCache<string, S>,
  id: string,
  write: (store: S) => T | Promise<T>,
  options?: { create?: boolean }
): Promise<T> {
  const store = await cache.acquire(id);
  try {
    if (!options?.create && !store.getState()) await store.firstSynced;
    return await write(store);
  } finally {
    void store
      .waitUntilSynced()
      .finally(() => cache.releaseRef(id))
      .catch(() => {});
  }
}
