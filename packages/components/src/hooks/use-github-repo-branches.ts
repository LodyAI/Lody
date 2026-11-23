import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  githubFetchBranchesFirstPage,
  githubFetchBranchesPage,
  githubSearchBranches,
} from '@lody/shared';
import {
  areChatLandingBranchListsEqual,
  createChatLandingBranchSnapshot,
  getGitHubBranchesCacheId,
  isChatLandingBranchListPartial,
  mergeChatLandingBranches,
  resolveChatLandingBranchSelection,
  type ChatLandingBranchSnapshot,
} from '@/lib/chat-landing-branches';
import { withGitHubTokenRetry } from '@/lib/github-token';
import { githubBranchesCache } from '@/lib/local-storage-cache';

const EMPTY_SNAPSHOT: ChatLandingBranchSnapshot = {
  branches: [],
  defaultBranch: null,
  nextPageUrl: null,
};

export const GITHUB_BRANCH_SEARCH_DEBOUNCE_MS = 250;

export type UseGitHubRepoBranchesOptions = {
  /** False outside the GitHub context; the hook then leaves branch state alone. */
  enabled: boolean;
  workspaceId: string | null | undefined;
  repoFullName: string | null | undefined;
  selectedBranch: string | null;
  setSelectedBranch: Dispatch<SetStateAction<string | null>>;
};

export type UseGitHubRepoBranchesResult = {
  branches: string[];
  defaultBranch: string | null;
  /** More branch pages exist on GitHub than `branches` holds. */
  hasMore: boolean;
  loadingMore: boolean;
  searching: boolean;
  onSearchQueryChange: (query: string) => void;
  onReachEnd: () => void;
};

const sameSnapshot = (left: ChatLandingBranchSnapshot, right: ChatLandingBranchSnapshot) =>
  left.defaultBranch === right.defaultBranch &&
  (left.nextPageUrl ?? null) === (right.nextPageUrl ?? null) &&
  areChatLandingBranchListsEqual(left.branches, right.branches);

const persistSnapshot = (cacheId: string, snapshot: ChatLandingBranchSnapshot) => {
  githubBranchesCache.set(cacheId, {
    branches: snapshot.branches,
    defaultBranch: snapshot.defaultBranch,
    nextPageUrl: snapshot.nextPageUrl ?? null,
    updatedAt: Date.now(),
  });
};

/**
 * Branches of the selected GitHub repository for the chat landing picker. The
 * default branch and the first page arrive together; later pages load when the
 * list is scrolled to its end, and a typed query is resolved on GitHub by
 * branch-name prefix while the listing is still partial.
 */
