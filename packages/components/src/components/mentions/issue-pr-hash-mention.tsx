import * as React from 'react';
import { useAtomValue } from 'jotai';
import { CircleDot, Github, GitPullRequest } from 'lucide-react';
import { usePostHog } from '@posthog/react';
import { useTranslation } from 'react-i18next';
import { githubFetchIssuesAndPRs, type GitHubIssueOrPR } from '@lody/shared';
import type { IssuePRMention } from '@lody/shared';

import { currentWorkspaceIdAtom } from '@/atoms';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import {
  normalizeGithubFetchErrorCode,
  type MentionSurface,
} from '@/components/mentions/mention-analytics';
import { getIssuePrHashTriggerRefreshDecision } from '@/lib/issue-pr-trigger-refresh';
import { withGitHubTokenRetry } from '@/lib/github-token';
import { cn } from '@/lib/utils';
import { MentionContent, MentionItem, useMentionContext } from '@/ui/mention';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

// ============================================================================
// Types
// ============================================================================

type IssueOrPR = {
  number: number;
  url?: string;
  title: string;
  type: 'issue' | 'pr';
};

type RepoIssuesAndPRsResult = {
  repoFullName: string;
  items: IssueOrPR[];
};

export type ItemSuggestion = {
  number: number;
  url?: string;
  title: string;
  type: 'issue' | 'pr';
  token: string;
  label: string;
  searchableNumber: string;
  searchableTitle: string;
};

type FuseInstance<T> = {
  search: (pattern: string, options?: { limit?: number }) => Array<{ item: T; score?: number }>;
};

type FuseConstructor<T> = new (list: T[], options?: Record<string, unknown>) => FuseInstance<T>;

export type IssuePrKnownItem = {
  url?: string;
  title: string;
  type: 'issue' | 'pr';
  number: number;
};

export type IssuePrMentionData = {
  entry: RepoIssuesAndPRsResult | null;
  status: 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';
  error?: string;
};

type UseRepoIssuesAndPRsResult = IssuePrMentionData & {
  refresh: () => Promise<void>;
};

// ============================================================================
// Cache + Fetch
// ============================================================================

const MAX_ISSUE_PR_SUGGESTIONS = 50;

const ISSUE_PR_DB_NAME = 'lody:repo-issues-prs';
const DB_VERSION = 1;

const issuePrMemoryCache = new Map<string, RepoIssuesAndPRsResult>();
const issuePrInFlightRequests = new Map<string, Promise<RepoIssuesAndPRsResult>>();
const issuePrCacheListeners = new Map<string, Set<(entry: RepoIssuesAndPRsResult) => void>>();

// ============================================================================
// Analytics
// ============================================================================

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getRepoAnalyticsId(repoFullName: string, isPublic: boolean) {
  if (isPublic) return repoFullName;
  return `private:${fnv1a32(repoFullName.toLowerCase())}`;
}

function getIsOnline(): boolean | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.onLine;
}

function toErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getCacheKey(workspaceId: string, repoFullName: string) {
  return `${workspaceId}:${repoFullName}`;
}

function openCacheDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('store')) {
        db.createObjectStore('store');
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function idbGet<T>(dbName: string, key: string): Promise<T | null> {
  try {
    const db = await openCacheDb(dbName);
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('store', 'readonly');
      const store = tx.objectStore('store');
      const req = store.get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    });
  } catch {
    return null;
  }
}

async function idbSet(dbName: string, key: string, value: unknown): Promise<void> {
  try {
    const db = await openCacheDb(dbName);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('store', 'readwrite');
      const store = tx.objectStore('store');
      const req = store.put(value, key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  } catch {
    // ignore
  }
}

function subscribeIssuePrCache(key: string, listener: (entry: RepoIssuesAndPRsResult) => void) {
  const listeners = issuePrCacheListeners.get(key) ?? new Set();
  listeners.add(listener);
  issuePrCacheListeners.set(key, listeners);
  return () => {
    const current = issuePrCacheListeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      issuePrCacheListeners.delete(key);
    }
  };
}

function publishIssuePrCacheEntry(key: string, entry: RepoIssuesAndPRsResult) {
  issuePrMemoryCache.set(key, entry);
  void idbSet(ISSUE_PR_DB_NAME, key, entry);
  const listeners = issuePrCacheListeners.get(key);
  listeners?.forEach((listener) => listener(entry));
}

