/**
 * Local-first avatar cache with stale-while-revalidate semantics.
 *
 * The renderer keeps a durable copy of every avatar so it paints instantly
 * (and offline) instead of re-hitting the network on each mount. Reads are
 * cache-first: if a local blob exists we render it immediately, then check the
 * remote in the background and swap ONLY if the bytes actually changed.
 *
 * Two layers:
 *   - in-memory `Map<cacheKey, entry>` of `blob:` object URLs (synchronous hits)
 *   - persistent CacheStorage bucket (survives reloads / offline)
 *
 * The cache key is derived from the avatar URL alone — deliberately NOT
 * time-bucketed. An earlier version embedded `floor(now / 24h)` in the key as a
 * crude TTL; that made every calendar-day rollover a guaranteed cache miss
 * (startup rehydrate warms yesterday's keys, but the render reads today's key),
 * degrading back to a blocking network fetch and a blank avatar whenever that
 * fetch was slow or failed. Freshness is now handled by revalidation, not by
 * rotating the key, so a persisted blob keeps serving across days and reloads.
 */

/** How long a cached blob is served before we revalidate it against the remote. */
export const AVATAR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type ClearAvatarCacheOptions = {
  memory?: boolean;
  persistent?: boolean;
};

type AvatarCacheEntry = {
  blobUrl: string;
  blob: Blob;
  fetchedAt: number;
};

const AVATAR_IMAGE_PERSISTENT_CACHE_NAME = 'lody-avatar-image-v2';
/** Legacy day-bucketed bucket, dropped on first rehydrate. */
const AVATAR_IMAGE_LEGACY_CACHE_NAME = 'lody-avatar-image-v1';
const AVATAR_FETCHED_AT_HEADER = 'x-lody-avatar-fetched-at';

const avatarMemoryCache = new Map<string, AvatarCacheEntry>();
const inFlightAvatarLoads = new Map<string, Promise<string>>();
const inFlightRevalidations = new Map<string, Promise<string | null>>();

/**
 * Object URLs replaced by a revalidation swap. We can't revoke them the instant
 * we swap — a mounted `<img>` may still be pointing at one until React commits
 * the new src — so we retire them and revoke on the next cache operation, by
 * which point nothing renders them anymore.
 */
const retiredBlobUrls: string[] = [];

const supportsPersistentCacheStorage = (): boolean => {
  return typeof window !== 'undefined' && typeof window.caches !== 'undefined';
};

const flushRetiredBlobUrls = (): void => {
  while (retiredBlobUrls.length > 0) {
    const url = retiredBlobUrls.pop();
    if (url) URL.revokeObjectURL(url);
  }
};

const getAvatarCacheKey = (image: string): string => {
  if (typeof window === 'undefined') {
    return image;
  }

  const url = new URL('/__lody/avatar-cache', window.location.origin);
  url.searchParams.set('src', image);
  return url.toString();
};

const readPersistedAvatarEntry = async (
  cacheKey: string
): Promise<{ blob: Blob; fetchedAt: number } | null> => {
  if (!supportsPersistentCacheStorage()) {
    return null;
  }

  try {
    const cache = await window.caches.open(AVATAR_IMAGE_PERSISTENT_CACHE_NAME);
    const response = await cache.match(cacheKey);
    if (!response) return null;
    const blob = await response.blob();
    const header = response.headers.get(AVATAR_FETCHED_AT_HEADER);
    // Missing/legacy header → treat as maximally stale so it revalidates once.
    const fetchedAt = header != null ? Number(header) : 0;
    return { blob, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 };
  } catch {
    return null;
  }
};

const writePersistedAvatarBlob = async (
  cacheKey: string,
  blob: Blob,
  fetchedAt: number
): Promise<void> => {
  if (!supportsPersistentCacheStorage()) {
    return;
  }

  try {
    const cache = await window.caches.open(AVATAR_IMAGE_PERSISTENT_CACHE_NAME);
    await cache.put(
      cacheKey,
      new Response(blob, {
        status: 200,
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000, immutable',
          [AVATAR_FETCHED_AT_HEADER]: String(fetchedAt),
        },
      })
    );
  } catch {
    // ignore
  }
};

