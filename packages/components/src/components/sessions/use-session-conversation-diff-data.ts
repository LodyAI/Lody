import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeCollabAllChangesScope, FileDiff, SessionId } from '@lody/shared';
import { isFilteredDiffFile } from '@lody/shared';
import {
  describeSessionDiffSnapshot,
  getSessionDiffErrorMessage,
} from '@/lib/session-diff-diagnostics';
import {
  getDiffPerfNow,
  logDiffPerf,
  logDiffPerfDuration,
  logDiffPerfDurationLazy,
  logDiffPerfLazy,
} from '@/lib/diff-perf';
import {
  arePathsEquivalent,
  normalizePathForMatch,
  type FileDiffData,
} from './session-conversation-diff-types';
import type { SessionFileProvider } from '@/lib/session-file-provider';
import { sessionFileProviderDiffResultToFileDiffData } from '@/lib/session-file-provider-diff';

const MAX_CACHE_ENTRIES = 8;
const MAX_ERROR_RETRIES = 2;
const RETRY_DELAY_MS = 800;
const MAX_CONCURRENT_DIFF_LOADS = 4;
const MAX_PENDING_DIFF_LOADS_PER_EFFECT = 4;
const SMALL_DIFF_LOAD_ALL_FILE_COUNT = 16;
const SMALL_DIFF_MAX_CONCURRENT_DIFF_LOADS = 4;
const SMALL_DIFF_MAX_PENDING_DIFF_LOADS_PER_EFFECT = 4;
const DIFF_LOAD_START_DELAY_MS = 1200;
const DIFF_LOAD_IDLE_TIMEOUT_MS = 1000;
const resolvedDiffCache = new Map<string, Record<string, FileDiffData>>();
const EMPTY_RESOLVED_DIFFS: Record<string, FileDiffData> = {};

export function getDiffDataLoadScheduling(targetLoadCount: number): {
  maxConcurrentLoads: number;
  maxPendingLoadsPerEffect: number;
  delayNonPriorityLoads: boolean;
} {
  if (targetLoadCount > 0 && targetLoadCount <= SMALL_DIFF_LOAD_ALL_FILE_COUNT) {
    return {
      maxConcurrentLoads: SMALL_DIFF_MAX_CONCURRENT_DIFF_LOADS,
      maxPendingLoadsPerEffect: SMALL_DIFF_MAX_PENDING_DIFF_LOADS_PER_EFFECT,
      delayNonPriorityLoads: false,
    };
  }

  return {
    maxConcurrentLoads: MAX_CONCURRENT_DIFF_LOADS,
    maxPendingLoadsPerEffect: MAX_PENDING_DIFF_LOADS_PER_EFFECT,
    delayNonPriorityLoads: true,
  };
}

// Loading must wait for the session-history fileDiff summary to hydrate. Firing
// getDiff before the checkpoints arrive misreports "missing checkpoint" for data
// that is merely in flight, and that error then sits in resolved state until the
// next cache-key change. Rejected: treating `fileDiffs === undefined` as the
// pending signal — callers that legitimately have no checkpoints pass undefined.
export function shouldStartSessionDiffLoads(input: {
  readonly useProviderDiff: boolean;
  readonly waitForProviderDiff: boolean;
  readonly loadPaused: boolean;
  readonly fileDiffsPending: boolean;
  readonly normalizedPathCount: number;
  readonly mode: SessionConversationDiffMode;
  readonly turnId?: string | undefined;
}): boolean {
  if (!input.useProviderDiff || input.waitForProviderDiff) {
    return false;
  }
  if (input.loadPaused || (input.mode === 'conversation' && input.fileDiffsPending)) {
    return false;
  }
  if (input.normalizedPathCount === 0) {
    return false;
  }
  return !(input.mode === 'conversation' && !input.turnId);
}

export function shouldRetrySessionProviderDiffErrorMessage(message: string): boolean {
  return /\b(timeout|timed out|sync failed|connect request|not ready|network|fetch failed|failed to fetch|transient)\b/iu.test(
    message
  );
}

const isReadyFileDiffData = (
  data: FileDiffData
): data is Extract<FileDiffData, { status: 'ready' | 'ready-parsed' | 'ready-text-source' }> =>
  data.status === 'ready' || data.status === 'ready-parsed' || data.status === 'ready-text-source';