// ============================================================================
// Mention Utils
// ============================================================================

export function buildItemSuggestions(items: IssueOrPR[]): ItemSuggestion[] {
  return items.map((item) => {
    const numberLabel = String(item.number);
    return {
      number: item.number,
      url: item.url,
      title: item.title,
      type: item.type,
      token: `#${numberLabel}`,
      label: numberLabel,
      searchableNumber: numberLabel,
      searchableTitle: item.title.toLowerCase(),
    };
  });
}

export function getIssuePrFuseOptions() {
  return {
    keys: ['searchableNumber', 'searchableTitle'],
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 1,
    shouldSort: true,
  } as const;
}

// Module-level cache for the dynamically-imported Fuse constructor. Lifting
// this out of component state means once it has loaded for any consumer, every
// other consumer reads it synchronously during render — no extra Effect, no
// "wait one extra commit before fuzzy search activates".
let fuseCtorCache: unknown | null = null;
let fuseCtorPromise: Promise<unknown> | null = null;
const fuseCtorSubscribers = new Set<() => void>();

function loadFuseCtor(): void {
  if (fuseCtorCache) return;
  if (fuseCtorPromise) return;
  fuseCtorPromise = import('fuse.js')
    .then((mod) => {
      const ctor = (mod as unknown as { default?: unknown }).default ?? mod;
      fuseCtorCache = ctor;
      fuseCtorSubscribers.forEach((cb) => {
        cb();
      });
      return ctor;
    })
    .catch((err: unknown) => {
      fuseCtorPromise = null;
      throw err;
    });
}

function subscribeFuseCtor(callback: () => void): () => void {
  fuseCtorSubscribers.add(callback);
  return () => {
    fuseCtorSubscribers.delete(callback);
  };
}

function getFuseCtorSnapshot(): unknown | null {
  return fuseCtorCache;
}

function useFuseCtor<T>(enabled: boolean): FuseConstructor<T> | null {
  const ctor = React.useSyncExternalStore(
    subscribeFuseCtor,
    getFuseCtorSnapshot,
    getFuseCtorSnapshot
  );
  if (enabled && !ctor) {
    loadFuseCtor();
  }
  return (ctor as FuseConstructor<T> | null) ?? null;
}

function githubIssuePrUrl(repoFullName: string, type: 'issue' | 'pr', number: number) {
  const safeRepo = repoFullName.trim();
  const segment = type === 'pr' ? 'pull' : 'issues';
  return `https://github.com/${safeRepo}/${segment}/${number}`;
}

export function getIssuePrSuggestions(
  suggestions: ItemSuggestion[],
  term: string,
  fuse: FuseInstance<ItemSuggestion> | null
) {
  const trimmed = term.trim().toLowerCase();

  if (!trimmed) {
    const issues = suggestions.filter((s) => s.type === 'issue');
    const prs = suggestions.filter((s) => s.type === 'pr');
    return [...issues, ...prs].slice(0, MAX_ISSUE_PR_SUGGESTIONS);
  }

  const isNumericQuery = /^[0-9]+$/.test(trimmed);

  const candidates: Array<{ item: ItemSuggestion; score: number | null }> = (() => {
    if (fuse) {
      const results = fuse.search(trimmed, { limit: MAX_ISSUE_PR_SUGGESTIONS * 2 });
      return results.map((r) => ({
        item: r.item,
        score: typeof r.score === 'number' ? r.score : null,
      }));
    }
    return suggestions
      .filter((s) => s.searchableNumber.includes(trimmed) || s.searchableTitle.includes(trimmed))
      .map((item) => ({ item, score: null }));
  })();

  const sorted = candidates.sort((a, b) => {
    const aExactNumber = a.item.searchableNumber === trimmed;
    const bExactNumber = b.item.searchableNumber === trimmed;
    if (aExactNumber && !bExactNumber) return -1;
    if (!aExactNumber && bExactNumber) return 1;

    const aStartsWithNumber = a.item.searchableNumber.startsWith(trimmed);
    const bStartsWithNumber = b.item.searchableNumber.startsWith(trimmed);
    if (aStartsWithNumber && !bStartsWithNumber) return -1;
    if (!aStartsWithNumber && bStartsWithNumber) return 1;

    if (!isNumericQuery && a.item.type !== b.item.type) {
      return a.item.type === 'issue' ? -1 : 1;
    }

    if (a.score !== null && b.score !== null && a.score !== b.score) {
      return a.score - b.score;
    }

    if (isNumericQuery && a.item.type !== b.item.type) {
      return a.item.type === 'issue' ? -1 : 1;
    }

    return a.item.number - b.item.number;
  });

  return sorted.slice(0, MAX_ISSUE_PR_SUGGESTIONS).map((c) => c.item);
}

