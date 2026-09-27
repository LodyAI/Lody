import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { getServerNow, githubFetchPRReviewComments, type GitHubReviewThread } from '@lody/shared';
import { withGitHubTokenRetry } from '@/lib/github-token';
import { useCloudQuery } from '@lody/platform/react';

type GitHubReviewCommentsStatus = 'idle' | 'loading' | 'success' | 'error';

type GitHubReviewCommentsCacheEntry = {
  repoFullName: string;
  prNumber: number;
  threads: GitHubReviewThread[];
  fetchedAt: number;
};

export type UseGitHubReviewCommentsResult = {
  threads: GitHubReviewThread[];
  status: GitHubReviewCommentsStatus;
  error: Error | null;
  fetchedAt: number | null;
  refresh: () => Promise<void>;
};

const CACHE_TTL_MS = 60_000;
const DB_NAME = 'lody:github-review-comments';
const DB_VERSION = 1;
const STORE_NAME = 'commentsByPullRequest';

const memoryCache = new Map<string, GitHubReviewCommentsCacheEntry>();

function getCacheKey(
  workspaceId: string,
  repoFullName: string,
  prNumber: number,
  repositoryId?: number
): string {
  return `gh-review-comments:${workspaceId}:${repositoryId === undefined ? repoFullName.toLowerCase() : `repository-id:${repositoryId}`}:${prNumber}`;
}

function isOnline(): boolean {
  if (typeof navigator === 'undefined') {
    return true;
  }
  return navigator.onLine;
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

async function idbGet(key: string): Promise<GitHubReviewCommentsCacheEntry | null> {
  try {
    const db = await openCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () =>
        resolve((req.result as GitHubReviewCommentsCacheEntry | undefined) ?? null);
    });
  } catch {
    return null;
  }
}

async function idbSet(key: string, value: GitHubReviewCommentsCacheEntry): Promise<void> {
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(value, key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  } catch {
    // ignore
  }
}

function isFresh(entry: GitHubReviewCommentsCacheEntry, now: number): boolean {
  return now - entry.fetchedAt <= CACHE_TTL_MS;
}

export function useGitHubReviewComments({
  sessionId,
  workspaceId,
  repoFullName,
  prNumber,
  enabled = true,
}: {
  sessionId?: string;
  workspaceId?: string | null;
  repoFullName?: string | null;
  prNumber?: number | null;
  enabled?: boolean;
}): UseGitHubReviewCommentsResult {
  const requestedRepoFullName = repoFullName?.trim() || null;
  const serverVersions = useCloudQuery(
    cloudOperations.github.getPrCacheVersions,
    enabled && workspaceId && requestedRepoFullName && prNumber
      ? {
          workspaceId,
          repoFullName: requestedRepoFullName,
          prNumber,
          ...(sessionId ? { sessionId } : {}),
        }
      : 'skip'
  );
  const normalizedRepoFullName = serverVersions?.repoFullName ?? requestedRepoFullName;
  const enabledWithInputs = Boolean(
    enabled &&
    workspaceId &&
    normalizedRepoFullName &&
    prNumber &&
    prNumber > 0 &&
    (!sessionId || serverVersions !== undefined) &&
    !serverVersions?.identityPending
  );
  const cacheKey = useMemo(
    () =>
      workspaceId && normalizedRepoFullName && prNumber
        ? getCacheKey(workspaceId, normalizedRepoFullName, prNumber, serverVersions?.repositoryId)
        : null,
    [workspaceId, normalizedRepoFullName, prNumber, serverVersions?.repositoryId]
  );

  const [threads, setThreads] = useState<GitHubReviewThread[]>([]);
  const [status, setStatus] = useState<GitHubReviewCommentsStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const requestSeqRef = useRef(0);

  const applyCacheEntry = useCallback((entry: GitHubReviewCommentsCacheEntry) => {
    setThreads(entry.threads);
    setFetchedAt(entry.fetchedAt);
    setStatus('success');
    setError(null);
  }, []);

  const load = useCallback(
    async (options?: { force?: boolean; silent?: boolean }) => {
      if (!enabledWithInputs || !workspaceId || !normalizedRepoFullName || !prNumber || !cacheKey) {
        setThreads([]);
        setFetchedAt(null);
        setStatus('idle');
        setError(null);
        return;
      }

      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      const force = options?.force ?? false;
      const silent = options?.silent ?? false;
      const now = getServerNow();
      const cached = memoryCache.get(cacheKey) ?? (await idbGet(cacheKey));
      if (requestSeqRef.current !== seq) return;

      if (cached) {
        memoryCache.set(cacheKey, cached);
        applyCacheEntry(cached);
        if (!force && isFresh(cached, now)) {
          return;
        }
      } else if (!silent) {
        setStatus('loading');
        setError(null);
      }

      if (!isOnline()) {
        if (!cached && requestSeqRef.current === seq) {
          setStatus('error');
          setError(new Error('GitHub comments are unavailable while offline'));
        }
        return;
      }

      try {
        const nextThreads = await withGitHubTokenRetry(
          workspaceId,
          normalizedRepoFullName,
          (token) => githubFetchPRReviewComments(token, normalizedRepoFullName, prNumber),
          serverVersions?.repositoryId
        );
        if (requestSeqRef.current !== seq) {
          return;
        }
        const entry: GitHubReviewCommentsCacheEntry = {
          repoFullName: normalizedRepoFullName,
          prNumber,
          threads: nextThreads,
          fetchedAt: getServerNow(),
        };
        memoryCache.set(cacheKey, entry);
        void idbSet(cacheKey, entry);
        applyCacheEntry(entry);
      } catch (err) {
        if (requestSeqRef.current !== seq) {
          return;
        }
        setStatus(cached ? 'success' : 'error');
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [
      applyCacheEntry,
      cacheKey,
      enabledWithInputs,
      normalizedRepoFullName,
      prNumber,
      workspaceId,
      serverVersions?.repositoryId,
    ]
  );

  useEffect(() => {
    setThreads([]);
    setFetchedAt(null);
    void load();
    return () => {
      requestSeqRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!enabledWithInputs || !serverVersions) {
      return;
    }
    const serverUpdatedAt = serverVersions.reviewCommentsUpdatedAt ?? null;
    if (serverUpdatedAt == null) {
      return;
    }
    if (fetchedAt != null && serverUpdatedAt <= fetchedAt) {
      return;
    }
    void load({ force: true, silent: true });
  }, [enabledWithInputs, fetchedAt, load, serverVersions]);

  useEffect(() => {
    if (!enabledWithInputs) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      void load({ force: true, silent: true });
    }, CACHE_TTL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabledWithInputs, load]);

  const refresh = useCallback(async () => {
    await load({ force: true });
  }, [load]);

  return { threads, status, error, fetchedAt, refresh };
}
