import { z } from 'zod';
import { githubFetchFilePaths } from '@lody/shared';
import { withGitHubTokenRetry } from './github-token';

export type RepoFilePathsResult = {
  repoFullName: string;
  defaultBranch: string;
  headSha: string;
  paths: string[];
  truncated: boolean;
};

export type RepoFilePathsCacheEntry = RepoFilePathsResult & {
  fetchedAt: number;
};

const RepoFilePathsResultSchema = z.object({
  repoFullName: z.string(),
  defaultBranch: z.string(),
  headSha: z.string(),
  paths: z.array(z.string()),
  truncated: z.boolean(),
});

/**
 * A recursive git tree is large (1.7MB of JSON for this repository) and is
 * parsed on the main thread, so every consumer — @-mention search and the
 * GitHub file browser — shares one cache: memory, then IndexedDB, then one
 * in-flight request per key.
 */
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h

const memoryCache = new Map<string, RepoFilePathsCacheEntry>();
const inFlight = new Map<string, Promise<RepoFilePathsCacheEntry>>();

const DB_NAME = 'lody:repo-file-paths';
const DB_VERSION = 1;
const STORE_NAME = 'pathsByRepo';

/** No branch means the repository's default branch (the key format predates branches). */
export function getRepoFilePathsCacheKey(
  workspaceId: string,
  repoFullName: string,
  branch?: string
): string {
  const base = `${workspaceId}:${repoFullName}`;
  return branch ? `${base}@${branch}` : base;
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function idbGet(key: string): Promise<RepoFilePathsCacheEntry | null> {
  try {
    const db = await openCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve((req.result as RepoFilePathsCacheEntry | undefined) ?? null);
    });
  } catch {
    return null;
  }
}

async function idbSet(key: string, value: RepoFilePathsCacheEntry): Promise<void> {
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(value, key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  } catch {
    // The memory cache still serves this page; persistence is best effort.
  }
}

export function isRepoFilePathsStale(entry: RepoFilePathsCacheEntry, now: number): boolean {
  return now - entry.fetchedAt > CACHE_TTL_MS;
}

/** The newest cached entry for `key` (memory, then IndexedDB), fresh or stale. */
export async function readCachedRepoFilePaths(
  key: string
): Promise<RepoFilePathsCacheEntry | null> {
  const memory = memoryCache.get(key);
  if (memory) return memory;
  const persisted = await idbGet(key);
  if (persisted && !memoryCache.has(key)) memoryCache.set(key, persisted);
  return memoryCache.get(key) ?? persisted;
}

/** Fetches the tree now; concurrent callers for the same key share one request. */
export function fetchRepoFilePaths(
  workspaceId: string,
  repoFullName: string,
  branch?: string
): Promise<RepoFilePathsCacheEntry> {
  const key = getRepoFilePathsCacheKey(workspaceId, repoFullName, branch);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = withGitHubTokenRetry(workspaceId, repoFullName, (token) =>
    githubFetchFilePaths(token, repoFullName, branch)
  )
    .then((result) => {
      const parsed = RepoFilePathsResultSchema.parse({ repoFullName, ...result });
      const entry: RepoFilePathsCacheEntry = { ...parsed, fetchedAt: Date.now() };
      memoryCache.set(key, entry);
      void idbSet(key, entry);
      return entry;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** A fresh entry from the cache, or one fetched (and shared) when there is none. */
export async function loadRepoFilePaths(
  workspaceId: string,
  repoFullName: string,
  branch?: string
): Promise<RepoFilePathsCacheEntry> {
  const key = getRepoFilePathsCacheKey(workspaceId, repoFullName, branch);
  const cached = await readCachedRepoFilePaths(key);
  if (cached && !isRepoFilePathsStale(cached, Date.now())) return cached;
  return fetchRepoFilePaths(workspaceId, repoFullName, branch);
}

/** Test seam: forget every cached and pending entry. */
export function clearRepoFilePathsMemoryCache(): void {
  memoryCache.clear();
  inFlight.clear();
}