function hydrateIssuePrMentionsFromText(text: string, knownItems: Map<number, IssuePrKnownItem>) {
  const mentions: Array<{ value: string; start: number; end: number }> = [];
  const values = new Set<string>();

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '#') continue;
    const start = i;
    let j = i + 1;
    while (j < text.length) {
      const ch = text[j];
      if (!ch) break;
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '#') break;
      j++;
    }
    const candidate = text.slice(i + 1, j);
    if (!candidate) continue;
    const num = parseInt(candidate, 10);
    if (Number.isNaN(num) || num <= 0) continue;
    if (!knownItems.has(num)) continue;
    const value = `#${num}`;
    // Use the actual span end (supports inputs like "#0123" for issue #123).
    mentions.push({ value, start, end: j });
    values.add(value);
    i = j - 1;
  }

  return { mentions, values: Array.from(values) };
}

function normalizeIssuePrTitleForPrompt(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

export function extractIssuePRMentionsFromText(
  text: string,
  knownItems: Map<number, IssuePrKnownItem>,
  repoFullName?: string
): IssuePRMention[] {
  if (!text || knownItems.size === 0) return [];

  const mentions: IssuePRMention[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '#') continue;

    let j = i + 1;
    while (j < text.length) {
      const ch = text[j];
      if (!ch) break;
      if (ch < '0' || ch > '9') break;
      j++;
    }

    const digits = text.slice(i + 1, j);
    if (!digits) continue;

    const num = parseInt(digits, 10);
    if (Number.isNaN(num) || num <= 0) continue;

    const info = knownItems.get(num);
    if (!info) continue;

    const url =
      info.url ?? (repoFullName ? githubIssuePrUrl(repoFullName, info.type, num) : undefined);
    if (!url) continue;

    const key = `${info.type}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    mentions.push({
      type: info.type,
      title: normalizeIssuePrTitleForPrompt(info.title),
      url,
      number: info.number,
    });

    i = j - 1;
  }

  return mentions;
}

// ============================================================================
// Data Hook
// ============================================================================

function toRepoIssuesAndPRsResult(
  repoFullName: string,
  items: GitHubIssueOrPR[]
): RepoIssuesAndPRsResult {
  return {
    repoFullName,
    items: items.map((i) => ({
      number: i.number,
      url: i.url,
      title: i.title,
      type: i.type,
    })),
  };
}

export function useRepoIssuesAndPRs(
  repoFullName?: string,
  isPublic?: boolean
): UseRepoIssuesAndPRsResult {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const postHog = usePostHog();

  const [data, setData] = React.useState<IssuePrMentionData>({
    entry: null,
    status: 'idle',
  });

  const refresh = React.useCallback(async () => {
    if (!workspaceId || !repoFullName) return;

    const workspaceIdValue = workspaceId;
    const repoFullNameValue = repoFullName;
    const isPublicValue = isPublic ?? false;
    const repoAnalyticsId = getRepoAnalyticsId(repoFullNameValue, isPublicValue);
    const key = getCacheKey(workspaceIdValue, repoFullNameValue);

    setData((prev) => ({
      entry: prev.entry,
      status: prev.entry ? 'refreshing' : 'loading',
      error: undefined,
    }));

    const existingRequest = issuePrInFlightRequests.get(key);
    if (existingRequest) {
      try {
        const entry = await existingRequest;
        setData({ entry, status: 'ready' });
      } catch (err) {
        const message = toErrorMessage(err);
        setData((prev) => {
          if (prev.entry) {
            return { entry: prev.entry, status: 'ready' };
          }
          return { entry: null, status: 'error', error: message };
        });
      }
      return;
    }

    const fetchStart = Date.now();
    const source = 'github-direct';
    capturePostHogEvent(postHog, 'mention/issue_pr/fetch_start', {
      workspace_id: workspaceIdValue,
      source,
      repo: repoAnalyticsId,
      repoIsPublic: isPublicValue,
      online: getIsOnline(),
    });

    const request = (async () => {
      const items = await withGitHubTokenRetry(workspaceIdValue, repoFullNameValue, (token) =>
        githubFetchIssuesAndPRs(token, repoFullNameValue)
      );
      const entry = toRepoIssuesAndPRsResult(repoFullNameValue, items);
      publishIssuePrCacheEntry(key, entry);
      capturePostHogEvent(postHog, 'mention/issue_pr/fetch_success', {
        workspace_id: workspaceIdValue,
        source,
        repo: repoAnalyticsId,
        repoIsPublic: isPublicValue,
        durationMs: Date.now() - fetchStart,
        itemsCount: entry.items.length,
        online: getIsOnline(),
      });
      return entry;
    })();

    issuePrInFlightRequests.set(key, request);

    try {
      await request;
    } catch (err) {
      const message = toErrorMessage(err);
      setData((prev) => ({
        entry: prev.entry,
        status: 'error',
        error: message,
      }));
      // `error` was silently stripped by the denylist (spec §2.3). Send a
      // normalized `error_code` enum instead — never the raw message.
      capturePostHogEvent(postHog, 'mention/issue_pr/fetch_error', {
        workspace_id: workspaceIdValue,
        source,
        repo: repoAnalyticsId,
        repoIsPublic: isPublicValue,
        durationMs: Date.now() - fetchStart,
        error_code: normalizeGithubFetchErrorCode(err),
        online: getIsOnline(),
      });
    } finally {
      issuePrInFlightRequests.delete(key);
    }
  }, [isPublic, postHog, repoFullName, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId || !repoFullName) {
      setData({ entry: null, status: 'idle' });
      return undefined;
    }

    const workspaceIdValue = workspaceId;
    const repoFullNameValue = repoFullName;
    let cancelled = false;
    const key = getCacheKey(workspaceIdValue, repoFullNameValue);
    const unsubscribe = subscribeIssuePrCache(key, (entry) => {
      if (cancelled) return;
      setData({ entry, status: 'ready' });
    });

    async function run() {
      const mem = issuePrMemoryCache.get(key);

      if (mem) {
        setData({ entry: mem, status: 'ready' });
      } else {
        setData((prev) => ({ ...prev, status: 'loading' }));
        const persisted = await idbGet<RepoIssuesAndPRsResult>(ISSUE_PR_DB_NAME, key);
        if (cancelled) return;
        if (persisted) {
          issuePrMemoryCache.set(key, persisted);
          setData({
            entry: persisted,
            status: 'ready',
          });
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isPublic, postHog, refresh, repoFullName, workspaceId]);

  return {
    ...data,
    refresh,
  };
}

/**
 * Hook that fetches repository issues and PRs and returns them as a Map
 * keyed by issue/PR number for efficient lookup.
 */
export function useKnownIssuePrItems(repoFullName?: string, isPublic?: boolean) {
  const issuePrData = useRepoIssuesAndPRs(repoFullName, isPublic);

  const knownItems = React.useMemo(() => {
    const items = issuePrData.entry?.items ?? [];
    if (!items.length) return new Map<number, IssuePrKnownItem>();
    return new Map(
      items.map((item) => [
        item.number,
        { url: item.url, title: item.title, type: item.type, number: item.number },
      ])
    );
  }, [issuePrData.entry]);

  return { knownItems, issuePrData, status: issuePrData.status, error: issuePrData.error };
}

// ============================================================================
// Hydrator
// ============================================================================

export function IssuePrMentionHydrator({
  text,
  knownItems,
  enabled,
}: {
  text: string;
  knownItems: Map<number, IssuePrKnownItem>;
  enabled: boolean;
}) {
  const context = useMentionContext('IssuePrMentionHydrator');
  const initialTextRef = React.useRef(text);
  const hydratedRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled) return;
    if (hydratedRef.current) return;
    const initialText = initialTextRef.current;
    if (!initialText) return;
    if (text !== initialText) return;
    if (knownItems.size === 0) return;
    if (context.open) return;

    const hydrated = hydrateIssuePrMentionsFromText(initialText, knownItems);
    if (hydrated.mentions.length === 0) return;

    hydratedRef.current = true;
    context.onMentionsChange((prev) => {
      const merged = [...prev, ...hydrated.mentions].sort((a, b) => a.start - b.start);
      const seen = new Set<string>();
      return merged.filter((m) => {
        const key = `${m.start}:${m.end}:${m.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    context.onValueChange((prev) => {
      const next = new Set([...(prev ?? []), ...hydrated.values]);
      return Array.from(next);
    });
  }, [context, enabled, knownItems, text]);

  return null;
}