export const isCacheableResolvedFileDiffData = (
  data: FileDiffData
): data is Extract<FileDiffData, { status: 'ready' | 'ready-parsed' }> =>
  data.status === 'ready' || data.status === 'ready-parsed';

const waitForDiffLoadSlot = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, DIFF_LOAD_START_DELAY_MS);
  });

  await new Promise<void>((resolve) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: DIFF_LOAD_IDLE_TIMEOUT_MS });
      return;
    }

    window.setTimeout(resolve, 0);
  });
};

const readCachedResolvedData = (
  cacheKey: string | null,
  normalizedPaths: string[]
): Record<string, FileDiffData> => {
  if (!cacheKey) {
    return {};
  }

  const cached = resolvedDiffCache.get(cacheKey);
  if (!cached) {
    return {};
  }

  const next: Record<string, FileDiffData> = {};
  for (const filePath of normalizedPaths) {
    const data = cached[filePath];
    if (data && isCacheableResolvedFileDiffData(data)) {
      next[filePath] = data;
    }
  }
  return next;
};

const writeCachedResolvedData = (
  cacheKey: string | null,
  resolvedByPath: Record<string, FileDiffData>
): void => {
  if (!cacheKey) {
    return;
  }

  const readyOnly: Record<string, FileDiffData> = {};
  for (const [filePath, data] of Object.entries(resolvedByPath)) {
    if (isCacheableResolvedFileDiffData(data)) {
      readyOnly[filePath] = data;
    }
  }

  if (Object.keys(readyOnly).length === 0) {
    resolvedDiffCache.delete(cacheKey);
    return;
  }

  resolvedDiffCache.set(cacheKey, readyOnly);
  if (resolvedDiffCache.size <= MAX_CACHE_ENTRIES) {
    return;
  }

  const oldestKey = resolvedDiffCache.keys().next().value;
  if (oldestKey) {
    resolvedDiffCache.delete(oldestKey);
  }
};

export type SessionConversationDiffMode = 'conversation' | 'base';

