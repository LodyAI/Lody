export const AVATAR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const AVATAR_IMAGE_IDB_NAME = 'lody:avatar-image-cache';
export const AVATAR_CACHE_INDEX_KEY = 'lody:avatar-cache-index';

const AVATAR_IDB_STORE_NAME = 'avatars';
const AVATAR_IDB_VERSION = 1;
const MAX_PERSISTED_AVATARS = 256;
const AVATAR_IMAGE_PERSISTENT_CACHE_NAME = 'lody-avatar-image-v2';
const AVATAR_IMAGE_LEGACY_CACHE_NAME = 'lody-avatar-image-v1';
const AVATAR_FETCHED_AT_HEADER = 'x-lody-avatar-fetched-at';
const SYNTHETIC_CACHE_ORIGIN = 'https://avatar-cache.lody.invalid';

type ClearAvatarCacheOptions = {
  memory?: boolean;
  persistent?: boolean;
};

export type AvatarResolveSource = 'memory' | 'persistent' | 'network';

export type ResolvedAvatarEntry = {
  blobUrl: string;
  source: AvatarResolveSource;
};

type AvatarCacheEntry = {
  blobUrl: string;
  blob: Blob;
  fetchedAt: number;
  image?: HTMLImageElement;
};

type PersistedAvatarRecord = {
  key: string;
  blob: Blob;
  fetchedAt: number;
  updatedAt: number;
};

const avatarMemoryCache = new Map<string, AvatarCacheEntry>();
const inFlightAvatarLoads = new Map<string, Promise<ResolvedAvatarEntry>>();
const inFlightRevalidations = new Map<string, Promise<string | null>>();
const retiredBlobUrls: string[] = [];

let avatarDbPromise: Promise<IDBDatabase | null> | null = null;
let rehydratePromise: Promise<void> | null = null;
let persistedIndexCache: { raw: string | null; set: Set<string> } | null = null;

const normalizeAvatarKey = (image?: string | null): string | null => {
  const trimmed = image?.trim();
  return trimmed ? trimmed : null;
};

const isDirectInlineAvatarUrl = (key: string): boolean =>
  key.startsWith('blob:') || key.startsWith('data:');

const supportsAvatarIndexedDb = (): boolean =>
  typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function';

const supportsPersistentCacheStorage = (): boolean =>
  typeof window !== 'undefined' && typeof window.caches !== 'undefined';