// ============================================================================
// UI Components
// ============================================================================

function IssuePrMentionLoadingSkeleton() {
  const rows = ['w-[72%]', 'w-[54%]', 'w-[86%]', 'w-[63%]', 'w-[78%]', 'w-[58%]'];

  return (
    <div className="px-2 py-2">
      <div className="animate-pulse space-y-2">
        {rows.map((widthClass, index) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            className={cn('h-4 rounded-xs', 'bg-muted/70', widthClass)}
          />
        ))}
      </div>
    </div>
  );
}

function getItemIconMeta(type: 'issue' | 'pr') {
  if (type === 'pr') {
    return { Icon: GitPullRequest, iconClassName: 'text-github-open' };
  }
  return { Icon: CircleDot, iconClassName: 'text-status-info' };
}

export function IssuePrMentionMenu({
  repoFullName,
  isPublic,
  issuePrData,
  surface = 'unknown',
}: {
  repoFullName?: string;
  isPublic?: boolean;
  issuePrData: UseRepoIssuesAndPRsResult;
  surface?: MentionSurface;
}) {
  const context = useMentionContext('IssuePrMentionMenu');
  const postHog = usePostHog();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const { t } = useTranslation();
  const trigger = context.trigger;
  const refreshIssuePrData = issuePrData.refresh;

  const issuePrTerm = trigger === '#' ? context.filterStore.search : '';
  const issuePrSuggestions = React.useMemo(() => {
    if (!issuePrData.entry || trigger !== '#') return [];
    const repo = issuePrData.entry.repoFullName;
    const normalized = issuePrData.entry.items.map((item) => ({
      ...item,
      url: item.url ?? githubIssuePrUrl(repo, item.type, item.number),
    }));
    return buildItemSuggestions(normalized);
  }, [issuePrData.entry, trigger]);

  const issuePrFuseCtor = useFuseCtor<ItemSuggestion>(issuePrSuggestions.length > 0);

  const issuePrFuse = React.useMemo(() => {
    if (!issuePrFuseCtor || !issuePrSuggestions.length) return null;
    try {
      return new issuePrFuseCtor(issuePrSuggestions, getIssuePrFuseOptions());
    } catch {
      return null;
    }
  }, [issuePrFuseCtor, issuePrSuggestions]);

  const issuePrIndexed = React.useMemo(() => {
    if (trigger !== '#') return [];
    return getIssuePrSuggestions(issuePrSuggestions, issuePrTerm, issuePrFuse);
  }, [issuePrSuggestions, issuePrTerm, issuePrFuse, trigger]);

  React.useEffect(() => {
    if (!context.open) return;
    if (context.highlightedItem) return;
    if (trigger !== '#') return;
    const items = context.getEnabledItems();
    if (!items.length) return;
    requestAnimationFrame(() => {
      const first = items[0] ?? null;
      if (first) context.onHighlightedItemChange(first);
    });
  }, [context, issuePrIndexed, trigger]);

  const openTrackedRef = React.useRef(false);
  React.useEffect(() => {
    if (!context.open || trigger !== '#') {
      openTrackedRef.current = false;
      return;
    }
    if (openTrackedRef.current) return;
    openTrackedRef.current = true;

    const repoIsPublic = isPublic ?? false;
    const repoId = repoFullName ? getRepoAnalyticsId(repoFullName, repoIsPublic) : null;

    capturePostHogEvent(postHog, 'mention/issue_pr/menu_open', {
      workspace_id: workspaceId,
      surface,
      repo: repoId,
      hasRepo: Boolean(repoFullName),
      hasEntry: Boolean(issuePrData.entry),
      status: issuePrData.status,
      itemsCount: issuePrData.entry?.items.length ?? 0,
      termLength: issuePrTerm.length,
      online: getIsOnline(),
    });
  }, [
    context.open,
    issuePrData.entry,
    issuePrData.status,
    issuePrTerm.length,
    isPublic,
    postHog,
    repoFullName,
    surface,
    trigger,
    workspaceId,
  ]);

  const refreshedRepoForCurrentHashTriggerRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const decision = getIssuePrHashTriggerRefreshDecision({
      trigger,
      repoFullName,
      refreshedRepoForCurrentHashTrigger: refreshedRepoForCurrentHashTriggerRef.current,
    });
    refreshedRepoForCurrentHashTriggerRef.current = decision.nextRefreshedRepoForCurrentHashTrigger;
    if (!decision.shouldRefresh) return;
    void refreshIssuePrData();
  }, [refreshIssuePrData, repoFullName, trigger]);

  if (trigger !== '#') return null;

  return (
    <MentionContent className="w-max max-w-[min(var(--mention-input-width),calc(100vw-2rem))]">
      {!repoFullName ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          {t('mention.issuePr.selectRepo', 'Select a repo to mention issues/PRs.')}
        </div>
      ) : issuePrData.status === 'loading' && !issuePrData.entry ? (
        <IssuePrMentionLoadingSkeleton />
      ) : issuePrData.status === 'error' ? (
        <div className="px-2 py-1.5 text-sm text-destructive">
          {issuePrData.error ?? t('mention.issuePr.loadError', 'Failed to load issues and PRs.')}
        </div>
      ) : null}

      {issuePrIndexed.length > 0 ? (
        <div className="scrollbar-pro max-h-[260px] overflow-auto overflow-x-auto">
          {issuePrIndexed.map((item, index) => {
            const token = item.token;
            const { Icon, iconClassName } = getItemIconMeta(item.type);
            return (
              <MentionItem
                key={token}
                value={token}
                label={item.label}
                onMentionSelect={() => {
                  const repoIsPublic = isPublic ?? false;
                  const repoId = repoFullName
                    ? getRepoAnalyticsId(repoFullName, repoIsPublic)
                    : null;
                  capturePostHogEvent(postHog, 'mention/issue_pr/select', {
                    workspace_id: workspaceId,
                    surface,
                    repo: repoId,
                    type: item.type,
                    number: item.number,
                    rank: index,
                    termLength: issuePrTerm.length,
                    itemsCount: issuePrData.entry?.items.length ?? 0,
                    online: getIsOnline(),
                  });
                }}
              >
                <Icon className={cn('h-4 w-4 shrink-0', iconClassName)} />
                <span className="shrink-0 rounded-xs border border-border/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                  #{item.number}
                </span>
                <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
              </MentionItem>
            );
          })}
        </div>
      ) : repoFullName && issuePrData.status !== 'loading' ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          {t('mention.issuePr.noResults', 'No results')}
        </div>
      ) : null}
    </MentionContent>
  );
}

