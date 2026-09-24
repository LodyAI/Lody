import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStoreRefTracker, createManagedStoreCache } from '../src/providers/store-ref-tracker';

describe('createStoreRefTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onRelease after delay when ref count drops to 0', () => {
    const onRelease = vi.fn();
    const tracker = createStoreRefTracker({ releaseDelayMs: 60_000, onRelease });

    tracker.acquire('a');
    tracker.release('a');

    expect(onRelease).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onRelease).toHaveBeenCalledWith('a');
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('does not call onRelease if re-acquired before delay', () => {
    const onRelease = vi.fn();
    const tracker = createStoreRefTracker({ releaseDelayMs: 60_000, onRelease });

    tracker.acquire('a');
    tracker.release('a');

    vi.advanceTimersByTime(30_000);
    tracker.acquire('a');

    vi.advanceTimersByTime(60_000);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('requires all refs to be released before starting timer', () => {
    const onRelease = vi.fn();
    const tracker = createStoreRefTracker({ releaseDelayMs: 60_000, onRelease });

    tracker.acquire('a');
    tracker.acquire('a');
    tracker.release('a');

    vi.advanceTimersByTime(60_000);
    expect(onRelease).not.toHaveBeenCalled();

    tracker.release('a');
    vi.advanceTimersByTime(60_000);
    expect(onRelease).toHaveBeenCalledWith('a');
  });

  it('forceRelease cancels pending timer', () => {
    const onRelease = vi.fn();
    const tracker = createStoreRefTracker({ releaseDelayMs: 60_000, onRelease });

    tracker.acquire('a');
    tracker.release('a');
    tracker.forceRelease('a');

    vi.advanceTimersByTime(60_000);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('dispose cancels all pending timers', () => {
    const onRelease = vi.fn();
    const tracker = createStoreRefTracker({ releaseDelayMs: 60_000, onRelease });

    tracker.acquire('a');
    tracker.acquire('b');
    tracker.release('a');
    tracker.release('b');
    tracker.dispose();

    vi.advanceTimersByTime(60_000);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('handles release without prior acquire gracefully', () => {
    const onRelease = vi.fn();
    const tracker = createStoreRefTracker({ releaseDelayMs: 60_000, onRelease });

    tracker.release('unknown');
    vi.advanceTimersByTime(60_000);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('tracks independent keys separately', () => {
    const onRelease = vi.fn();
    const tracker = createStoreRefTracker({ releaseDelayMs: 60_000, onRelease });

    tracker.acquire('a');
    tracker.acquire('b');
    tracker.release('a');

    vi.advanceTimersByTime(60_000);
    expect(onRelease).toHaveBeenCalledWith('a');
    expect(onRelease).not.toHaveBeenCalledWith('b');
  });

  it('returns keys waiting for delayed release', () => {
    const onRelease = vi.fn();
    const tracker = createStoreRefTracker({ releaseDelayMs: 60_000, onRelease });

    tracker.acquire('a');
    tracker.acquire('b');
    tracker.acquire('c');
    tracker.release('a');
    tracker.release('b');
    tracker.acquire('b');

    expect(tracker.getPendingReleaseKeys()).toEqual(['a']);
  });
});

describe('createManagedStoreCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createMockStore = () => ({ dispose: vi.fn() });
  const flushMicrotasks = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  };

  it('peeks only settled, still-cached stores', async () => {
    let finish!: (store: ReturnType<typeof createMockStore>) => void;
    const store = createMockStore();
    const cache = createManagedStoreCache({
      create: () =>
        new Promise<ReturnType<typeof createMockStore>>((resolve) => (finish = resolve)),
      releaseDelayMs: 60_000,
    });

    const pending = cache.acquire('a');
    expect(cache.peek('a')).toBeUndefined();
    finish(store);
    await pending;
    expect(cache.peek('a')).toBe(store);

    await cache.release('a');
    expect(store.dispose).toHaveBeenCalled();
    expect(cache.peek('a')).toBeUndefined();
  });

  it('never peeks a failed create', async () => {
    const cache = createManagedStoreCache({
      create: () => Promise.reject(new Error('boom')),
      releaseDelayMs: 60_000,
    });
    await expect(cache.acquire('a')).rejects.toThrow('boom');
    expect(cache.peek('a')).toBeUndefined();
  });

  it('caches stores by key', async () => {
    const create = vi.fn().mockResolvedValue(createMockStore());
    const cache = createManagedStoreCache({ create, releaseDelayMs: 60_000 });

    const a = await cache.get('x');
    const b = await cache.get('x');
    expect(a).toBe(b);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('acquire increments ref, releaseRef starts delayed dispose', async () => {
    const store = createMockStore();
    const cache = createManagedStoreCache({
      create: async () => store,
      releaseDelayMs: 60_000,
    });

    await cache.acquire('x');
    cache.releaseRef('x');

    expect(store.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.dispose).toHaveBeenCalledTimes(1);
  });

  it('re-acquire before delay cancels dispose', async () => {
    const store = createMockStore();
    const cache = createManagedStoreCache({
      create: async () => store,
      releaseDelayMs: 60_000,
    });

    await cache.acquire('x');
    cache.releaseRef('x');
    vi.advanceTimersByTime(30_000);

    await cache.acquire('x');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.dispose).not.toHaveBeenCalled();
  });

  it('hard release disposes immediately', async () => {
    const store = createMockStore();
    const cache = createManagedStoreCache({
      create: async () => store,
      releaseDelayMs: 60_000,
    });

    await cache.get('x');
    await cache.release('x');
    expect(store.dispose).toHaveBeenCalledTimes(1);
  });

  it('releaseIdle disposes only stores waiting for delayed release', async () => {
    const idleStore = createMockStore();
    const activeStore = createMockStore();
    const stores = new Map([
      ['idle', idleStore],
      ['active', activeStore],
    ]);
    const cache = createManagedStoreCache({
      create: async (key: string) => {
        const store = stores.get(key);
        if (!store) {
          throw new Error(`Missing test store for ${key}`);
        }
        return store;
      },
      releaseDelayMs: 60_000,
    });

    await cache.acquire('idle');
    await cache.acquire('active');
    cache.releaseRef('idle');

    await cache.releaseIdle();

    expect(idleStore.dispose).toHaveBeenCalledTimes(1);
    expect(activeStore.dispose).not.toHaveBeenCalled();
  });

  it('disposeAll disposes all cached stores', async () => {
    const stores = [createMockStore(), createMockStore()];
    let i = 0;
    const cache = createManagedStoreCache({
      create: async () => stores[i++]!,
      releaseDelayMs: 60_000,
    });

    await cache.get('a');
    await cache.get('b');
    await cache.disposeAll();
    expect(stores[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(stores[1]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('removes cache entry on create failure', async () => {
    let calls = 0;
    const store = createMockStore();
    const cache = createManagedStoreCache({
      create: async () => {
        if (calls++ === 0) throw new Error('fail');
        return store;
      },
      releaseDelayMs: 60_000,
    });

    await expect(cache.get('x')).rejects.toThrow('fail');
    const result = await cache.get('x');
    expect(result).toBe(store);
  });

  it('hard release calls unload exactly once, after dispose', async () => {
    const order: string[] = [];
    const store = {
      dispose: vi.fn(() => {
        order.push('dispose');
      }),
    };
    const unload = vi.fn(async () => {
      order.push('unload');
    });
    const cache = createManagedStoreCache({
      create: async () => store,
      releaseDelayMs: 60_000,
      unload,
    });

    await cache.get('x');
    await cache.release('x');

    expect(unload).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledWith('x');
    expect(order).toEqual(['dispose', 'unload']);
  });

  it('delayed release unloads after the delay elapses', async () => {
    const store = createMockStore();
    const unload = vi.fn(async () => {});
    const cache = createManagedStoreCache({
      create: async () => store,
      releaseDelayMs: 60_000,
      unload,
    });

    await cache.acquire('x');
    cache.releaseRef('x');

    expect(unload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.dispose).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledTimes(1);
  });

  it('re-acquire within the release delay skips dispose and unload', async () => {
    const store = createMockStore();
    const unload = vi.fn(async () => {});
    const cache = createManagedStoreCache({
      create: async () => store,
      releaseDelayMs: 60_000,
      unload,
    });

    await cache.acquire('x');
    cache.releaseRef('x');
    vi.advanceTimersByTime(30_000);

    await cache.acquire('x');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(store.dispose).not.toHaveBeenCalled();
    expect(unload).not.toHaveBeenCalled();
  });

  it('acquire during an in-flight unload waits for it and creates a fresh store', async () => {
    const storeA = createMockStore();
    const storeB = createMockStore();
    const mockStores = [storeA, storeB];
    let i = 0;
    const create = vi.fn(async () => mockStores[i++]!);
    let resolveUnload: (() => void) | undefined;
    const unload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnload = resolve;
        })
    );
    const cache = createManagedStoreCache({ create, releaseDelayMs: 60_000, unload });

    await cache.get('x');
    const releasePromise = cache.release('x');
    const acquirePromise = cache.acquire('x');
    let acquired: ReturnType<typeof createMockStore> | undefined;
    void acquirePromise.then((s) => {
      acquired = s;
    });
    await flushMicrotasks();

    // The old store was disposed and its unload is in flight; the re-acquire
    // must not resolve (nor even create) until the disposal settles.
    expect(storeA.dispose).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(acquired).toBeUndefined();

    resolveUnload?.();
    await releasePromise;
    await expect(acquirePromise).resolves.toBe(storeB);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('concurrent gets during a pending disposal share a single create', async () => {
    const storeA = createMockStore();
    const storeB = createMockStore();
    const mockStores = [storeA, storeB];
    let i = 0;
    const create = vi.fn(async () => mockStores[i++]!);
    let resolveUnload: (() => void) | undefined;
    const unload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnload = resolve;
        })
    );
    const cache = createManagedStoreCache({ create, releaseDelayMs: 60_000, unload });

    await cache.get('x');
    const releasePromise = cache.release('x');
    const first = cache.get('x');
    const second = cache.get('x');
    await flushMicrotasks();

    resolveUnload?.();
    await releasePromise;
    await expect(first).resolves.toBe(storeB);
    await expect(second).resolves.toBe(storeB);
    // One initial create plus exactly one shared re-create.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('unload rejection resolves release, warns, and retries on the next cycle', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let unloadCalls = 0;
      const unload = vi.fn(async () => {
        if (unloadCalls++ === 0) {
          throw new Error('unload fail');
        }
      });
      const mockStores = [createMockStore(), createMockStore()];
      let i = 0;
      const cache = createManagedStoreCache({
        create: async () => mockStores[i++]!,
        releaseDelayMs: 60_000,
        unload,
      });

      await cache.get('x');
      await expect(cache.release('x')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to unload doc for released store',
        expect.objectContaining({ key: 'x', error: expect.any(Error) })
      );

      // The next acquire→release cycle retries the unload.
      await cache.get('x');
      await cache.release('x');
      expect(unload).toHaveBeenCalledTimes(2);
      expect(mockStores[1]!.dispose).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('releaseIfIdle leaves stores with active refs untouched', async () => {
    const store = createMockStore();
    const unload = vi.fn(async () => {});
    const cache = createManagedStoreCache({
      create: async () => store,
      releaseDelayMs: 60_000,
      unload,
    });

    await cache.acquire('x');
    await cache.releaseIfIdle('x');

    expect(store.dispose).not.toHaveBeenCalled();
    expect(unload).not.toHaveBeenCalled();
  });

  it('disposeAll disposes stores without unloading', async () => {
    const unload = vi.fn(async () => {});
    const mockStores = [createMockStore(), createMockStore()];
    let i = 0;
    const cache = createManagedStoreCache({
      create: async () => mockStores[i++]!,
      releaseDelayMs: 60_000,
      unload,
    });

    await cache.get('a');
    await cache.get('b');
    await cache.disposeAll();

    expect(mockStores[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(mockStores[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(unload).not.toHaveBeenCalled();
  });
});
