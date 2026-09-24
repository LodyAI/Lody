import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { WorktreeCleanupScriptConfig, WorktreeSetupScriptConfig } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import {
  setWorkspaceReposCacheAtom,
  workspaceReposCacheAtomFamily,
} from '@/atoms/local-storage-cache';
import { useOrganization } from '@/hooks/useOrganization';
import { useAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useCloudQuery, usePlatformCapability } from '@lody/platform/react';
import {
  canRunAuthedWorkspaceQuery,
  isAuthedWorkspaceQueryLoading,
} from '@/lib/authed-convex-query';
import {
  EMPTY_USAGE_DAY_CACHE,
  MAX_CACHED_USAGE_DAYS,
  USAGE_DAY_CACHE_TTL_MS,
  readUsageDayCache,
  writeUsageDayCache,
  usageDayCacheAtom,
} from './usage-day-cache';

export type SettingsUsageRange = 'day' | 'week' | 'month' | 'total';

export type SettingsUsageTimelineData = {
  workspaceId: string;
  range: SettingsUsageRange;
  startMs: number;
  endMs: number;
  bucketSizeMs: number;
  totals: {
    tokens: number;
    costUSD: number;
    /** Token-type split of the range. Absent when the deployment does not report it. */
    breakdown?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningOutputTokens: number;
    };
  };
  users?: Record<
    string,
    {
      name?: string;
      email?: string;
      image?: string | null;
    }
  >;
  buckets: SettingsUsageTimelineBucket[];
};

export type SettingsUsageTimelineBucket = {
  bucketStartMs: number;
  bucketLabel: string;
  tokens: number;
  costUSD: number;
  byModel: Array<{ modelId: string; tokens: number; costUSD: number }>;
  byUser: Array<{ userId: string; tokens: number; costUSD: number }>;
};

export type SettingsUsageCalendarData = {
  workspaceId: string;
  timezone: 'UTC';
  startMs: number;
  endMs: number;
  days: Array<{
    dayStartMs: number;
    date: string;
    tokens: number;
    costUSD: number;
    isFuture: boolean;
  }>;
};

/** Per-day breakdown behind a single usage-calendar cell. */
export type SettingsUsageDayData = {
  workspaceId: string;
  dayStartMs: number;
  date: string;
  totals: {
    tokens: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningOutputTokens: number;
    webSearchRequests: number;
  };
  byModel: Array<{ modelId: string; tokens: number; costUSD: number }>;
  byUser: Array<{ userId: string; tokens: number; costUSD: number }>;
  users: Record<string, { name?: string; email?: string; image?: string | null }>;
};

export type SettingsWorkspaceRepository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
};

export type SettingsWorkspaceRepoWithStatus = {
  repoFullName: string;
  name: string;
  repositoryId: number;
  private: boolean;
  enabled: boolean;
  worktreeSetup?: WorktreeSetupScriptConfig;
  worktreeCleanup?: WorktreeCleanupScriptConfig;
};

type SettingsDataCacheContextValue = {
  workspaceId: string | null;
  canManageGithub: boolean;
  usageTimelineByRange: Partial<Record<SettingsUsageRange, SettingsUsageTimelineData | undefined>>;
  usageCalendar: SettingsUsageCalendarData | undefined;
  repositories: SettingsWorkspaceRepository[] | undefined;
  /** All repos linked to the workspace with enabled status (reactive query). */
  workspaceReposWithStatus: SettingsWorkspaceRepoWithStatus[] | undefined;
  workspaceReposLoading: boolean;
};

const SettingsDataCacheContext = createContext<SettingsDataCacheContextValue | null>(null);