// ============================================================================
// Inline Title Hint (after insertion)
// ============================================================================

const ISSUE_PR_TITLE_HINT_CLOSE_DELAY_MS = 650;

type IssuePrMentionMeta = {
  start: number;
  end: number;
  value: string;
  number: number;
  url?: string;
  title: string;
  type: 'issue' | 'pr';
};

function getLineHeight(input: HTMLTextAreaElement) {
  const style = window.getComputedStyle(input);
  const parsed = Number.parseInt(style.lineHeight, 10);
  return Number.isFinite(parsed) ? parsed : input.offsetHeight;
}

function getTextWidth(text: string, input: HTMLTextAreaElement) {
  const style = window.getComputedStyle(input);
  const measureSpan = document.createElement('span');
  measureSpan.style.cssText = `
    position: absolute;
    visibility: hidden;
    white-space: pre;
    font: ${style.font};
    letter-spacing: ${style.letterSpacing};
    text-transform: ${style.textTransform};
  `;
  measureSpan.textContent = text;
  document.body.appendChild(measureSpan);
  const width = measureSpan.offsetWidth;
  document.body.removeChild(measureSpan);
  return width;
}

function rectFromEdges({
  left,
  top,
  right,
  bottom,
}: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}) {
  return DOMRect.fromRect({
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  });
}