export const useSessionConversationDiffData = ({
  sessionId,
  turnId,
  filePaths,
  mode = 'conversation',
  priorityFilePath,
  loadFilePaths,
  loadPaused = false,
  fileProvider,
  fileProviderPending = false,
  fileDiffs,
  fileDiffsPending = false,
  enabled = true,
  requestScope,
  allChangesScope,
}: {
  sessionId: SessionId;
  turnId?: string;
  filePaths: string[];
  mode?: SessionConversationDiffMode;
  priorityFilePath?: string | null;
  loadFilePaths?: string[];
  loadPaused?: boolean;
  fileProvider?: SessionFileProvider | null;
  fileProviderPending?: boolean;
  fileDiffs?: readonly FileDiff[];
  fileDiffsPending?: boolean;
  // When false the per-file loader is inert (no RPC). Used so the panel can hand "All Changes"
  // (base) mode off to the batched useSessionAllChangesDiffData without this hook also fanning out.
  enabled?: boolean;
  /** Identifies an authoritative live batch, even when its path set is unchanged. */
  requestScope?: object;
  /** All Changes comparison scope; only used when `mode` is `base`. */
  allChangesScope?: CodeCollabAllChangesScope;
}): {
  cacheKey: string | null;
  normalizedPaths: string[];
  resolvedByPath: Record<string, FileDiffData>;
  hasAllResolved: boolean;
  isDiffUnavailable: boolean;
  isPanelLoading: boolean;
} => {
  const useProviderDiff = Boolean(fileProvider);
  const waitForProviderDiff = fileProviderPending && !fileProvider;
  const retryAttemptsRef = useRef(new Map<string, number>());
  const retryTimeoutsRef = useRef(new Map<string, number>());
  const inFlightPathsRef = useRef(new Set<string>());

  const normalizedPaths = useMemo(() => {
    return Array.from(new Set(filePaths.filter(Boolean))).toSorted((a, b) => a.localeCompare(b));
  }, [filePaths]);
  const normalizedPathsKey = useMemo(() => JSON.stringify(normalizedPaths), [normalizedPaths]);

  const targetLoadPaths = useMemo(() => {
    if (!loadFilePaths) {
      return normalizedPaths;
    }

    const requestedPaths = loadFilePaths.filter(Boolean);
    if (priorityFilePath) {
      requestedPaths.push(priorityFilePath);
    }
    if (requestedPaths.length === 0) {
      return [];
    }

    const directRequestedPaths = new Set(requestedPaths);
    return normalizedPaths.filter((filePath) => {
      if (directRequestedPaths.has(filePath)) {
        return true;
      }
      return requestedPaths.some((candidatePath) => arePathsEquivalent(candidatePath, filePath));
    });
  }, [loadFilePaths, normalizedPaths, priorityFilePath]);

  const fileDiffLookup = useMemo(() => {
    const byPath = new Map<string, FileDiff>();
    const byNormalizedPath = new Map<string, FileDiff>();
    const entries: FileDiff[] = [];
    for (const fileDiff of fileDiffs ?? []) {
      if (!fileDiff.filePath) continue;
      byPath.set(fileDiff.filePath, fileDiff);
      const normalizedPath = normalizePathForMatch(fileDiff.filePath);
      if (!byNormalizedPath.has(normalizedPath)) {
        byNormalizedPath.set(normalizedPath, fileDiff);
      }
      entries.push(fileDiff);
    }
    return { byPath, byNormalizedPath, entries };
  }, [fileDiffs]);

  const fileDiffCacheKey = useMemo(() => {
    if ((mode === 'conversation' && !turnId) || fileDiffLookup.entries.length === 0) {
      return '';
    }
    return fileDiffLookup.entries
      .map(
        (fileDiff) =>
          `${fileDiff.filePath}:${fileDiff.cc?.fileId ?? ''}:${fileDiff.cc?.opId ?? ''}:${fileDiff.cc?.baseOpId ?? ''}:${fileDiff.cc?.deleted === true ? 'd' : ''}`
      )
      .sort()
      .join('|');
  }, [fileDiffLookup, mode, turnId]);

  const cacheKey = useMemo(() => {
    if (mode !== 'conversation' || !turnId) {
      return null;
    }
    return `${sessionId}:${mode}:${turnId}:${fileDiffCacheKey}`;
  }, [fileDiffCacheKey, mode, sessionId, turnId]);
  const loadContext = useMemo(
    () => ({
      cacheKey,
      fileDiffCacheKey,
      fileProvider,
      mode,
      normalizedPathsKey,
      requestScope,
      allChangesScope,
      turnId,
    }),
    [
      cacheKey,
      fileDiffCacheKey,
      fileProvider,
      mode,
      normalizedPathsKey,
      requestScope,
      allChangesScope,
      turnId,
    ]
  );
  const loadContextRef = useRef(loadContext);
  loadContextRef.current = loadContext;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [resolvedByPath, setResolvedByPath] = useState<Record<string, FileDiffData>>({});
  const [loadSettlements, setLoadSettlements] = useState(0);
  const resolvedContext = useRef(loadContext);
  const visibleResolvedByPath =
    resolvedContext.current === loadContext ||
    (mode === 'conversation' && cacheKey !== null && resolvedContext.current.cacheKey === cacheKey)
      ? resolvedByPath
      : EMPTY_RESOLVED_DIFFS;
  const resolvedByPathRef = useRef(resolvedByPath);
  const resolvedStateVersionRef = useRef(0);
  const resolvedTransitionSeqRef = useRef(0);

  const replaceResolvedByPath = useCallback((next: Record<string, FileDiffData>) => {
    if (Object.keys(resolvedByPathRef.current).length === 0 && Object.keys(next).length === 0) {
      return;
    }
    resolvedStateVersionRef.current += 1;
    resolvedTransitionSeqRef.current += 1;
    resolvedByPathRef.current = next;
    setResolvedByPath(next);
  }, []);

  const scheduleResolvedByPathUpdate = useCallback(
    (updater: (prev: Record<string, FileDiffData>) => Record<string, FileDiffData>) => {
      const previous = resolvedByPathRef.current;
      const next = updater(previous);
      if (next === previous) {
        return;
      }

      resolvedByPathRef.current = next;
      resolvedTransitionSeqRef.current += 1;
      logDiffPerfLazy('data:state-update', () => ({
        resolvedCount: Object.keys(next).length,
      }));
      setResolvedByPath(next);
    },
    []
  );

  const hasAllResolved = useMemo(
    () => normalizedPaths.every((filePath) => Boolean(visibleResolvedByPath[filePath])),
    [normalizedPaths, visibleResolvedByPath]
  );

  const shouldFetchMissingDiff =
    enabled &&
    shouldStartSessionDiffLoads({
      useProviderDiff,
      waitForProviderDiff,
      loadPaused,
      fileDiffsPending,
      normalizedPathCount: normalizedPaths.length,
      mode,
      turnId,
    });
  const isDiffUnavailable =
    (mode === 'conversation' && !turnId) ||
    (!useProviderDiff && !waitForProviderDiff && normalizedPaths.length > 0);
  const isPanelLoading = normalizedPaths.length > 0 && !isDiffUnavailable && !hasAllResolved;

  useEffect(() => {
    for (const timeoutId of retryTimeoutsRef.current.values()) {
      clearTimeout(timeoutId);
    }
    retryTimeoutsRef.current.clear();
    retryAttemptsRef.current.clear();
    resolvedContext.current = loadContext;
    replaceResolvedByPath({});
  }, [loadContext, replaceResolvedByPath]);

  useEffect(() => {
    if (loadPaused) {
      return;
    }

    const cachedResolvedByPath = readCachedResolvedData(loadContext.cacheKey, normalizedPaths);
    if (Object.keys(cachedResolvedByPath).length === 0) {
      return;
    }

    scheduleResolvedByPathUpdate((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [filePath, data] of Object.entries(cachedResolvedByPath)) {
        if (!next[filePath]) {
          next[filePath] = data;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [loadContext, loadPaused, normalizedPaths, scheduleResolvedByPathUpdate]);

  useEffect(() => {
    const retryTimeouts = retryTimeoutsRef.current;
    const retryAttempts = retryAttemptsRef.current;

    return () => {
      for (const timeoutId of retryTimeouts.values()) {
        clearTimeout(timeoutId);
      }
      retryTimeouts.clear();
      retryAttempts.clear();
    };
  }, []);

  useEffect(() => {
    if (!shouldFetchMissingDiff) {
      logDiffPerfLazy('data:skip', () => ({
        mode,
        useProviderDiff,
        waitForProviderDiff,
        loadPaused,
        fileDiffsPending,
        normalizedCount: normalizedPaths.length,
        targetLoadCount: targetLoadPaths.length,
      }));
      return undefined;
    }

    const inFlightPaths = inFlightPathsRef.current;
    const currentResolvedByPath = resolvedByPathRef.current;
    const pendingPaths = targetLoadPaths.filter((filePath) => {
      const current = currentResolvedByPath[filePath];
      const retryAttempts = retryAttemptsRef.current.get(filePath);
      const retryReady =
        current?.status === 'error' &&
        retryAttempts !== undefined &&
        retryAttempts <= MAX_ERROR_RETRIES &&
        !retryTimeoutsRef.current.has(filePath);
      return (!current || retryReady) && !inFlightPaths.has(filePath);
    });
    if (pendingPaths.length === 0) {
      logDiffPerfLazy('data:no-pending', () => ({
        mode,
        normalizedCount: normalizedPaths.length,
        targetLoadCount: targetLoadPaths.length,
        resolvedCount: Object.keys(currentResolvedByPath).length,
        inFlightCount: inFlightPaths.size,
      }));
      return undefined;
    }

    let cancelled = false;
    // Changing the viewport cancels queued starts, not valid in-flight results.
    // Their settlement must publish/wake the next pass and release the slot.
    const isCurrentLoad = () => mounted.current && loadContextRef.current === loadContext;

    const loadSinglePath = async (filePath: string): Promise<void> => {
      const loadStartedAt = getDiffPerfNow();

      if (isFilteredDiffFile(filePath)) {
        inFlightPathsRef.current.delete(filePath);
        if (isCurrentLoad()) {
          const data: FileDiffData = {
            status: 'ready',
            oldSnapshot: { kind: 'filtered' },
            newSnapshot: { kind: 'filtered' },
          };
          scheduleResolvedByPathUpdate((prev) => {
            const next = { ...prev, [filePath]: data };
            writeCachedResolvedData(cacheKey, next);
            return next;
          });
          logDiffPerfDuration(
            'data:filtered',
            loadStartedAt,
            {
              filePath,
              mode,
            },
            0
          );
        }
        return;
      }

      try {
        const readStartedAt = getDiffPerfNow();
        if (!fileProvider) {
          throw new Error('Code Collab file provider is unavailable.');
        }

        const matchedFileDiff =
          mode === 'base'
            ? undefined
            : (fileDiffLookup.byPath.get(filePath) ??
              fileDiffLookup.byNormalizedPath.get(normalizePathForMatch(filePath)));
        // Keep the three-argument shape when no scope is selected so older providers and
        // existing call expectations stay byte-compatible.
        const diffRequestArgs: Parameters<SessionFileProvider['getDiff']> = [
          filePath,
          mode === 'base' ? undefined : turnId,
          matchedFileDiff,
        ];
        if (mode === 'base' && allChangesScope !== undefined) {
          diffRequestArgs.push({ allChangesScope });
        }
        const data = sessionFileProviderDiffResultToFileDiffData(
          await fileProvider.getDiff(...diffRequestArgs)
        );
        if (!isCurrentLoad()) {
          if (data.status === 'ready-text-source') data.source.dispose?.();
          return;
        }
        if (data.status === 'error' && shouldRetrySessionProviderDiffErrorMessage(data.message)) {
          throw new Error(data.message);
        }
        const readMs = getDiffPerfNow() - readStartedAt;

        const retryTimeoutId = retryTimeoutsRef.current.get(filePath);
        if (retryTimeoutId !== undefined) {
          clearTimeout(retryTimeoutId);
          retryTimeoutsRef.current.delete(filePath);
        }
        retryAttemptsRef.current.delete(filePath);
        inFlightPathsRef.current.delete(filePath);

        if (isCurrentLoad()) {
          scheduleResolvedByPathUpdate((prev) => {
            const next = { ...prev, [filePath]: data };
            writeCachedResolvedData(cacheKey, next);
            return next;
          });
          logDiffPerfDurationLazy(
            isReadyFileDiffData(data) ? 'data:loaded' : 'data:error',
            loadStartedAt,
            () => ({
              filePath,
              mode,
              readMs: Math.round(readMs * 10) / 10,
              provider: true,
              status: data.status,
              ...(data.status === 'ready'
                ? {
                    oldSnapshot: describeSessionDiffSnapshot(data.oldSnapshot),
                    newSnapshot: describeSessionDiffSnapshot(data.newSnapshot),
                  }
                : data.status === 'ready-parsed'
                  ? {
                      oldTextLength: data.oldTextLength,
                      newTextLength: data.newTextLength,
                      hunkCount: data.fileDiff.hunks.length,
                    }
                  : data.status === 'ready-text-source'
                    ? {
                        oldTextLength: data.source.oldTextLength,
                        newTextLength: data.source.newTextLength,
                      }
                    : {}),
            }),
            0
          );
        }
      } catch (error) {
        if (!isCurrentLoad()) return;
        const message = getSessionDiffErrorMessage(error);
        const attempts = (retryAttemptsRef.current.get(filePath) ?? 0) + 1;
        retryAttemptsRef.current.set(filePath, attempts);

        inFlightPathsRef.current.delete(filePath);

        const existingRetryTimeout = retryTimeoutsRef.current.get(filePath);
        if (existingRetryTimeout !== undefined) {
          clearTimeout(existingRetryTimeout);
          retryTimeoutsRef.current.delete(filePath);
        }

        if (isCurrentLoad()) {
          const data: FileDiffData = { status: 'error', message };
          scheduleResolvedByPathUpdate((prev) => {
            const next = { ...prev, [filePath]: data };
            writeCachedResolvedData(cacheKey, next);
            return next;
          });
          logDiffPerfDuration(
            'data:error',
            loadStartedAt,
            {
              filePath,
              mode,
              attempts,
              maxRetries: MAX_ERROR_RETRIES,
              message,
            },
            0
          );

          if (attempts <= MAX_ERROR_RETRIES) {
            const retryTimeoutId = window.setTimeout(() => {
              retryTimeoutsRef.current.delete(filePath);
              logDiffPerf('data:retry', {
                filePath,
                mode,
                attempts,
                retryDelayMs: RETRY_DELAY_MS,
              });
              scheduleResolvedByPathUpdate((prev) => {
                const current = prev[filePath];
                if (!current || current.status !== 'error') {
                  return prev;
                }
                const next = { ...prev };
                writeCachedResolvedData(cacheKey, next);
                return next;
              });
            }, RETRY_DELAY_MS);
            retryTimeoutsRef.current.set(filePath, retryTimeoutId);
          }
        }
      } finally {
        inFlightPaths.delete(filePath);
        if (mounted.current) setLoadSettlements((version) => version + 1);
      }
    };

    // Reorder so the priority (focused) file loads first, then the rest.
    const priorityLoadPath = priorityFilePath
      ? (pendingPaths.find(
          (filePath) =>
            filePath === priorityFilePath || arePathsEquivalent(filePath, priorityFilePath)
        ) ?? null)
      : null;
    const orderedPaths = priorityLoadPath
      ? [priorityLoadPath, ...pendingPaths.filter((filePath) => filePath !== priorityLoadPath)]
      : pendingPaths;
    const loadScheduling = getDiffDataLoadScheduling(targetLoadPaths.length);
    const availableLoadSlots = Math.max(0, loadScheduling.maxConcurrentLoads - inFlightPaths.size);
    if (availableLoadSlots === 0) {
      logDiffPerfLazy('data:no-available-slots', () => ({
        mode,
        pendingCount: pendingPaths.length,
        inFlightCount: inFlightPaths.size,
        loadScheduling,
      }));
      return undefined;
    }

    const pathsToLoad = orderedPaths.slice(
      0,
      Math.min(loadScheduling.maxPendingLoadsPerEffect, availableLoadSlots)
    );
    logDiffPerfLazy('data:queue', () => ({
      mode,
      pendingCount: pendingPaths.length,
      pathsToLoad,
      priorityLoadPath,
      loadScheduling,
    }));

    for (const filePath of pathsToLoad) {
      inFlightPathsRef.current.add(filePath);
    }

    // Load with limited concurrency to avoid request spikes.
    let index = 0;
    const startedPaths = new Set<string>();
    const processNext = async (): Promise<void> => {
      while (index < pathsToLoad.length) {
        if (cancelled) return;
        const currentIndex = index++;
        const filePath = pathsToLoad[currentIndex];
        if (!filePath) continue;
        if (loadScheduling.delayNonPriorityLoads && filePath !== priorityLoadPath) {
          await waitForDiffLoadSlot();
        }
        if (cancelled) {
          inFlightPaths.delete(filePath);
          return;
        }
        startedPaths.add(filePath);
        await loadSinglePath(filePath);
      }
    };

    const workers = Array.from(
      { length: Math.min(loadScheduling.maxConcurrentLoads, pathsToLoad.length) },
      () => processNext()
    );
    void Promise.all(workers);

    return () => {
      cancelled = true;
      // A scroll/pause or provider state change can cancel this effect while a
      // path is marked in-flight. Release only paths that have not started an RPC;
      // started paths keep their in-flight slot until the request resolves so
      // state updates cannot overrun the intended global concurrency cap.
      for (const filePath of pathsToLoad) {
        if (!startedPaths.has(filePath)) {
          inFlightPaths.delete(filePath);
        }
      }
    };
  }, [
    allChangesScope,
    cacheKey,
    fileDiffLookup,
    fileDiffsPending,
    fileProvider,
    loadPaused,
    loadContext,
    loadSettlements,
    mode,
    normalizedPaths.length,
    priorityFilePath,
    resolvedByPath,
    scheduleResolvedByPathUpdate,
    shouldFetchMissingDiff,
    targetLoadPaths,
    turnId,
    useProviderDiff,
    waitForProviderDiff,
  ]);

  return {
    cacheKey,
    normalizedPaths,
    resolvedByPath: visibleResolvedByPath,
    hasAllResolved,
    isDiffUnavailable,
    isPanelLoading,
  };
};