export function SettingsDataCacheProvider({ children }: { children: ReactNode }) {
  const { activeOrganization, hasAdminPermission } = useOrganization();
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const { isAuthenticated: isConvexAuthenticated, isLoading: isConvexAuthLoading } =
    useAuthenticatedConvex();
  // Removal clears the atom before Better Auth drops its stale active organization.
  const workspaceId = activeOrganization?.id === currentWorkspaceId ? currentWorkspaceId : null;
  const canManageGithub = Boolean(workspaceId) && hasAdminPermission;

  const canQuery = canRunAuthedWorkspaceQuery(workspaceId, isConvexAuthenticated);
  const cachedRepositories = useAtomValue(workspaceReposCacheAtomFamily(workspaceId));
  const setWorkspaceReposCache = useSetAtom(setWorkspaceReposCacheAtom);

  // Preload all stats ranges once at settings-root level to avoid re-fetch when switching tabs.
  const dayUsage = useCloudQuery(
    cloudOperations.usage.getWorkspaceUsageTimeline,
    workspaceId ? { workspaceId, range: 'day', granularity: 'hour' } : 'skip'
  ) as SettingsUsageTimelineData | undefined;
  const weekUsage = useCloudQuery(
    cloudOperations.usage.getWorkspaceUsageTimeline,
    workspaceId ? { workspaceId, range: 'week', granularity: 'hour' } : 'skip'
  ) as SettingsUsageTimelineData | undefined;
  const monthUsage = useCloudQuery(
    cloudOperations.usage.getWorkspaceUsageTimeline,
    workspaceId ? { workspaceId, range: 'month' } : 'skip'
  ) as SettingsUsageTimelineData | undefined;
  const totalUsage = useCloudQuery(
    cloudOperations.usage.getWorkspaceUsageTimeline,
    workspaceId ? { workspaceId, range: 'total' } : 'skip'
  ) as SettingsUsageTimelineData | undefined;
  const usageCalendar = useCloudQuery(
    cloudOperations.usage.getWorkspaceUsageCalendar,
    workspaceId ? { workspaceId } : 'skip'
  ) as SettingsUsageCalendarData | undefined;

  // Preload GitHub workspace state once at settings-root level.
  const repositories = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    workspaceId ? { workspaceId } : 'skip'
  ) as SettingsWorkspaceRepository[] | undefined;

  // Reactive query for all repos with enabled status (used by settings integrations page).
  // Any workspace member can view; mutations (toggle) still require admin.
  const workspaceReposWithStatus = useCloudQuery(
    cloudOperations.github.listWorkspaceReposWithStatus,
    workspaceId ? { workspaceId } : 'skip'
  ) as SettingsWorkspaceRepoWithStatus[] | undefined | null;

  // Mirror the chat-landing fix: during idle resume `isAuthenticated` briefly
  // flips false while Convex reconnects, so `canQuery && ... === undefined`
  // would falsely report "not loading" and flash the empty-state UI before the
  // repo list comes back. The shared helper waits on `isConvexAuthLoading`
  // so the spinner stays up across the reconnect window.
  const workspaceReposLoading = isAuthedWorkspaceQueryLoading({
    workspaceId,
    isConvexAuthLoading,
    canQuery,
    queryResult: workspaceReposWithStatus,
  });

  useEffect(() => {
    if (!workspaceId) return;
    if (workspaceReposWithStatus) {
      setWorkspaceReposCache({
        workspaceId,
        repositories: workspaceReposWithStatus.map((repo) => ({
          fullName: repo.repoFullName,
          description: null,
        })),
      });
      return;
    }
    if (repositories) {
      setWorkspaceReposCache({
        workspaceId,
        repositories: repositories.map((repo) => ({
          fullName: repo.fullName,
          description: null,
        })),
      });
    }
  }, [repositories, setWorkspaceReposCache, workspaceId, workspaceReposWithStatus]);

  const workspaceReposWithStatusOrCache = useMemo(() => {
    if (workspaceReposWithStatus) return workspaceReposWithStatus;
    if (!cachedRepositories || cachedRepositories.length === 0) return undefined;
    return cachedRepositories.map((repo) => {
      const name = repo.fullName.split('/').pop() || repo.fullName;
      return {
        repoFullName: repo.fullName,
        name,
        repositoryId: 0,
        private: false,
        enabled: true,
      };
    });
  }, [cachedRepositories, workspaceReposWithStatus]);

  const usageTimelineByRange = useMemo(
    () => ({
      day: dayUsage,
      week: weekUsage,
      month: monthUsage,
      total: totalUsage,
    }),
    [dayUsage, monthUsage, totalUsage, weekUsage]
  );

  const value = useMemo<SettingsDataCacheContextValue>(
    () => ({
      workspaceId,
      canManageGithub,
      usageTimelineByRange,
      usageCalendar,
      repositories,
      workspaceReposWithStatus: workspaceReposWithStatusOrCache,
      workspaceReposLoading:
        workspaceReposLoading && (workspaceReposWithStatusOrCache?.length ?? 0) === 0,
    }),
    [
      canManageGithub,
      repositories,
      usageTimelineByRange,
      usageCalendar,
      workspaceId,
      workspaceReposLoading,
      workspaceReposWithStatusOrCache,
    ]
  );

  return (
    <SettingsDataCacheContext.Provider value={value}>{children}</SettingsDataCacheContext.Provider>
  );
}

