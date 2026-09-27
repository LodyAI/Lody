import {
  normalizeCheckRunsSummary,
  type GitHubCheckRunsSummary,
  type GitHubIssueComment,
  type GitHubPullRequestDetails,
  type GitHubReview,
  type GitHubReviewThread,
} from '@lody/shared';

/**
 * Client-side IndexedDB cache for PR Tab data. Keyed by
 * `${workspaceId}:${repoFullNameLower}:#${prNumber}` so a PR that two
 * workspaces both have linked gets one entry per workspace.
 */

export interface PrCacheSliceTimestamps {
  prDetailsFetchedAt: number | null;
  reviewCommentsFetchedAt: number | null;
  reviewsFetchedAt: number | null;
  issueCommentsFetchedAt: number | null;
  checkRunsFetchedAt: number | null;
}

export interface PrCachePayload {
  pullRequest: GitHubPullRequestDetails | null;
  reviewThreads: GitHubReviewThread[];
  reviews: GitHubReview[];
  issueComments: GitHubIssueComment[];
  checkRuns: GitHubCheckRunsSummary;
  checksPermissionError: boolean;
}

export interface PrCacheEntry {
  repositoryId?: number;
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  payload: PrCachePayload;
  versions: PrCacheSliceTimestamps;
  /** Overall row write time; used only for diagnostics. */
  lastWriteAt: number;
}

const DB_NAME = 'lody:github-pr-cache';
const DB_VERSION = 1;
const STORE_NAME = 'prDataByKey';

const memoryCache = new Map<string, PrCacheEntry>();

export function getPrCacheKey(
  workspaceId: string,
  repoFullName: string,
  prNumber: number,
  repositoryId?: number
): string {
  return `${workspaceId}:${repositoryId === undefined ? repoFullName.toLowerCase() : `repository-id:${repositoryId}`}:#${prNumber}`;
}

function openDb(): Promise<IDBDatabase> {
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

export async function readPrCacheEntry(
  workspaceId: string,
  repoFullName: string,
  prNumber: number,
  repositoryId?: number
): Promise<PrCacheEntry | null> {
  const key = getPrCacheKey(workspaceId, repoFullName, prNumber, repositoryId);
  const cached = memoryCache.get(key);
  if (cached) return cached;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const stored = (req.result as PrCacheEntry | undefined) ?? null;
        // Entries written by older builds may keep superseded check attempts.
        const result = stored && {
          ...stored,
          payload: {
            ...stored.payload,
            checkRuns: normalizeCheckRunsSummary(stored.payload.checkRuns),
          },
        };
        if (result) memoryCache.set(key, result);
        resolve(result);
      };
    });
  } catch {
    return null;
  }
}

export async function writePrCacheEntry(entry: PrCacheEntry): Promise<void> {
  const key = getPrCacheKey(
    entry.workspaceId,
    entry.repoFullName,
    entry.prNumber,
    entry.repositoryId
  );
  memoryCache.set(key, entry);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(entry, key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  } catch {
    // ignore — memory cache still helps within the session
  }
}

export async function deletePrCacheEntry(
  workspaceId: string,
  repoFullName: string,
  prNumber: number
): Promise<void> {
  const key = getPrCacheKey(workspaceId, repoFullName, prNumber);
  memoryCache.delete(key);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  } catch {
    // ignore
  }
}

/**
 * Called by the session deletion flow to tidy up every PR the session ever
 * referenced. Safe to invoke with an empty list.
 */
export async function deletePrCacheEntriesForSession(options: {
  workspaceId: string;
  prs: { repository?: string; number?: number | null }[];
  defaultRepoFullName?: string;
}): Promise<void> {
  const { workspaceId, prs, defaultRepoFullName } = options;
  await Promise.all(
    prs.map((pr) => {
      const repo = pr.repository || defaultRepoFullName;
      if (!repo || typeof pr.number !== 'number' || !Number.isFinite(pr.number)) {
        return Promise.resolve();
      }
      return deletePrCacheEntry(workspaceId, repo, pr.number);
    })
  );
}

export const EMPTY_PR_CACHE_VERSIONS: PrCacheSliceTimestamps = {
  prDetailsFetchedAt: null,
  reviewCommentsFetchedAt: null,
  reviewsFetchedAt: null,
  issueCommentsFetchedAt: null,
  checkRunsFetchedAt: null,
};