const rememberAvatarBlob = (cacheKey: string, blob: Blob, fetchedAt: number): string => {
  const previous = avatarMemoryCache.get(cacheKey);
  if (previous) {
    // Defer revocation: the old URL may still be on screen until React swaps.
    retiredBlobUrls.push(previous.blobUrl);
  }

  const blobUrl = URL.createObjectURL(blob);
  avatarMemoryCache.set(cacheKey, { blobUrl, blob, fetchedAt });
  return blobUrl;
};

const fetchAvatarBlob = async (image: string): Promise<Blob> => {
  const response = await fetch(image, {
    credentials: 'omit',
    mode: 'cors',
  });
  if (!response.ok) {
    throw new Error(`Failed to load avatar (${response.status})`);
  }
  return await response.blob();
};

const blobsEqual = async (a: Blob, b: Blob): Promise<boolean> => {
  if (a.size !== b.size) return false;
  const [ab, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  const av = new Uint8Array(ab);
  const bv = new Uint8Array(bb);
  for (let i = 0; i < av.length; i += 1) {
    if (av[i] !== bv[i]) return false;
  }
  return true;
};

/**
 * If the cached entry is older than the TTL, fetch the remote once in the
 * background and, when the bytes differ from what we're showing, replace the
 * cache and resolve with the NEW blob URL (so the caller can swap). Resolves
 * `null` when nothing changed, the entry is still fresh, or the fetch failed.
 */
const revalidateAvatar = (
  image: string,
  cacheKey: string,
  entry: AvatarCacheEntry,
  now: number
): Promise<string | null> => {
  if (now - entry.fetchedAt <= AVATAR_CACHE_TTL_MS) {
    return Promise.resolve(null);
  }

  const existing = inFlightRevalidations.get(cacheKey);
  if (existing) return existing;

  const revalidation = (async (): Promise<string | null> => {
    flushRetiredBlobUrls();
    try {
      const nextBlob = await fetchAvatarBlob(image);
      const current = avatarMemoryCache.get(cacheKey) ?? entry;
      if (await blobsEqual(current.blob, nextBlob)) {
        // Unchanged: just stamp it fresh so we don't refetch until the next TTL.
        current.fetchedAt = now;
        void writePersistedAvatarBlob(cacheKey, current.blob, now);
        return null;
      }
      const blobUrl = rememberAvatarBlob(cacheKey, nextBlob, now);
      void writePersistedAvatarBlob(cacheKey, nextBlob, now);
      return blobUrl;
    } catch {
      // Keep serving the cached blob; a later mount retries (still stale).
      return null;
    } finally {
      inFlightRevalidations.delete(cacheKey);
    }
  })();

  inFlightRevalidations.set(cacheKey, revalidation);
  return revalidation;
};

const maybeRevalidate = (
  image: string,
  cacheKey: string,
  entry: AvatarCacheEntry,
  onUpdate: ((blobUrl: string) => void) | undefined,
  now: number
): void => {
  void revalidateAvatar(image, cacheKey, entry, now).then((updated) => {
    if (updated != null && onUpdate) onUpdate(updated);
  });
};

/**
 * The background revalidation currently in flight for `image`, or `null` when
 * none is running (nothing cached, still fresh, or already settled). Resolves
 * with the new blob URL when the remote changed and `null` otherwise.
 *
 * Exposed so a caller can await the swap on an explicit signal instead of
 * guessing how many event-loop turns the fetch plus Blob byte comparison needs;
 * `onUpdate` callbacks are registered on this promise before any later `await`,
 * so they have already run by the time an awaiting caller resumes.
 */
export function getPendingAvatarRevalidation(image: string): Promise<string | null> | null {
  return inFlightRevalidations.get(getAvatarCacheKey(image)) ?? null;
}

export function peekAvatarBlobUrl(image?: string | null): string | null | undefined {
  if (image == null) {
    return image;
  }

  return avatarMemoryCache.get(getAvatarCacheKey(image))?.blobUrl;
}

/**
 * Resolve an avatar URL to a local blob URL, cache-first. Returns the cached
 * blob (memory → persistent) immediately when present and revalidates the
 * remote in the background; only fetches synchronously when nothing is cached.
 * `onUpdate` fires when a background revalidation finds the remote changed.
 */
export async function resolveAvatarBlobUrl(
  image?: string | null,
  options: { onUpdate?: (blobUrl: string) => void } = {},
  now = Date.now()
): Promise<string | null | undefined> {
  if (image == null) {
    return image;
  }

  const { onUpdate } = options;
  const cacheKey = getAvatarCacheKey(image);
  flushRetiredBlobUrls();

  const cached = avatarMemoryCache.get(cacheKey);
  if (cached) {
    maybeRevalidate(image, cacheKey, cached, onUpdate, now);
    return cached.blobUrl;
  }

  const pendingLoad = inFlightAvatarLoads.get(cacheKey);
  if (pendingLoad) {
    return await pendingLoad;
  }

  const loadPromise = (async () => {
    const persisted = await readPersistedAvatarEntry(cacheKey);
    if (persisted) {
      const blobUrl = rememberAvatarBlob(cacheKey, persisted.blob, persisted.fetchedAt);
      const entry = avatarMemoryCache.get(cacheKey);
      if (entry) maybeRevalidate(image, cacheKey, entry, onUpdate, now);
      return blobUrl;
    }

    // Nothing cached anywhere: this is the first paint, so fetch is on the
    // critical path. What we get back is by definition current — no revalidate.
    const blob = await fetchAvatarBlob(image);
    const blobUrl = rememberAvatarBlob(cacheKey, blob, now);
    void writePersistedAvatarBlob(cacheKey, blob, now);
    return blobUrl;
  })();

  inFlightAvatarLoads.set(cacheKey, loadPromise);

  try {
    return await loadPromise;
  } finally {
    inFlightAvatarLoads.delete(cacheKey);
  }
}

/**
 * Back-compat wrapper: resolve to a cached-or-fetched blob URL without a swap
 * callback. Prefer `resolveAvatarBlobUrl` when you want revalidation swaps.
 */
export async function getAvatarBlobUrl(
  image?: string | null,
  now = Date.now()
): Promise<string | null | undefined> {
  return resolveAvatarBlobUrl(image, {}, now);
}

/**
 * Pre-populate the in-memory blob-URL map from the persistent CacheStorage at
 * app startup. Without this, the first mount of every avatar after a page load
 * misses the memory cache and falls back to the raw URL until the async
 * CacheStorage/network read resolves — the "blank → load" flicker. With it,
 * `peekAvatarBlobUrl` returns the blob synchronously on first render.
 *
 * Best-effort: any error is swallowed since callers fall back to the raw URL
 * when the memory cache is empty.
 */
export const rehydrateAvatarMemoryCacheFromPersistent = async (): Promise<void> => {
  if (!supportsPersistentCacheStorage()) return;
  // One-time cleanup of the legacy day-bucketed bucket (orphaned by the
  // URL-only key). Best-effort; ignore failures.
  void window.caches.delete(AVATAR_IMAGE_LEGACY_CACHE_NAME);
  try {
    const cache = await window.caches.open(AVATAR_IMAGE_PERSISTENT_CACHE_NAME);
    const requests = await cache.keys();
    await Promise.all(
      requests.map(async (request) => {
        // Skip entries already in memory — a second startup pass shouldn't blow
        // away a fresh blob URL the current session created. `request.url` is
        // the same canonical key `getAvatarCacheKey` produces.
        if (avatarMemoryCache.has(request.url)) return;
        const response = await cache.match(request);
        if (!response) return;
        try {
          const blob = await response.blob();
          const header = response.headers.get(AVATAR_FETCHED_AT_HEADER);
          const fetchedAt = header != null ? Number(header) : 0;
          // Don't route through `rememberAvatarBlob`: its retire step assumes it
          // is replacing a URL from this session, but here there is none.
          avatarMemoryCache.set(request.url, {
            blobUrl: URL.createObjectURL(blob),
            blob,
            fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0,
          });
        } catch {
          // skip this entry
        }
      })
    );
  } catch {
    // ignore
  }
};

export const clearAvatarImageCache = (options: ClearAvatarCacheOptions = {}): void => {
  const { memory = true, persistent = true } = options;

  if (memory) {
    flushRetiredBlobUrls();
    for (const entry of avatarMemoryCache.values()) {
      URL.revokeObjectURL(entry.blobUrl);
    }
    avatarMemoryCache.clear();
    inFlightAvatarLoads.clear();
    inFlightRevalidations.clear();
  }

  if (persistent && supportsPersistentCacheStorage()) {
    void window.caches.delete(AVATAR_IMAGE_PERSISTENT_CACHE_NAME);
  }
};
