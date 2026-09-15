import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AVATAR_CACHE_TTL_MS,
  clearAvatarImageCache,
  getAvatarBlobUrl,
  getPendingAvatarRevalidation,
  peekAvatarBlobUrl,
  resolveAvatarBlobUrl,
} from '../src/lib/avatar-cache';

class CacheStorageMock {
  private stores = new Map<string, Map<string, Response>>();

  async open(name: string) {
    const store = this.stores.get(name) ?? new Map<string, Response>();
    this.stores.set(name, store);
    return {
      match: async (key: string) => store.get(key)?.clone(),
      put: async (key: string, value: Response) => {
        store.set(key, value.clone());
      },
      delete: async (key: string) => store.delete(key),
      keys: async () => Array.from(store.keys()).map((url) => ({ url })),
    };
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }
}

type AvatarCacheMocks = {
  fetchMock: ReturnType<typeof vi.fn>;
};

// Install the window/URL/fetch shims the avatar cache depends on. Returns the
// fetch mock so each test can script responses.
const installAvatarCacheMocks = (): AvatarCacheMocks => {
  Object.defineProperty(globalThis, 'window', {
    value: {
      caches: new CacheStorageMock(),
      location: { origin: 'https://lody.ai' },
    },
    configurable: true,
    writable: true,
  });

  Object.defineProperty(URL, 'createObjectURL', {
    value: vi
      .fn()
      .mockImplementation(
        (blob: Blob) => `blob:${blob.size}:${Math.random().toString(16).slice(2)}`
      ),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
  });

  const fetchMock = vi.fn();
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchMock,
    configurable: true,
    writable: true,
  });

  return { fetchMock };
};

const pngResponse = (bytes: string) =>
  new Response(new Blob([bytes], { type: 'image/png' }), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });

// Start a cache-first read and capture the background revalidation it kicks
// off. `resolveAvatarBlobUrl` registers the revalidation synchronously on a
// memory-cache hit, so the handle exists before anything is awaited.
//
// Awaiting that handle is the explicit signal this suite waits on. An earlier
// version waited one macrotask plus one microtask instead, which is a guess
// about how many turns undici's `Response.blob()` + `Blob.arrayBuffer()` work
// takes: correct on an idle machine, occasionally short under a loaded parallel
// suite run, where the swap had not happened yet and `onUpdate` had not fired.
const startStaleRead = (
  image: string,
  onUpdate: (blobUrl: string) => void,
  now: number
): { returned: Promise<string | null | undefined>; revalidated: Promise<string | null> } => {
  const returned = resolveAvatarBlobUrl(image, { onUpdate }, now);
  const revalidated = getPendingAvatarRevalidation(image);
  if (!revalidated) {
    throw new Error('expected a background revalidation for a stale cached avatar');
  }
  return { returned, revalidated };
};

describe('avatar cache', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:00.000Z'));
    ({ fetchMock } = installAvatarCacheMocks());
  });

  afterEach(() => {
    clearAvatarImageCache();
    vi.useRealTimers();
  });

  it('returns nullish avatar sources without touching the network', async () => {
    expect(peekAvatarBlobUrl(null)).toBeNull();
    expect(peekAvatarBlobUrl(undefined)).toBeUndefined();
    expect(await getAvatarBlobUrl(null)).toBeNull();
    expect(await getAvatarBlobUrl(undefined)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads avatar blobs once and then reuses persistent cache without refetching', async () => {
    const avatarUrl = 'https://avatars.githubusercontent.com/u/1?v=4';

    fetchMock.mockResolvedValue(pngResponse('avatar'));

    const firstBlobUrl = await getAvatarBlobUrl(avatarUrl);
    expect(firstBlobUrl).toMatch(/^blob:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peekAvatarBlobUrl(avatarUrl)).toBe(firstBlobUrl);

    clearAvatarImageCache({ memory: true, persistent: false });
    fetchMock.mockClear();

    const secondBlobUrl = await getAvatarBlobUrl(avatarUrl);

    expect(secondBlobUrl).toMatch(/^blob:/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the persisted blob across a day boundary even when the network is down (cache-first, url-keyed)', async () => {
    // Regression guard for the old day-bucketed key: after a calendar-day
    // rollover the cache key no longer changes, so a persisted blob keeps
    // serving instead of degrading to a (here, failing) network fetch.
    const avatarUrl = 'https://avatars.githubusercontent.com/u/1?v=4';

    fetchMock.mockResolvedValueOnce(pngResponse('avatar'));

    await getAvatarBlobUrl(avatarUrl);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate a reload the next day: memory gone, persistent kept, and the
    // network unavailable.
    clearAvatarImageCache({ memory: true, persistent: false });
    vi.setSystemTime(Date.now() + AVATAR_CACHE_TTL_MS + 1);
    fetchMock.mockRejectedValue(new Error('offline'));

    const resolved = await getAvatarBlobUrl(avatarUrl);
    // Painted from the persistent cache, not blocked on the failed fetch.
    expect(resolved).toMatch(/^blob:/);
  });
});

// Revalidation exercises undici Blob/Response async work (fetch + `.blob()` +
// byte compare), whose turn count is not something a test should predict.
// Staleness is forced through an explicit `now` argument and completion is
// awaited through the revalidation handle, so no timer or turn count is
// involved either way.
describe('avatar cache revalidation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ fetchMock } = installAvatarCacheMocks());
  });

  afterEach(() => {
    clearAvatarImageCache();
  });

  it('revalidates a stale blob and swaps to the new one when the remote changed', async () => {
    const avatarUrl = 'https://avatars.githubusercontent.com/u/1?v=4';
    const t0 = 1_000_000;

    fetchMock.mockResolvedValueOnce(pngResponse('avatar-1'));
    const first = await getAvatarBlobUrl(avatarUrl, t0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(pngResponse('avatar-2-changed'));

    let swappedTo: string | undefined;
    // Cache-first: returns the stale blob immediately...
    const { returned, revalidated } = startStaleRead(
      avatarUrl,
      (url) => {
        swappedTo = url;
      },
      t0 + AVATAR_CACHE_TTL_MS + 1
    );
    expect(await returned).toBe(first);

    // ...then the background revalidation fetches, sees new bytes, and swaps.
    await revalidated;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(swappedTo).toMatch(/^blob:/);
    expect(swappedTo).not.toBe(first);
    expect(peekAvatarBlobUrl(avatarUrl)).toBe(swappedTo);
  });

  it('revalidates a stale blob but does NOT swap when the remote is unchanged', async () => {
    const avatarUrl = 'https://avatars.githubusercontent.com/u/1?v=4';
    const t0 = 1_000_000;

    fetchMock.mockResolvedValue(pngResponse('same-bytes'));

    const first = await getAvatarBlobUrl(avatarUrl, t0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let swappedTo: string | undefined;
    const { returned, revalidated } = startStaleRead(
      avatarUrl,
      (url) => {
        swappedTo = url;
      },
      t0 + AVATAR_CACHE_TTL_MS + 1
    );
    expect(await returned).toBe(first);

    await revalidated;
    // It revalidated (fetched) but the bytes matched, so no swap and the same
    // blob URL stays in the cache — no re-decode flicker.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(swappedTo).toBeUndefined();
    expect(peekAvatarBlobUrl(avatarUrl)).toBe(first);
  });
});