export function useSettingsDataCache() {
  const context = useContext(SettingsDataCacheContext);
  if (!context) {
    throw new Error('useSettingsDataCache must be used within SettingsDataCacheProvider');
  }
  return context;
}

/**
 * Reuse persisted day details for one hour after a successful fetch. Expiry
 * refreshes only the selected day and keeps the old snapshot visible.
 */
export function useSettingsUsageDay(dayStartMs: number | null): {
  day: SettingsUsageDayData | undefined;
  loading: boolean;
} {
  const { workspaceId } = useSettingsDataCache();
  const { authSessionId, confirmedUnauthenticated } = useAuthenticatedConvex();
  const usageAvailable = usePlatformCapability('usageAnalytics');
  const cacheSessionId = usageAvailable && !confirmedUnauthenticated ? authSessionId : null;
  const enabled = Boolean(cacheSessionId && workspaceId && dayStartMs !== null);
  const [storedCache, setCache] = useAtom(usageDayCacheAtom);
  const [initialCache] = useState(readUsageDayCache);
  const cache = storedCache ?? initialCache;
  const cachedEntry =
    enabled && cache.authSessionId === cacheSessionId
      ? cache.days.find(
          ({ day }) => day.workspaceId === workspaceId && day.dayStartMs === dayStartMs
        )
      : undefined;
  const [, setRefreshRevision] = useState(0);
  const ageMs = cachedEntry ? Date.now() - cachedEntry.fetchedAt : Infinity;
  const fresh = ageMs >= 0 && ageMs < USAGE_DAY_CACHE_TTL_MS;
  const shouldQuery = enabled && !fresh;
  const result = useCloudQuery(
    cloudOperations.usage.getWorkspaceUsageDay,
    shouldQuery && workspaceId && dayStartMs !== null ? { workspaceId, dayStartMs } : 'skip'
  ) as SettingsUsageDayData | undefined;
  const liveDay =
    shouldQuery && result?.workspaceId === workspaceId && result?.dayStartMs === dayStartMs
      ? result
      : undefined;

  useEffect(() => {
    if (!cachedEntry || !fresh) return undefined;
    const timer = setTimeout(
      () => setRefreshRevision((revision) => revision + 1),
      Math.max(0, cachedEntry.fetchedAt + USAGE_DAY_CACHE_TTL_MS - Date.now())
    );
    return () => clearTimeout(timer);
  }, [cachedEntry, fresh]);

  useEffect(() => {
    setCache((stored) => {
      const previous = stored ?? initialCache;
      if (confirmedUnauthenticated || !usageAvailable) return EMPTY_USAGE_DAY_CACHE;
      // An unresolved session during recovery is not a sign-out. Hide its data
      // until identity returns, but preserve it for the same session to resume.
      if (!cacheSessionId) return previous;
      const current =
        previous.authSessionId === cacheSessionId
          ? previous
          : { authSessionId: cacheSessionId, days: [] };
      if (!liveDay) return current;
      return {
        authSessionId: cacheSessionId,
        days: [
          ...current.days.filter(
            ({ day }) =>
              day.workspaceId !== liveDay.workspaceId || day.dayStartMs !== liveDay.dayStartMs
          ),
          { fetchedAt: Date.now(), day: liveDay },
        ].slice(-MAX_CACHED_USAGE_DAYS),
      };
    });
  }, [cacheSessionId, confirmedUnauthenticated, initialCache, liveDay, setCache, usageAvailable]);

  useEffect(() => {
    if (storedCache) writeUsageDayCache(storedCache);
  }, [storedCache]);

  const day = liveDay ?? cachedEntry?.day;

  return {
    day,
    loading: enabled && day === undefined,
  };
}