function calculateCaretRect(input: HTMLTextAreaElement, cursorPosition: number) {
  const rect = input.getBoundingClientRect();
  const textBeforeCursor = input.value.slice(0, cursorPosition);
  const lines = textBeforeCursor.split('\n');
  const currentLine = lines.length - 1;
  const currentLineText = lines[currentLine] ?? '';
  const textWidth = getTextWidth(currentLineText, input);

  const style = window.getComputedStyle(input);
  const lineHeight = getLineHeight(input);
  const paddingLeft = Number.parseFloat(style.getPropertyValue('padding-left') ?? '0');
  const paddingRight = Number.parseFloat(style.getPropertyValue('padding-right') ?? '0');
  const paddingTop = Number.parseFloat(style.getPropertyValue('padding-top') ?? '0');

  const containerWidth = input.clientWidth - paddingLeft - paddingRight;
  const wrappedLines = containerWidth > 0 ? Math.floor(textWidth / containerWidth) : 0;
  const totalLines = currentLine + wrappedLines;

  const scrollTop = input.scrollTop;
  const scrollLeft = input.scrollLeft;

  const effectiveTextWidth = containerWidth > 0 ? textWidth % containerWidth : textWidth;
  const isRTL = style.direction === 'rtl';
  const x = isRTL
    ? Math.min(rect.right - paddingRight - effectiveTextWidth + scrollLeft, rect.right - 10)
    : Math.min(rect.left + paddingLeft + effectiveTextWidth - scrollLeft, rect.right - 10);
  const y = rect.top + paddingTop + (totalLines * lineHeight - scrollTop);

  return rectFromEdges({ left: x, top: y, right: x, bottom: y + lineHeight });
}