function getBrowserLocalStorage(): Storage | null {
  if (typeof window === 'undefined' || !('localStorage' in window)) return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readPersistedIndexSet(): Set<string> {
  const storage = getBrowserLocalStorage();
  if (!storage) {
    return persistedIndexCache?.set ?? new Set();
  }
  try {
    const raw = storage.getItem(AVATAR_CACHE_INDEX_KEY);
    if (persistedIndexCache && persistedIndexCache.raw === raw) {
      return persistedIndexCache.set;
    }
    if (!raw) {
      const empty = new Set<string>();
      persistedIndexCache = { raw: null, set: empty };
      return empty;
    }
    const parsed: unknown = JSON.parse(raw);
    const items = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    const set = new Set(items);
    persistedIndexCache = { raw, set };
    return set;
  } catch {
    return persistedIndexCache?.set ?? new Set();
  }
}

function writePersistedIndexSet(set: Set<string>): void {
  const storage = getBrowserLocalStorage();
  if (!storage) {
    persistedIndexCache = { raw: null, set };
    return;
  }
  try {
    while (set.size > MAX_PERSISTED_AVATARS) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
    if (set.size === 0) {
      storage.removeItem(AVATAR_CACHE_INDEX_KEY);
      persistedIndexCache = { raw: null, set };
      return;
    }
    const raw = JSON.stringify([...set]);
    storage.setItem(AVATAR_CACHE_INDEX_KEY, raw);
    persistedIndexCache = { raw, set };
  } catch {
    persistedIndexCache = { raw: null, set };
  }
}

function addPersistedIndexKey(key: string): void {
  const current = new Set(readPersistedIndexSet());
  current.delete(key);
  current.add(key);
  writePersistedIndexSet(current);
}

function removePersistedIndexKey(key: string): void {
  const current = readPersistedIndexSet();
  if (!current.has(key)) return;
  const next = new Set(current);
  next.delete(key);
  writePersistedIndexSet(next);
}

export function hasPersistedAvatar(image?: string | null): boolean {
  const key = normalizeAvatarKey(image);
  if (!key || isDirectInlineAvatarUrl(key)) return false;
  return readPersistedIndexSet().has(key);
}

const flushRetiredBlobUrls = (): void => {
  while (retiredBlobUrls.length > 0) {
    const url = retiredBlobUrls.pop();
    if (url) URL.revokeObjectURL(url);
  }
};

const getSyntheticCacheStorageUrl = (key: string): string =>
  `${SYNTHETIC_CACHE_ORIGIN}/__lody/avatar-cache?src=${encodeURIComponent(key)}`;

const getLegacyOriginCacheStorageUrl = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  const origin = window.location?.origin;
  if (
    typeof origin !== 'string' ||
    (!origin.startsWith('https://') && !origin.startsWith('http://'))
  ) {
    return null;
  }
  try {
    const url = new URL('/__lody/avatar-cache', origin);
    url.searchParams.set('src', key);
    return url.toString();
  } catch {
    return null;
  }
};

const extractKeyFromCacheStorageUrl = (requestUrl: string): string | null => {
  try {
    const parsed = new URL(requestUrl);
    const src = parsed.searchParams.get('src')?.trim();
    return src ? src : null;
  } catch {
    return null;
  }
};

function openAvatarDb(): Promise<IDBDatabase | null> {
  if (!supportsAvatarIndexedDb()) return Promise.resolve(null);
  if (avatarDbPromise) return avatarDbPromise;

  avatarDbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const request = indexedDB.open(AVATAR_IMAGE_IDB_NAME, AVATAR_IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(AVATAR_IDB_STORE_NAME)) {
          db.createObjectStore(AVATAR_IDB_STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          avatarDbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        avatarDbPromise = null;
        resolve(null);
      };
      request.onblocked = () => {
        avatarDbPromise = null;
        resolve(null);
      };
    } catch {
      avatarDbPromise = null;
      resolve(null);
    }
  });
  return avatarDbPromise;
}

