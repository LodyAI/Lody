/**
 * Reference-counting tracker for stores with delayed release.
 *
 * When the last consumer releases a store, a timer starts. If no new consumer
 * acquires within the delay window, `onRelease` is called to dispose the store
 * and close the underlying connection (e.g. SSE).
 */
export type StoreRefTracker<K> = {
  /** Increment the ref count for `key`. Cancels any pending delayed release. */
  acquire(key: K): void;
  /** Decrement the ref count for `key`. Starts delayed release when it hits 0. */
  release(key: K): boolean;
  /** Whether `key` is currently idle and waiting for delayed release. */
  isPendingRelease(key: K): boolean;
  /** Keys that are currently idle and waiting for delayed release. */
  getPendingReleaseKeys(): K[];
  /** Immediately cancel any pending timer for `key` and remove tracking state. */
  forceRelease(key: K): void;
  /** Cancel all pending timers and clear all tracking state. */
  dispose(): void;
};

type TrackerEntry = {
  refCount: number;
  timerId: ReturnType<typeof setTimeout> | null;
};

export function createStoreRefTracker<K>(opts: {
  releaseDelayMs: number;
  onRelease: (key: K) => void;
}): StoreRefTracker<K> {
  const entries = new Map<K, TrackerEntry>();

  const acquire = (key: K) => {
    const entry = entries.get(key);
    if (entry) {
      entry.refCount++;
      if (entry.timerId !== null) {
        clearTimeout(entry.timerId);
        entry.timerId = null;
      }
    } else {
      entries.set(key, { refCount: 1, timerId: null });
    }
  };

  const release = (key: K): boolean => {
    const entry = entries.get(key);
    if (!entry) {
      return false;
    }
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount === 0 && entry.timerId === null) {
      entry.timerId = setTimeout(() => {
        entries.delete(key);
        opts.onRelease(key);
      }, opts.releaseDelayMs);
      return true;
    }
    return entry.refCount === 0;
  };

  const isPendingRelease = (key: K): boolean => {
    const entry = entries.get(key);
    return entry?.refCount === 0 && entry.timerId !== null;
  };

  const getPendingReleaseKeys = (): K[] => {
    const keys: K[] = [];
    for (const [key, entry] of entries) {
      if (entry.refCount === 0 && entry.timerId !== null) {
        keys.push(key);
      }
    }
    return keys;
  };

  const forceRelease = (key: K) => {
    const entry = entries.get(key);
    if (!entry) {
      return;
    }
    if (entry.timerId !== null) {
      clearTimeout(entry.timerId);
    }
    entries.delete(key);
  };

  const dispose = () => {
    for (const [, entry] of entries) {
      if (entry.timerId !== null) {
        clearTimeout(entry.timerId);
      }
    }
    entries.clear();
  };

  return { acquire, release, isPendingRelease, getPendingReleaseKeys, forceRelease, dispose };
}

/**
 * Cached store manager with ref-counted delayed release.
 *
 * Combines a Promise cache (deduplicates concurrent creates) with a
 * StoreRefTracker (auto-disposes idle stores after a delay).
 *
 * Ownership model: the cache is the single owner of the resource behind each
 * store. A hard release disposes the store and then runs the optional
 * `unload` hook (e.g. `repo.unloadDoc(roomId)`), serialized per key — a
 * re-acquire during an in-flight disposal waits for it to settle and then
 * creates a fresh store, so no consumer ever receives a store whose backing
 * doc is about to be unloaded underneath it.
 */
export type ManagedStoreCache<K, V> = {
  /** Get or create a cached store. Does not affect ref count. */
  get(key: K): Promise<V>;
  /** Hard release: cancel any pending timer, remove from cache, dispose and unload. */
  release(key: K): Promise<void>;
  /** Get-or-create and increment ref count. */
  acquire(key: K): Promise<V>;
  /**
   * The store for `key` if it is already created and cached, synchronously.
   * Does not affect ref count: a consumer rendering from it must still
   * `acquire` it (in an effect) to keep it alive.
   */
  peek(key: K): V | undefined;
  /** Decrement ref count. Starts delayed release when it hits 0. */
  releaseRef(key: K): void;
  /**
   * Dispose `key` only if it is currently idle (ref count 0, waiting for delayed
   * release). A store with active consumers is left untouched. Used for bounded
   * eviction of warm-but-unused stores.
   */
  releaseIfIdle(key: K): Promise<void>;
  /** Dispose all stores that are idle and only being kept warm by delayed release. */
  releaseIdle(): Promise<void>;
  /** Cancel all timers, dispose all cached stores. */
  disposeAll(): Promise<void>;
};