function pointInRect(clientX: number, clientY: number, rect: DOMRect) {
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
}

function getMentionHitRects(input: HTMLTextAreaElement, start: number, end: number) {
  const startRect = calculateCaretRect(input, start);
  const endRect = calculateCaretRect(input, end);
  const lineHeight = getLineHeight(input);
  const style = window.getComputedStyle(input);
  const paddingLeft = Number.parseFloat(style.getPropertyValue('padding-left') ?? '0');
  const paddingRight = Number.parseFloat(style.getPropertyValue('padding-right') ?? '0');

  const inputRect = input.getBoundingClientRect();
  const singleLine = Math.abs(endRect.top - startRect.top) < lineHeight / 2;

  if (singleLine) {
    const right = Math.max(endRect.left, startRect.left + 1);
    return [
      rectFromEdges({
        left: startRect.left,
        right,
        top: startRect.top,
        bottom: startRect.top + lineHeight,
      }),
    ];
  }

  // Wrapped: split into two hit rects (mentions are short, so 2 lines max is a safe approximation).
  const firstLineRight = inputRect.right - paddingRight;
  const secondLineLeft = inputRect.left + paddingLeft;
  return [
    rectFromEdges({
      left: startRect.left,
      right: firstLineRight,
      top: startRect.top,
      bottom: startRect.top + lineHeight,
    }),
    rectFromEdges({
      left: secondLineLeft,
      right: Math.max(endRect.left, secondLineLeft + 1),
      top: endRect.top,
      bottom: endRect.top + lineHeight,
    }),
  ];
}