async function readIdbAvatarEntry(key: string): Promise<{ blob: Blob; fetchedAt: number } | null> {
  const db = await openAvatarDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(AVATAR_IDB_STORE_NAME, 'readonly');
      const req = tx.objectStore(AVATAR_IDB_STORE_NAME).get(key);
      req.onsuccess = () => {
        const record = req.result as PersistedAvatarRecord | undefined;
        if (!record || !(record.blob instanceof Blob)) {
          resolve(null);
          return;
        }
        resolve({
          blob: record.blob,
          fetchedAt: Number.isFinite(record.fetchedAt) ? record.fetchedAt : 0,
        });
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readAllIdbAvatarEntries(): Promise<PersistedAvatarRecord[]> {
  const db = await openAvatarDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(AVATAR_IDB_STORE_NAME, 'readonly');
      const req = tx.objectStore(AVATAR_IDB_STORE_NAME).getAll();
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? (req.result as PersistedAvatarRecord[]) : [];
        resolve(rows.filter((row) => typeof row?.key === 'string' && row.blob instanceof Blob));
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function writeIdbAvatarBlob(key: string, blob: Blob, fetchedAt: number): Promise<boolean> {
  const db = await openAvatarDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(AVATAR_IDB_STORE_NAME, 'readwrite');
      const store = tx.objectStore(AVATAR_IDB_STORE_NAME);
      store.put({
        key,
        blob,
        fetchedAt,
        updatedAt: Date.now(),
      } satisfies PersistedAvatarRecord);
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const rows = Array.isArray(allReq.result) ? (allReq.result as PersistedAvatarRecord[]) : [];
        if (rows.length <= MAX_PERSISTED_AVATARS) return;
        rows.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
        const overflow = rows.length - MAX_PERSISTED_AVATARS;
        for (let index = 0; index < overflow; index += 1) {
          const victim = rows[index];
          if (victim?.key && victim.key !== key) {
            store.delete(victim.key);
            removePersistedIndexKey(victim.key);
          }
        }
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function readCacheStorageAvatarEntry(
  key: string
): Promise<{ blob: Blob; fetchedAt: number } | null> {
  if (!supportsPersistentCacheStorage()) return null;
  try {
    const cache = await window.caches.open(AVATAR_IMAGE_PERSISTENT_CACHE_NAME);
    const syntheticUrl = getSyntheticCacheStorageUrl(key);
    let response = await cache.match(syntheticUrl);
    if (!response) {
      const legacyUrl = getLegacyOriginCacheStorageUrl(key);
      if (legacyUrl) {
        response = await cache.match(legacyUrl);
      }
    }
    if (!response) return null;
    const blob = await response.blob();
    const header = response.headers.get(AVATAR_FETCHED_AT_HEADER);
    const fetchedAt = header != null ? Number(header) : 0;
    return { blob, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 };
  } catch {
    return null;
  }
}

async function writeCacheStorageAvatarBlob(
  key: string,
  blob: Blob,
  fetchedAt: number
): Promise<boolean> {
  if (!supportsPersistentCacheStorage()) return false;
  try {
    const cache = await window.caches.open(AVATAR_IMAGE_PERSISTENT_CACHE_NAME);
    await cache.put(
      getSyntheticCacheStorageUrl(key),
      new Response(blob, {
        status: 200,
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000, immutable',
          [AVATAR_FETCHED_AT_HEADER]: String(fetchedAt),
        },
      })
    );
    return true;
  } catch {
    return false;
  }
}

const readPersistedAvatarEntry = async (
  key: string
): Promise<{ blob: Blob; fetchedAt: number } | null> => {
  const fromIdb = await readIdbAvatarEntry(key);
  if (fromIdb) {
    addPersistedIndexKey(key);
    return fromIdb;
  }
  const fromCacheStorage = await readCacheStorageAvatarEntry(key);
  if (fromCacheStorage) {
    addPersistedIndexKey(key);
    void writeIdbAvatarBlob(key, fromCacheStorage.blob, fromCacheStorage.fetchedAt);
    return fromCacheStorage;
  }
  removePersistedIndexKey(key);
  return null;
};

const writePersistedAvatarBlob = async (
  key: string,
  blob: Blob,
  fetchedAt: number
): Promise<void> => {
  const wroteIdb = await writeIdbAvatarBlob(key, blob, fetchedAt);
  const wroteCache = wroteIdb ? false : await writeCacheStorageAvatarBlob(key, blob, fetchedAt);
  if (wroteIdb || wroteCache) {
    addPersistedIndexKey(key);
  }
};

const preloadAvatarImage = (blobUrl: string): HTMLImageElement | undefined => {
  if (typeof window === 'undefined' || typeof window.Image !== 'function') return undefined;

  const image = new window.Image();
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.src = blobUrl;
  if (typeof image.decode === 'function') void image.decode().catch(() => {});
  return image;
};

const rememberAvatarBlob = (key: string, blob: Blob, fetchedAt: number, warm = false): string => {
  const previous = avatarMemoryCache.get(key);
  if (previous) {
    retiredBlobUrls.push(previous.blobUrl);
  }

  const blobUrl = URL.createObjectURL(blob);
  avatarMemoryCache.set(key, {
    blobUrl,
    blob,
    fetchedAt,
    image: warm || previous?.image ? preloadAvatarImage(blobUrl) : undefined,
  });
  return blobUrl;
};

const fetchAvatarBlob = async (image: string): Promise<Blob> => {
  const response = await fetch(image, {
    credentials: 'omit',
    mode: 'cors',
    referrerPolicy: 'no-referrer',
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

const revalidateAvatar = (
  key: string,
  entry: AvatarCacheEntry,
  now: number
): Promise<string | null> => {
  if (now - entry.fetchedAt <= AVATAR_CACHE_TTL_MS) {
    return Promise.resolve(null);
  }

  const existing = inFlightRevalidations.get(key);
  if (existing) return existing;

  const revalidation = (async (): Promise<string | null> => {
    flushRetiredBlobUrls();
    try {
      const nextBlob = await fetchAvatarBlob(key);
      const current = avatarMemoryCache.get(key) ?? entry;
      if (await blobsEqual(current.blob, nextBlob)) {
        current.fetchedAt = now;
        void writePersistedAvatarBlob(key, current.blob, now);
        return null;
      }
      const blobUrl = rememberAvatarBlob(key, nextBlob, now, Boolean(current.image));
      void writePersistedAvatarBlob(key, nextBlob, now);
      return blobUrl;
    } catch {
      return null;
    } finally {
      inFlightRevalidations.delete(key);
    }
  })();

  inFlightRevalidations.set(key, revalidation);
  return revalidation;
};

const maybeRevalidate = (
  key: string,
  entry: AvatarCacheEntry,
  onUpdate: ((blobUrl: string) => void) | undefined,
  now: number
): void => {
  void revalidateAvatar(key, entry, now).then((updated) => {
    if (updated != null && onUpdate) onUpdate(updated);
  });
};

export function getPendingAvatarRevalidation(image: string): Promise<string | null> | null {
  const key = normalizeAvatarKey(image);
  return key ? (inFlightRevalidations.get(key) ?? null) : null;
}

export function peekAvatarBlobUrl(image?: string | null): string | null | undefined {
  if (image == null) return image;
  const key = normalizeAvatarKey(image);
  if (!key) return undefined;
  if (isDirectInlineAvatarUrl(key)) return key;
  return avatarMemoryCache.get(key)?.blobUrl;
}

export function preloadAvatarBlobUrl(image?: string | null): void {
  const key = normalizeAvatarKey(image);
  if (!key || isDirectInlineAvatarUrl(key)) return;
  const entry = avatarMemoryCache.get(key);
  if (entry && !entry.image) entry.image = preloadAvatarImage(entry.blobUrl);
}

export async function resolveAvatarEntry(
  image?: string | null,
  options: { onUpdate?: (blobUrl: string) => void } = {},
  now = Date.now()
): Promise<ResolvedAvatarEntry | null | undefined> {
  if (image == null) return image;
  const key = normalizeAvatarKey(image);
  if (!key) return undefined;
  if (isDirectInlineAvatarUrl(key)) {
    return { blobUrl: key, source: 'memory' };
  }

  const { onUpdate } = options;
  flushRetiredBlobUrls();

  const cached = avatarMemoryCache.get(key);
  if (cached) {
    maybeRevalidate(key, cached, onUpdate, now);
    return { blobUrl: cached.blobUrl, source: 'memory' };
  }

  const pendingLoad = inFlightAvatarLoads.get(key);
  if (pendingLoad) {
    return await pendingLoad;
  }

  const loadPromise = (async (): Promise<ResolvedAvatarEntry> => {
    const persisted = await readPersistedAvatarEntry(key);
    if (persisted) {
      const existing = avatarMemoryCache.get(key);
      const blobUrl = existing
        ? existing.blobUrl
        : rememberAvatarBlob(key, persisted.blob, persisted.fetchedAt);
      const entry = avatarMemoryCache.get(key);
      if (entry) maybeRevalidate(key, entry, onUpdate, now);
      return { blobUrl, source: 'persistent' };
    }

    const blob = await fetchAvatarBlob(key);
    const blobUrl = rememberAvatarBlob(key, blob, now);
    void writePersistedAvatarBlob(key, blob, now);
    return { blobUrl, source: 'network' };
  })();

  inFlightAvatarLoads.set(key, loadPromise);

  try {
    return await loadPromise;
  } finally {
    inFlightAvatarLoads.delete(key);
  }
}

export async function resolveAvatarBlobUrl(
  image?: string | null,
  options: { onUpdate?: (blobUrl: string) => void } = {},
  now = Date.now()
): Promise<string | null | undefined> {
  const resolved = await resolveAvatarEntry(image, options, now);
  if (resolved == null) return resolved;
  return resolved.blobUrl;
}

export async function getAvatarBlobUrl(
  image?: string | null,
  now = Date.now()
): Promise<string | null | undefined> {
  return resolveAvatarBlobUrl(image, {}, now);
}

export const rehydrateAvatarMemoryCacheFromPersistent = (): Promise<void> => {
  if (rehydratePromise) return rehydratePromise;

  rehydratePromise = (async () => {
    if (supportsPersistentCacheStorage()) {
      void window.caches.delete(AVATAR_IMAGE_LEGACY_CACHE_NAME);
    }

    const hydratedKeys: string[] = [];

    const idbRows = await readAllIdbAvatarEntries();
    for (const row of idbRows) {
      hydratedKeys.push(row.key);
      if (avatarMemoryCache.has(row.key)) continue;
      avatarMemoryCache.set(row.key, {
        blobUrl: URL.createObjectURL(row.blob),
        blob: row.blob,
        fetchedAt: Number.isFinite(row.fetchedAt) ? row.fetchedAt : 0,
      });
    }

    if (supportsPersistentCacheStorage()) {
      try {
        const cache = await window.caches.open(AVATAR_IMAGE_PERSISTENT_CACHE_NAME);
        const requests = await cache.keys();
        await Promise.all(
          requests.map(async (request) => {
            const key = extractKeyFromCacheStorageUrl(request.url);
            if (!key) return;
            hydratedKeys.push(key);
            if (avatarMemoryCache.has(key)) return;
            const response = await cache.match(request);
            if (!response) return;
            try {
              const blob = await response.blob();
              const header = response.headers.get(AVATAR_FETCHED_AT_HEADER);
              const fetchedAt = header != null ? Number(header) : 0;
              const normalizedFetchedAt = Number.isFinite(fetchedAt) ? fetchedAt : 0;
              avatarMemoryCache.set(key, {
                blobUrl: URL.createObjectURL(blob),
                blob,
                fetchedAt: normalizedFetchedAt,
              });
              void writeIdbAvatarBlob(key, blob, normalizedFetchedAt);
            } catch {
              // skip unreadable entry
            }
          })
        );
      } catch {
        // ignore CacheStorage errors
      }
    }

    if (hydratedKeys.length > 0) {
      const merged = new Set(readPersistedIndexSet());
      for (const key of hydratedKeys) merged.add(key);
      writePersistedIndexSet(merged);
    }
  })().finally(() => {
    rehydratePromise = null;
  });

  return rehydratePromise;
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

  if (persistent) {
    writePersistedIndexSet(new Set());
    if (avatarDbPromise) {
      const closing = avatarDbPromise;
      avatarDbPromise = null;
      void closing.then((db) => db?.close());
    }
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.deleteDatabase === 'function') {
      try {
        indexedDB.deleteDatabase(AVATAR_IMAGE_IDB_NAME);
      } catch {
        // ignore
      }
    }
    if (supportsPersistentCacheStorage()) {
      void window.caches.delete(AVATAR_IMAGE_PERSISTENT_CACHE_NAME);
    }
  }
};