export function createManagedStoreCache<K, V extends { dispose(): void }>(opts: {
  create: (key: K) => Promise<V>;
  releaseDelayMs: number;
  /**
   * Called after `dispose()` on every hard release to free the resource
   * backing the store (e.g. `repo.unloadDoc(roomId)`). Failures are logged
   * and swallowed: loro-repo keeps a dirty doc in its map when unload fails,
   * so data stays safe and the next acquire→release cycle retries implicitly.
   */
  unload?: (key: K) => Promise<void>;
}): ManagedStoreCache<K, V> {
  const stores = new Map<K, Promise<V>>();
  // Settled values of `stores`, so an already-open store can be read without
  // waiting for a promise tick (a first render can then show it at once).
  const settled = new Map<K, V>();
  // Per-key in-flight dispose+unload chains. `get` serializes re-creation
  // behind these so a new store is only built after the old doc is unloaded.
  const pendingDisposals = new Map<K, Promise<void>>();

  // Forward-declared so the tracker's onRelease can call release().
  const release = async (key: K): Promise<void> => {
    tracker.forceRelease(key);
    const existing = stores.get(key);
    if (!existing) {
      return;
    }
    stores.delete(key);
    settled.delete(key);
    const disposal = (async () => {
      let store: V | undefined;
      try {
        store = await existing;
      } catch {
        // Store creation failure was already surfaced to get() callers.
      }
      store?.dispose();
      try {
        await opts.unload?.(key);
      } catch (error) {
        // Do not reject callers: an unload failure leaves the dirty doc in
        // loro-repo's map, so nothing is lost; the retry happens implicitly
        // on the next acquire→release cycle.
        console.warn('Failed to unload doc for released store', { key, error });
      }
    })();
    // Registered synchronously so a concurrent get() observes the disposal
    // before any of its awaits settle.
    pendingDisposals.set(key, disposal);
    try {
      await disposal;
    } finally {
      if (pendingDisposals.get(key) === disposal) {
        pendingDisposals.delete(key);
      }
    }
  };

  const tracker = createStoreRefTracker<K>({
    releaseDelayMs: opts.releaseDelayMs,
    onRelease: (key) => void release(key),
  });

  const get = (key: K): Promise<V> => {
    const existing = stores.get(key);
    if (existing) {
      return existing;
    }
    // Serialize behind an in-flight disposal: the new store must be created
    // only after the old doc was unloaded, or it would be yanked from under us.
    const pending = pendingDisposals.get(key);
    const created = pending
      ? pending.catch(() => {}).then(() => opts.create(key))
      : opts.create(key);
    const promise = created.then(
      (store) => {
        if (stores.get(key) === promise) settled.set(key, store);
        return store;
      },
      (error: unknown) => {
        stores.delete(key);
        throw error;
      }
    );
    stores.set(key, promise);
    return promise;
  };

  const acquire = async (key: K): Promise<V> => {
    const store = await get(key);
    tracker.acquire(key);
    return store;
  };

  const peek = (key: K): V | undefined => settled.get(key);

  const releaseRef = (key: K): void => {
    tracker.release(key);
  };

  const releaseIfIdle = async (key: K): Promise<void> => {
    if (tracker.isPendingRelease(key)) {
      await release(key);
    }
  };

  const releaseIdle = async (): Promise<void> => {
    const keys = tracker.getPendingReleaseKeys();
    await Promise.all(keys.map((key) => release(key)));
  };

  const disposeAll = async (): Promise<void> => {
    tracker.dispose();
    // Let in-flight dispose+unload chains settle so destroy doesn't race them.
    await Promise.allSettled([...pendingDisposals.values()]);
    // Intentionally no per-key unload here: this path is only used on full
    // workspace destroy, which is immediately followed by repo.destroy();
    // unloading each doc would serialize N persists for nothing.
    settled.clear();
    for (const [key, storePromise] of stores) {
      stores.delete(key);
      try {
        const store = await storePromise;
        store.dispose();
      } catch {
        // ignore — store creation may have failed
      }
    }
  };

  return { get, release, acquire, peek, releaseRef, releaseIfIdle, releaseIdle, disposeAll };
}