export function IssuePrMentionTitleHint({
  repoFullName,
  knownItems,
  enabled,
}: {
  repoFullName?: string;
  knownItems: Map<number, IssuePrKnownItem>;
  enabled: boolean;
}) {
  const context = useMentionContext('IssuePrMentionTitleHint');
  const { t } = useTranslation();

  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const pinnedRef = React.useRef(pinned);
  const openRef = React.useRef(open);
  const closeTimerRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);
  React.useEffect(() => {
    openRef.current = open;
  }, [open]);

  const cancelScheduledClose = React.useCallback(() => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = React.useCallback(() => {
    if (pinnedRef.current) return;
    if (closeTimerRef.current) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (pinnedRef.current) return;
      setOpen(false);
      setActive(null);
    }, ISSUE_PR_TITLE_HINT_CLOSE_DELAY_MS);
  }, []);

  const issuePrMentions = React.useMemo<IssuePrMentionMeta[]>(() => {
    if (!enabled) return [];
    if (knownItems.size === 0) return [];

    const metas: IssuePrMentionMeta[] = [];
    for (const mention of context.mentions) {
      if (!mention.value.startsWith('#')) continue;
      const num = parseInt(mention.value.slice(1), 10);
      if (Number.isNaN(num) || num <= 0) continue;
      const info = knownItems.get(num);
      if (!info) continue;
      const url =
        info.url ?? (repoFullName ? githubIssuePrUrl(repoFullName, info.type, num) : undefined);
      metas.push({
        start: mention.start,
        end: mention.end,
        value: mention.value,
        number: num,
        url,
        title: info.title,
        type: info.type,
      });
    }
    return metas;
  }, [context.mentions, enabled, knownItems, repoFullName]);

  const [active, setActive] = React.useState<{
    meta: IssuePrMentionMeta;
    anchor: { left: number; top: number };
  } | null>(null);

  const close = React.useCallback(() => {
    cancelScheduledClose();
    setOpen(false);
    setPinned(false);
    setActive(null);
  }, [cancelScheduledClose]);

  const updateFromPoint = React.useCallback(
    (clientX: number, clientY: number) => {
      const input = context.inputRef.current;
      if (!input) return false;
      if (!enabled) return false;
      if (context.open) return false; // don't fight the mention menu
      if (issuePrMentions.length === 0) return false;

      for (const meta of issuePrMentions) {
        const rects = getMentionHitRects(input, meta.start, meta.end);
        if (rects.some((r) => pointInRect(clientX, clientY, r))) {
          cancelScheduledClose();
          const anchorRect = calculateCaretRect(input, meta.start);
          setActive({ meta, anchor: { left: anchorRect.left, top: anchorRect.top } });
          setOpen(true);
          return true;
        }
      }

      return false;
    },
    [cancelScheduledClose, context.inputRef, context.open, enabled, issuePrMentions]
  );

  React.useEffect(() => {
    const input = context.inputRef.current;
    if (!input) return undefined;
    if (!enabled) return undefined;

    let raf = 0;
    let lastMove: PointerEvent | null = null;

    const onPointerMove = (event: PointerEvent) => {
      if (pinnedRef.current) return;
      if (event.pointerType !== 'mouse') return;
      lastMove = event;
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const move = lastMove;
        if (!move) return;
        const hit = updateFromPoint(move.clientX, move.clientY);
        if (!hit) {
          scheduleClose();
        }
      });
    };

    const onPointerLeave = () => {
      if (pinnedRef.current) return;
      scheduleClose();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      const hit = updateFromPoint(event.clientX, event.clientY);
      if (!hit) {
        close();
        return;
      }
      setPinned(true);
      setOpen(true);
    };

    const onScroll = () => {
      if (openRef.current) close();
    };

    input.addEventListener('pointermove', onPointerMove);
    input.addEventListener('pointerleave', onPointerLeave);
    input.addEventListener('pointerdown', onPointerDown);
    input.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      cancelScheduledClose();
      input.removeEventListener('pointermove', onPointerMove);
      input.removeEventListener('pointerleave', onPointerLeave);
      input.removeEventListener('pointerdown', onPointerDown);
      input.removeEventListener('scroll', onScroll);
    };
  }, [cancelScheduledClose, close, context.inputRef, enabled, scheduleClose, updateFromPoint]);

  // If the mention menu opens or data disappears, close the hint.
  React.useEffect(() => {
    if (!open) return;
    if (context.open) close();
  }, [close, context.open, open]);

  if (!open || !active) return null;

  const { Icon, iconClassName } = getItemIconMeta(active.meta.type);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <PopoverTrigger asChild>
        <span
          aria-hidden="true"
          style={{
            position: 'fixed',
            left: active.anchor.left,
            top: active.anchor.top,
            width: 1,
            height: 1,
            pointerEvents: 'none',
          }}
        />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="max-w-[320px] p-3"
        onPointerEnter={() => {
          cancelScheduledClose();
        }}
        onPointerLeave={() => {
          scheduleClose();
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 rounded-xs border border-border/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            #{active.meta.number}
          </span>
          {active.meta.url ? (
            <a
              href={active.meta.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex items-center gap-1 rounded-xs px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground'
              )}
            >
              <Github className="h-3.5 w-3.5" />
              <span>{t('mention.issuePr.openOnGitHub', 'Open on GitHub')}</span>
            </a>
          ) : (
            <span />
          )}
        </div>
        <div className="mt-2 flex items-start gap-2">
          <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconClassName)} />
          <p className="min-w-0 break-words text-sm font-medium leading-snug">
            {active.meta.title}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