export function useGitHubRepoBranches({
  enabled,
  workspaceId,
  repoFullName,
  selectedBranch,
  setSelectedBranch,
}: UseGitHubRepoBranchesOptions): UseGitHubRepoBranchesResult {
  const cacheId =
    enabled && workspaceId && repoFullName
      ? getGitHubBranchesCacheId(workspaceId, repoFullName)
      : null;
  const [snapshot, setSnapshot] = useState<ChatLandingBranchSnapshot>(EMPTY_SNAPSHOT);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const cacheIdRef = useRef<string | null>(cacheId);
  const snapshotRef = useRef(snapshot);
  const searchQueryRef = useRef('');
  const pageInFlightRef = useRef(false);
  const searchResultsRef = useRef(new Map<string, string[]>());
  const verifiedSelectionsRef = useRef(new Set<string>());
  // Branches GitHub confirmed through search or selection checks; a refreshed
  // first page keeps them so a confirmed selection stays listed.
  const confirmedBranchesRef = useRef(new Set<string>());

  const applySnapshot = useCallback(
    (next: ChatLandingBranchSnapshot) => {
      snapshotRef.current = next;
      setSnapshot((prev) => (sameSnapshot(prev, next) ? prev : next));
      setSelectedBranch((prev) => {
        const resolved = resolveChatLandingBranchSelection(next, prev);
        return resolved === prev ? prev : resolved;
      });
    },
    [setSelectedBranch]
  );

  useLayoutEffect(() => {
    if (!enabled) return;
    cacheIdRef.current = cacheId;
    pageInFlightRef.current = false;
    searchResultsRef.current = new Map();
    verifiedSelectionsRef.current = new Set();
    confirmedBranchesRef.current = new Set();
    setLoadingMore(false);
    setSearching(false);
    if (!cacheId) {
      snapshotRef.current = EMPTY_SNAPSHOT;
      setSnapshot(EMPTY_SNAPSHOT);
      setSelectedBranch(null);
      return;
    }
    const cached = githubBranchesCache.get(cacheId);
    if (cached) {
      applySnapshot(
        createChatLandingBranchSnapshot(
          cached.branches,
          cached.defaultBranch,
          cached.nextPageUrl ?? null
        )
      );
      return;
    }
    snapshotRef.current = EMPTY_SNAPSHOT;
    setSnapshot(EMPTY_SNAPSHOT);
  }, [applySnapshot, cacheId, enabled, setSelectedBranch]);

  useEffect(() => {
    if (!cacheId || !workspaceId || !repoFullName) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const result = await withGitHubTokenRetry(workspaceId, repoFullName, (token) =>
          githubFetchBranchesFirstPage(token, repoFullName)
        );
        const next = createChatLandingBranchSnapshot(
          result.branches,
          result.defaultBranch,
          result.nextPageUrl
        );
        persistSnapshot(cacheId, next);
        if (cancelled) return;
        applySnapshot(mergeChatLandingBranches(next, [...confirmedBranchesRef.current]));
      } catch (error) {
        if (cancelled) return;
        console.warn('Failed to load repository branches', error);
        setSelectedBranch((prev) => {
          const trimmed = prev?.trim() || null;
          return trimmed === prev ? prev : trimmed;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySnapshot, cacheId, repoFullName, setSelectedBranch, workspaceId]);

  const onReachEnd = useCallback(() => {
    const activeCacheId = cacheIdRef.current;
    const pageUrl = snapshotRef.current.nextPageUrl;
    if (!activeCacheId || !workspaceId || !repoFullName || !pageUrl) return;
    // While a query is typed, the remote prefix search fills the list instead.
    if (pageInFlightRef.current || searchQueryRef.current.trim()) return;
    pageInFlightRef.current = true;
    setLoadingMore(true);
    void withGitHubTokenRetry(workspaceId, repoFullName, (token) =>
      githubFetchBranchesPage(token, repoFullName, pageUrl)
    )
      .then((page) => {
        if (cacheIdRef.current !== activeCacheId) return;
        const next = mergeChatLandingBranches(snapshotRef.current, page.branches, page.nextPageUrl);
        persistSnapshot(activeCacheId, next);
        applySnapshot(next);
      })
      .catch((error: unknown) => {
        console.warn('Failed to load more repository branches', error);
      })
      .finally(() => {
        if (cacheIdRef.current !== activeCacheId) return;
        pageInFlightRef.current = false;
        setLoadingMore(false);
      });
  }, [applySnapshot, repoFullName, workspaceId]);

  const onSearchQueryChange = useCallback((query: string) => {
    searchQueryRef.current = query;
    setSearchQuery(query);
  }, []);

  const hasMore = isChatLandingBranchListPartial(snapshot);

  useEffect(() => {
    const prefix = searchQuery.trim();
    if (!prefix || !cacheId || !workspaceId || !repoFullName || !hasMore) {
      setSearching(false);
      return undefined;
    }
    const known = searchResultsRef.current.get(prefix);
    if (known) {
      setSearching(false);
      applySnapshot(mergeChatLandingBranches(snapshotRef.current, known));
      return undefined;
    }
    let superseded = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void withGitHubTokenRetry(workspaceId, repoFullName, (token) =>
        githubSearchBranches(token, repoFullName, prefix)
      )
        .then((found) => {
          if (cacheIdRef.current !== cacheId) return;
          searchResultsRef.current.set(prefix, found);
          for (const name of found) confirmedBranchesRef.current.add(name);
          applySnapshot(mergeChatLandingBranches(snapshotRef.current, found));
        })
        .catch((error: unknown) => {
          console.warn('Failed to search repository branches', error);
        })
        .finally(() => {
          if (!superseded) setSearching(false);
        });
    }, GITHUB_BRANCH_SEARCH_DEBOUNCE_MS);
    return () => {
      superseded = true;
      clearTimeout(timer);
    };
  }, [applySnapshot, cacheId, hasMore, repoFullName, searchQuery, workspaceId]);

  // A restored or preselected branch beyond the loaded pages is kept until
  // GitHub confirms or denies it, instead of being replaced by the default.
  useEffect(() => {
    const branch = selectedBranch?.trim();
    if (!cacheId || !workspaceId || !repoFullName || !branch) return;
    if (!isChatLandingBranchListPartial(snapshot) || snapshot.branches.includes(branch)) return;
    if (verifiedSelectionsRef.current.has(branch)) return;
    verifiedSelectionsRef.current.add(branch);
    void withGitHubTokenRetry(workspaceId, repoFullName, (token) =>
      githubSearchBranches(token, repoFullName, branch)
    )
      .then((found) => {
        if (cacheIdRef.current !== cacheId) return;
        if (found.includes(branch)) {
          confirmedBranchesRef.current.add(branch);
          applySnapshot(mergeChatLandingBranches(snapshotRef.current, [branch]));
          return;
        }
        setSelectedBranch((prev) =>
          prev?.trim() === branch
            ? resolveChatLandingBranchSelection({ ...snapshotRef.current, nextPageUrl: null }, null)
            : prev
        );
      })
      .catch((error: unknown) => {
        console.warn('Failed to verify the selected repository branch', error);
      });
  }, [
    applySnapshot,
    cacheId,
    repoFullName,
    selectedBranch,
    setSelectedBranch,
    snapshot,
    workspaceId,
  ]);

  return {
    branches: snapshot.branches,
    defaultBranch: snapshot.defaultBranch,
    hasMore,
    loadingMore,
    searching,
    onSearchQueryChange,
    onReachEnd,
  };
}
