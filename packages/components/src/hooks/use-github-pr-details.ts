import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  getServerNow,
  GitHubPermissionError,
  githubBranchExists,
  githubCreatePRIssueComment,
  githubDeleteBranch,
  githubFetchCheckRuns,
  githubFetchPRIssueComments,
  githubFetchPRReviewComments,
  githubFetchPullRequestDetails,
  githubFetchPullRequestReviews,
  githubMarkPullRequestReadyForReview,
  githubMergePullRequest,
  githubSetPullRequestState,
  type GitHubCheckRunsSummary,
  type GitHubIssueComment,
  type GitHubMergeMethod,
  type GitHubPullRequestDetails,
  type GitHubReadRequestOptions,
  type GitHubReview,
  type GitHubReviewThread,
} from '@lody/shared';
import {
  isGitHubUnauthorizedTokenError,
  withGitHubOperationTokenRetry,
  withGitHubTokenRetry,
} from '@/lib/github-token';
import { runWithRetry } from '@/lib/async-retry';
import {
  EMPTY_PR_CACHE_VERSIONS,
  getPrCacheKey,
  readPrCacheEntry,
  writePrCacheEntry,
  type PrCacheEntry,
  type PrCachePayload,
  type PrCacheSliceTimestamps,
} from '@/lib/github-pr-cache';
import {
  isDraftPr,
  isPullRequestMergeabilityPending,
  isPullRequestReadyForReviewTransitionPending,
  mergePullRequestDetailsState,
} from '@/lib/github-pr-details-state';
import { canRunAuthedWorkspaceQuery } from '@/lib/authed-convex-query';
import { useAuthenticatedConvex } from './use-authenticated-convex';
import { useCloudQuery } from '@lody/platform/react';

// Delay before probing whether a merged PR's head branch still exists. GitHub
// auto-deletes head branches asynchronously after a merge (when the repo has
// that setting on), so checking immediately races the delete and flip-flops the
// delete-branch button. Waiting a beat lets that settle before we look.
const BRANCH_PROBE_DELAY_MS = 1500;
// Backoff between retries when a probe fails for a transient reason
// (expired token, rate limit, network blip) rather than a real "branch gone".
const BRANCH_PROBE_RETRY_DELAY_MS = 3000;
// Total probe attempts before giving up for this scheduling round. We stop
// retrying but deliberately leave `branchExists` at null (not false) so a later
// payload refresh can probe again instead of hiding the button forever.
const BRANCH_PROBE_MAX_ATTEMPTS = 3;

export type GitHubPrDetailsState = 'idle' | 'loading' | 'ready' | 'error';

export interface GitHubPrDetailsData {
  pullRequest: GitHubPullRequestDetails;
  reviewThreads: GitHubReviewThread[];
  reviews: GitHubReview[];
  issueComments: GitHubIssueComment[];
  checkRuns: GitHubCheckRunsSummary;
}

export interface UseGitHubPrDetailsResult {
  state: GitHubPrDetailsState;
  data: GitHubPrDetailsData | null;
  error: Error | null;
  checksPermissionError: boolean;
  /** True while any slice is being revalidated in the background. */
  isRevalidating: boolean;
  /** Fetch every slice from GitHub while bypassing the browser HTTP cache. */
  refresh: () => Promise<GitHubPrDetailsData | null>;
  /** Fetch a fresh PR head + its check runs. Rejects instead of returning
   * cached checks when either GitHub read fails. */
  refreshCheckRuns: () => Promise<GitHubPrDetailsData | null>;
  postComment: (body: string) => Promise<void>;
  isPostingComment: boolean;
  mergePullRequest: (method: GitHubMergeMethod) => Promise<void>;
  isMerging: boolean;
  setPullRequestState: (state: 'open' | 'closed') => Promise<void>;
  isUpdatingState: boolean;
  markReadyForReview: () => Promise<void>;
  isMarkingReady: boolean;
  deleteBranch: () => Promise<void>;
  isDeletingBranch: boolean;
  /** `null` while we haven't checked yet (or the check doesn't apply — PR
   *  still open, etc.), `true` when the head ref is confirmed present on
   *  GitHub, `false` when the branch is gone (never existed, already
   *  deleted, or we just deleted it via `deleteBranch`). */
  branchExists: boolean | null;
}

export interface UseGitHubPrDetailsInput {
  workspaceId?: string | null;
  repoFullName?: string | null;
  prNumber?: number | null;
  headCommitSha?: string | null;
  enabled?: boolean;
  /**
   * Whether the consumer is on screen. Polling pauses while it is not, exactly
   * like a hidden tab; the initial fetch and manual refreshes still run. Use
   * this instead of `enabled` so a collapsed panel does not fall back to
   * `loading` and flash on reopen.
   */
  visible?: boolean;
}

const EMPTY_CHECK_RUNS: GitHubCheckRunsSummary = {
  status: 'none',
  conclusion: null,
  total: 0,
  runs: [],
};

const MERGEABILITY_POLL_INTERVAL_MS = 1000;
const READY_FOR_REVIEW_SETTLE_TIMEOUT_MS = 15000;
// Check runs change on GitHub's side with no client push unless the webhook →
// Convex fan-out bumps `checkRunsUpdatedAt` (delayed/absent for repos without
// the Lody GitHub App, and never fired for fork PRs). Poll the check-runs slice
// on a bounded interval for the whole time the PR is open so the info bar CI
// pill converges on its own. The rollup is NOT monotonic — after it settles a
// new workflow (deploy/preview), a re-run, a later-registered required check, or
// a new push (new head SHA) can put CI back in flight — so the poll must NOT
// stop at the first settled verdict; it only tears down when the PR merges/closes
// or the tab is hidden.
const CHECK_RUNS_POLL_INTERVAL_MS = 15000;

/**
 * Thrown when GitHub is still reporting the PR as a draft after the
 * ready-for-review settle timeout. Carries no user-facing copy so the UI layer
 * can localize the message instead of the hook hard-coding English.
 */
export class ReadyForReviewStillDraftError extends Error {
  constructor() {
    super('GitHub is still reporting this pull request as a draft.');
    this.name = 'ReadyForReviewStillDraftError';
  }
}

// After a long idle the Convex JWT may be mid-refresh when a slice fetch fires,
// so the token action transiently returns `unauthorized`. Retry each slice on a
// short schedule first. The recovery supervisor below re-runs the whole load on
// a slower schedule while the root auth flow decides whether the session is
// genuinely expired.
const AUTH_RETRY_BACKOFF_MS = [400, 900, 1600];
const AUTH_RECOVERY_BACKOFF_MS = [1000, 3000, 10_000, 30_000];

export function getAuthRecoveryBackoffMs(attempt: number): number {
  const index = Math.min(attempt, AUTH_RECOVERY_BACKOFF_MS.length - 1);
  return AUTH_RECOVERY_BACKOFF_MS[index] ?? 30_000;
}

async function runPrSliceWithUnauthorizedRetry(
  fetchOnce: () => Promise<void>,
  isStale: () => boolean
): Promise<void> {
  await runWithRetry<void>({
    run: fetchOnce,
    isStale,
    shouldRetry: (error, attempt) => {
      if (isGitHubUnauthorizedTokenError(error) && attempt < AUTH_RETRY_BACKOFF_MS.length) {
        return { retry: true, delayMs: AUTH_RETRY_BACKOFF_MS[attempt] ?? 0 };
      }
      return false;
    },
  });
}

/**
 * One network request per identical GitHub read in flight, across every hook
 * instance: the PR info bar and the PR tab mount their own hooks for the same
 * pull request, and each used to send its own copy of every request.
 */
const sharedGitHubReads = new Map<string, Promise<unknown>>();

function shareGitHubRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const pending = sharedGitHubReads.get(key);
  if (pending) return pending as Promise<T>;
  const request: Promise<T> = read().finally(() => {
    if (sharedGitHubReads.get(key) === request) sharedGitHubReads.delete(key);
  });
  sharedGitHubReads.set(key, request);
  return request;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function createEmptyPayload(): PrCachePayload {
  return {
    pullRequest: null,
    reviewThreads: [],
    reviews: [],
    issueComments: [],
    checkRuns: EMPTY_CHECK_RUNS,
    checksPermissionError: false,
  };
}

function isPayloadReady(payload: PrCachePayload | null): payload is PrCachePayload & {
  pullRequest: GitHubPullRequestDetails;
} {
  return Boolean(payload?.pullRequest);
}

function payloadToData(payload: PrCachePayload | null): GitHubPrDetailsData | null {
  if (!isPayloadReady(payload)) return null;
  return {
    pullRequest: payload.pullRequest,
    reviewThreads: payload.reviewThreads,
    reviews: payload.reviews ?? [],
    issueComments: payload.issueComments,
    checkRuns: payload.checkRuns,
  };
}

type Slice = 'prDetails' | 'reviewComments' | 'reviews' | 'issueComments' | 'checkRuns';
const ALL_SLICES: Slice[] = [
  'prDetails',
  'reviewComments',
  'reviews',
  'issueComments',
  'checkRuns',
];

function sliceToFetchedAtKey(slice: Slice): keyof PrCacheSliceTimestamps {
  switch (slice) {
    case 'prDetails':
      return 'prDetailsFetchedAt';
    case 'reviewComments':
      return 'reviewCommentsFetchedAt';
    case 'reviews':
      return 'reviewsFetchedAt';
    case 'issueComments':
      return 'issueCommentsFetchedAt';
    case 'checkRuns':
      return 'checkRunsFetchedAt';
  }
  throw new Error(`Unknown PR cache slice: ${slice}`);
}

export function useGitHubPrDetails({
  workspaceId,
  repoFullName,
  prNumber,
  headCommitSha,
  enabled = true,
  visible = true,
}: UseGitHubPrDetailsInput): UseGitHubPrDetailsResult {
  const normalizedRepoFullName = repoFullName?.trim() || null;
  const enabledWithInputs = Boolean(
    enabled && workspaceId && normalizedRepoFullName && prNumber && prNumber > 0
  );

  // Gate token fetches on Convex auth readiness. The token action returns
  // `unauthorized` whenever the request lands without a valid session, which is
  // exactly the window right after a long idle while the WS reconnects and the
  // JWT refreshes. Reuse the shared authed-query gate the other authed hooks
  // use so we never fire a doomed request.
  const { isAuthenticated, isLoading: isConvexAuthLoading } = useAuthenticatedConvex();
  const canFetch = enabledWithInputs && canRunAuthedWorkspaceQuery(workspaceId, isAuthenticated);

  const [payload, setPayload] = useState<PrCachePayload | null>(null);
  // The PR `payload`/`state` describe. A switched view keeps the previous PR's
  // values until its cache read lands; they must not render (or enable Merge)
  // as the new PR's.
  const [loadedCacheKey, setLoadedCacheKey] = useState<string | null>(null);
  const [state, setState] = useState<GitHubPrDetailsState>(enabledWithInputs ? 'loading' : 'idle');
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [checksPermissionError, setChecksPermissionError] = useState(false);
  const [isPostingComment, setIsPostingComment] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isUpdatingState, setIsUpdatingState] = useState(false);
  const [isMarkingReady, setIsMarkingReady] = useState(false);
  const [isDeletingBranch, setIsDeletingBranch] = useState(false);
  const [branchExists, setBranchExists] = useState<boolean | null>(null);

  const payloadRef = useRef<PrCachePayload | null>(null);
  const versionsRef = useRef<PrCacheSliceTimestamps>(EMPTY_PR_CACHE_VERSIONS);
  // Tracks the currently running fetch per slice. Lets refresh() (and the
  // convex-driven revalidation) await the existing Promise instead of
  // short-circuiting to a no-op, so the button's loading state stays in sync
  // with whatever's actually in flight.
  const inFlightPromisesRef = useRef<Map<Slice, Promise<void>>>(new Map());
  const cacheKeyRef = useRef<string | null>(null);
  // Survives effect re-runs so "resume from a pause" stays distinguishable from
  // "the effect restarted while still visible".
  const pollPausedRef = useRef(false);
  // Pending delayed branch-existence probe for the current PR view. Cleared on
  // cacheKey change / unmount so a probe scheduled for one PR never lands on
  // another.
  const branchProbeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const branchProbeInFlightRef = useRef(false);
  const branchProbeGenerationRef = useRef(0);
  const cancelPendingBranchProbe = useCallback(() => {
    if (branchProbeTimerRef.current) {
      clearTimeout(branchProbeTimerRef.current);
      branchProbeTimerRef.current = null;
    }
    branchProbeGenerationRef.current += 1;
  }, []);

  const cacheKey =
    enabledWithInputs && workspaceId && normalizedRepoFullName && prNumber
      ? getPrCacheKey(workspaceId, normalizedRepoFullName, prNumber)
      : null;

  // --- Convex subscription for cache invalidation -------------------------
  const serverVersions = useCloudQuery(
    cloudOperations.github.getPrCacheVersions,
    enabledWithInputs && workspaceId && normalizedRepoFullName && prNumber
      ? { workspaceId, repoFullName: normalizedRepoFullName, prNumber }
      : 'skip'
  );

  // --- Hydration from IDB on (re)mount ------------------------------------
  useEffect(() => {
    if (!enabledWithInputs || !workspaceId || !normalizedRepoFullName || !prNumber) {
      setPayload(null);
      setLoadedCacheKey(null);
      payloadRef.current = null;
      versionsRef.current = EMPTY_PR_CACHE_VERSIONS;
      cacheKeyRef.current = null;
      inFlightPromisesRef.current.clear();
      setState('idle');
      setBranchExists(null);
      cancelPendingBranchProbe();
      setError(null);
      setChecksPermissionError(false);
      setIsPostingComment(false);
      setIsMerging(false);
      setIsUpdatingState(false);
      setIsMarkingReady(false);
      setIsDeletingBranch(false);
      return undefined;
    }
    let cancelled = false;
    cacheKeyRef.current = cacheKey;
    setBranchExists(null);
    setError(null);
    setChecksPermissionError(false);
    setIsPostingComment(false);
    setIsMerging(false);
    setIsUpdatingState(false);
    setIsMarkingReady(false);
    setIsDeletingBranch(false);
    // A pending fetch against the previous cacheKey will ignore its own writes
    // thanks to the `cacheKeyRef.current !== cacheKey` guard inside fetchSlice,
    // but its Promise is still held in `inFlightPromisesRef`. Clear it so the
    // new fetchSlice call below isn't deduped onto the abandoned fetch.
    inFlightPromisesRef.current.clear();
    void (async () => {
      const entry = await readPrCacheEntry(workspaceId, normalizedRepoFullName, prNumber);
      if (cancelled || cacheKeyRef.current !== cacheKey) return;
      setLoadedCacheKey(cacheKey);
      if (entry) {
        payloadRef.current = entry.payload;
        versionsRef.current = entry.versions;
        setPayload(entry.payload);
        setChecksPermissionError(entry.payload.checksPermissionError);
        setState(isPayloadReady(entry.payload) ? 'ready' : 'loading');
      } else {
        payloadRef.current = null;
        versionsRef.current = EMPTY_PR_CACHE_VERSIONS;
        setPayload(null);
        setChecksPermissionError(false);
        setState('loading');
      }
    })();
    return () => {
      cancelled = true;
      cancelPendingBranchProbe();
    };
  }, [
    cacheKey,
    cancelPendingBranchProbe,
    enabledWithInputs,
    normalizedRepoFullName,
    prNumber,
    workspaceId,
  ]);

  // --- Fetchers for individual slices -------------------------------------
  const writeCache = useCallback(
    (
      nextPayload: PrCachePayload,
      nextVersions: PrCacheSliceTimestamps,
      targetWorkspaceId: string,
      targetRepo: string,
      targetPrNumber: number
    ) => {
      const targetCacheKey = getPrCacheKey(targetWorkspaceId, targetRepo, targetPrNumber);
      const isCurrentTarget = cacheKeyRef.current === targetCacheKey;
      if (isCurrentTarget) {
        payloadRef.current = nextPayload;
        versionsRef.current = nextVersions;
        setPayload(nextPayload);
        setLoadedCacheKey(targetCacheKey);
      }
      const entry: PrCacheEntry = {
        workspaceId: targetWorkspaceId,
        repoFullName: targetRepo,
        prNumber: targetPrNumber,
        payload: nextPayload,
        versions: nextVersions,
        lastWriteAt: Date.now(),
      };
      void writePrCacheEntry(entry);
    },
    []
  );

  // Probe whether the merged PR's head branch still exists on GitHub, gating the
  // delete-branch button. Held behind a ref so `scheduleBranchProbe` stays
  // dependency-free while still calling the latest closure.
  const runBranchProbeRef = useRef<() => void>(() => {});
  const scheduleBranchProbe = useCallback((delayMs: number) => {
    if (branchProbeTimerRef.current) {
      clearTimeout(branchProbeTimerRef.current);
    }
    branchProbeTimerRef.current = setTimeout(() => {
      branchProbeTimerRef.current = null;
      runBranchProbeRef.current();
    }, delayMs);
  }, []);
  const runBranchProbe = useCallback(async () => {
    if (branchProbeInFlightRef.current) return;
    if (!canFetch || !workspaceId || !normalizedRepoFullName || !prNumber) return;
    const targetCacheKey = cacheKeyRef.current;
    const targetGeneration = branchProbeGenerationRef.current;
    const pr = payloadRef.current?.pullRequest;
    if (!pr?.merged) return;
    const headRef = pr.headRef.trim();
    if (!headRef || headRef === pr.baseRef) return;
    branchProbeInFlightRef.current = true;
    try {
      const exists = await runWithRetry<boolean | null>({
        run: () =>
          withGitHubTokenRetry(workspaceId, normalizedRepoFullName, (token) =>
            githubBranchExists(token, normalizedRepoFullName, headRef)
          ),
        isStale: () =>
          cacheKeyRef.current !== targetCacheKey ||
          branchProbeGenerationRef.current !== targetGeneration,
        staleResult: () => null,
        shouldRetry: (_error, attempt) =>
          attempt < BRANCH_PROBE_MAX_ATTEMPTS - 1
            ? { retry: true, delayMs: BRANCH_PROBE_RETRY_DELAY_MS }
            : false,
      });
      if (exists === null) return;
      if (cacheKeyRef.current !== targetCacheKey) return;
      setBranchExists(exists);
    } catch {
      if (cacheKeyRef.current !== targetCacheKey) return;
      // Transient failures (expired token, rate limit, network blip) leave
      // `branchExists` at null so a later payload refresh can probe again
      // rather than hiding the delete-branch button forever.
    } finally {
      branchProbeInFlightRef.current = false;
    }
  }, [canFetch, normalizedRepoFullName, prNumber, workspaceId]);
  useEffect(() => {
    runBranchProbeRef.current = () => void runBranchProbe();
  }, [runBranchProbe]);

  const fetchSlice = useCallback(
    (slice: Slice, requestOptions?: GitHubReadRequestOptions): Promise<void> => {
      if (!workspaceId || !normalizedRepoFullName || !prNumber || !cacheKey) {
        return Promise.resolve();
      }
      const targetCacheKey = cacheKey;
      const existing = inFlightPromisesRef.current.get(slice);
      if (existing) return existing;
      setIsRevalidating(true);
      let promise: Promise<void>;
      const run = async (): Promise<void> => {
        const fetchOnce = (): Promise<void> =>
          withGitHubTokenRetry(workspaceId, normalizedRepoFullName, async (token) => {
            if (cacheKeyRef.current !== targetCacheKey) return;
            switch (slice) {
              case 'prDetails': {
                const fetchedPullRequest = await shareGitHubRead(
                  `prDetails:${workspaceId}:${normalizedRepoFullName}#${prNumber}:${requestOptions?.cache ?? ''}`,
                  () =>
                    githubFetchPullRequestDetails(
                      token,
                      normalizedRepoFullName,
                      prNumber,
                      requestOptions
                    )
                );
                if (cacheKeyRef.current !== targetCacheKey) return;
                const prev = payloadRef.current ?? createEmptyPayload();
                const pullRequest = mergePullRequestDetailsState(
                  prev.pullRequest,
                  fetchedPullRequest
                );
                const next: PrCachePayload = { ...prev, pullRequest };
                const nextVersions: PrCacheSliceTimestamps = {
                  ...versionsRef.current,
                  prDetailsFetchedAt: getServerNow(),
                };
                writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
                break;
              }
              case 'reviewComments': {
                const reviewThreads = await shareGitHubRead(
                  `reviewComments:${workspaceId}:${normalizedRepoFullName}#${prNumber}:${requestOptions?.cache ?? ''}`,
                  () =>
                    githubFetchPRReviewComments(
                      token,
                      normalizedRepoFullName,
                      prNumber,
                      requestOptions
                    )
                );
                if (cacheKeyRef.current !== targetCacheKey) return;
                const prev = payloadRef.current ?? createEmptyPayload();
                const next: PrCachePayload = { ...prev, reviewThreads };
                const nextVersions: PrCacheSliceTimestamps = {
                  ...versionsRef.current,
                  reviewCommentsFetchedAt: getServerNow(),
                };
                writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
                break;
              }
              case 'reviews': {
                const reviews = await shareGitHubRead(
                  `reviews:${workspaceId}:${normalizedRepoFullName}#${prNumber}:${requestOptions?.cache ?? ''}`,
                  () =>
                    githubFetchPullRequestReviews(
                      token,
                      normalizedRepoFullName,
                      prNumber,
                      requestOptions
                    )
                );
                if (cacheKeyRef.current !== targetCacheKey) return;
                const prev = payloadRef.current ?? createEmptyPayload();
                const next: PrCachePayload = { ...prev, reviews };
                const nextVersions: PrCacheSliceTimestamps = {
                  ...versionsRef.current,
                  reviewsFetchedAt: getServerNow(),
                };
                writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
                break;
              }
              case 'issueComments': {
                const issueComments = await shareGitHubRead(
                  `issueComments:${workspaceId}:${normalizedRepoFullName}#${prNumber}:${requestOptions?.cache ?? ''}`,
                  () =>
                    githubFetchPRIssueComments(
                      token,
                      normalizedRepoFullName,
                      prNumber,
                      requestOptions
                    )
                );
                if (cacheKeyRef.current !== targetCacheKey) return;
                const prev = payloadRef.current ?? createEmptyPayload();
                const next: PrCachePayload = { ...prev, issueComments };
                const nextVersions: PrCacheSliceTimestamps = {
                  ...versionsRef.current,
                  issueCommentsFetchedAt: getServerNow(),
                };
                writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
                break;
              }
              case 'checkRuns': {
                if (cacheKeyRef.current !== targetCacheKey) return;
                const ref = payloadRef.current?.pullRequest?.headSha || headCommitSha?.trim() || '';
                if (!ref) return;
                try {
                  const checkRuns = await shareGitHubRead(
                    `checkRuns:${workspaceId}:${normalizedRepoFullName}@${ref}:${requestOptions?.cache ?? ''}`,
                    () => githubFetchCheckRuns(token, normalizedRepoFullName, ref, requestOptions)
                  );
                  if (cacheKeyRef.current !== targetCacheKey) return;
                  const prev = payloadRef.current ?? createEmptyPayload();
                  const next: PrCachePayload = {
                    ...prev,
                    checkRuns,
                    checksPermissionError: false,
                  };
                  const nextVersions: PrCacheSliceTimestamps = {
                    ...versionsRef.current,
                    checkRunsFetchedAt: getServerNow(),
                  };
                  writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
                  setChecksPermissionError(false);
                } catch (err) {
                  if (cacheKeyRef.current !== targetCacheKey) return;
                  if (err instanceof GitHubPermissionError) {
                    const prev = payloadRef.current ?? createEmptyPayload();
                    const next: PrCachePayload = { ...prev, checksPermissionError: true };
                    const nextVersions: PrCacheSliceTimestamps = {
                      ...versionsRef.current,
                      checkRunsFetchedAt: getServerNow(),
                    };
                    writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
                    setChecksPermissionError(true);
                  } else {
                    throw err;
                  }
                }
                break;
              }
            }
          });
        try {
          await runPrSliceWithUnauthorizedRetry(
            fetchOnce,
            () => cacheKeyRef.current !== targetCacheKey
          );
          if (cacheKeyRef.current === targetCacheKey && isPayloadReady(payloadRef.current)) {
            setState('ready');
            setError(null);
          }
        } catch (err) {
          if (cacheKeyRef.current !== targetCacheKey) return;
          // Record the failure after the per-slice retries are exhausted. Auth
          // failures are picked up by the recovery supervisor below; other
          // failures still surface through the ordinary error state.
          setError(err instanceof Error ? err : new Error(String(err)));
          if (!isPayloadReady(payloadRef.current)) {
            setState('error');
          }
        } finally {
          if (inFlightPromisesRef.current.get(slice) === promise) {
            inFlightPromisesRef.current.delete(slice);
            if (inFlightPromisesRef.current.size === 0 && cacheKeyRef.current === targetCacheKey) {
              setIsRevalidating(false);
            }
          }
        }
      };
      promise = run();
      inFlightPromisesRef.current.set(slice, promise);
      return promise;
    },
    [cacheKey, headCommitSha, normalizedRepoFullName, prNumber, workspaceId, writeCache]
  );

  // --- Revalidation on mount (principle #1: click-to-open ⇒ latest) -------
  useEffect(() => {
    if (!canFetch || !cacheKey) return;
    // Always refetch prDetails first so checkRuns can use the fresh headSha.
    void (async () => {
      await fetchSlice('prDetails');
      await Promise.all([
        fetchSlice('reviewComments'),
        fetchSlice('reviews'),
        fetchSlice('issueComments'),
        fetchSlice('checkRuns'),
      ]);
    })();
  }, [cacheKey, canFetch, fetchSlice]);

  // GitHub computes `mergeable` asynchronously. There is no webhook for the
  // background job completing, so keep polling the PR details while the merge
  // box is in the "checking" state.
  useEffect(() => {
    if (!canFetch || !cacheKey || !visible) return undefined;
    if (!isPullRequestMergeabilityPending(payload?.pullRequest)) return undefined;

    const intervalId = window.setInterval(() => {
      void fetchSlice('prDetails');
    }, MERGEABILITY_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [cacheKey, canFetch, fetchSlice, payload?.pullRequest, visible]);

  // GitHub check runs change asynchronously and, when the webhook fan-out is
  // delayed/absent, without any client push. Keep polling the check-runs slice
  // (head SHA re-read via a prDetails refresh first) for the whole time the PR
  // is open — NOT only while the rollup is queued/in_progress — because CI is
  // not monotonic: a settled rollup can flip back to running when a new workflow
  // starts, a check is re-run, a required check is registered late, or a new
  // commit is pushed. Depend on stable open/closed booleans (not the whole
  // `pullRequest` object, which is a fresh reference after every prDetails poll)
  // so the interval isn't torn down and recreated on its own refresh. Pause
  // whenever nobody is watching — a hidden tab or a consumer that reported
  // `visible: false` — and catch up immediately on resume, to avoid burning
  // GitHub quota while the PR view is off screen.
  const prMerged = payload?.pullRequest?.merged ?? false;
  const prState = payload?.pullRequest?.state;
  useEffect(() => {
    if (!canFetch || !cacheKey) return undefined;
    if (!prState || prMerged || prState === 'closed') return undefined;

    let intervalId: number | null = null;
    const poll = () => {
      void (async () => {
        await fetchSlice('prDetails', { cache: 'reload' });
        await fetchSlice('checkRuns', { cache: 'reload' });
      })();
    };
    const isWatched = () => visible && !document.hidden;
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const pause = () => {
      pollPausedRef.current = true;
      stop();
    };
    const resume = () => {
      // Only catch up after an actual pause; a plain effect re-run (new
      // `fetchSlice` identity) must not fire an extra pair of requests.
      if (pollPausedRef.current) {
        pollPausedRef.current = false;
        poll();
      }
      if (intervalId === null) intervalId = window.setInterval(poll, CHECK_RUNS_POLL_INTERVAL_MS);
    };
    const onWatchedChange = () => {
      if (isWatched()) resume();
      else pause();
    };

    onWatchedChange();
    document.addEventListener('visibilitychange', onWatchedChange);

    return () => {
      document.removeEventListener('visibilitychange', onWatchedChange);
      stop();
    };
  }, [cacheKey, canFetch, fetchSlice, prMerged, prState, visible]);

  // --- Per-slice invalidation from Convex ---------------------------------
  useEffect(() => {
    if (!serverVersions || !cacheKey || !isAuthenticated) return;
    const serverMap: Record<Slice, number | null> = {
      prDetails: serverVersions.prDetailsUpdatedAt ?? null,
      reviewComments: serverVersions.reviewCommentsUpdatedAt ?? null,
      reviews: serverVersions.reviewsUpdatedAt ?? null,
      issueComments: serverVersions.issueCommentsUpdatedAt ?? null,
      checkRuns: serverVersions.checkRunsUpdatedAt ?? null,
    };
    for (const slice of ALL_SLICES) {
      const serverTs = serverMap[slice];
      const localTs = versionsRef.current[sliceToFetchedAtKey(slice)];
      if (serverTs == null) continue;
      if (localTs != null && serverTs <= localTs) continue;
      void fetchSlice(slice);
    }
  }, [cacheKey, fetchSlice, isAuthenticated, serverVersions]);

  // --- Public refresh() ---------------------------------------------------
  const refresh = useCallback(async () => {
    const requestOptions: GitHubReadRequestOptions = { cache: 'reload' };
    await fetchSlice('prDetails', requestOptions);
    await Promise.all([
      fetchSlice('reviewComments', requestOptions),
      fetchSlice('reviews', requestOptions),
      fetchSlice('issueComments', requestOptions),
      fetchSlice('checkRuns', requestOptions),
    ]);
    return payloadToData(payloadRef.current);
  }, [fetchSlice]);

  const fetchCurrentPullRequestDetails = useCallback(
    async (targetCacheKey: string): Promise<GitHubPullRequestDetails | null> => {
      if (!workspaceId || !normalizedRepoFullName || !prNumber) return null;
      const fetchedPullRequest = await withGitHubOperationTokenRetry(
        workspaceId,
        normalizedRepoFullName,
        'read',
        (token) =>
          githubFetchPullRequestDetails(token, normalizedRepoFullName, prNumber, {
            cache: 'reload',
          })
      );
      if (cacheKeyRef.current !== targetCacheKey) return null;
      const prev = payloadRef.current ?? createEmptyPayload();
      const pullRequest = mergePullRequestDetailsState(prev.pullRequest, fetchedPullRequest);
      const next: PrCachePayload = { ...prev, pullRequest };
      const nextVersions: PrCacheSliceTimestamps = {
        ...versionsRef.current,
        prDetailsFetchedAt: getServerNow(),
      };
      writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
      return pullRequest;
    },
    [normalizedRepoFullName, prNumber, workspaceId, writeCache]
  );

  const refreshCheckRuns = useCallback(async (): Promise<GitHubPrDetailsData | null> => {
    if (!workspaceId || !normalizedRepoFullName || !prNumber || !cacheKey) return null;
    const targetCacheKey = cacheKey;
    const pullRequest = await fetchCurrentPullRequestDetails(targetCacheKey);
    if (!pullRequest) return null;
    try {
      const checkRuns = await withGitHubOperationTokenRetry(
        workspaceId,
        normalizedRepoFullName,
        'read',
        (token) =>
          githubFetchCheckRuns(token, normalizedRepoFullName, pullRequest.headSha, {
            cache: 'reload',
          })
      );
      if (cacheKeyRef.current !== targetCacheKey) return null;
      const prev = payloadRef.current ?? createEmptyPayload();
      const next: PrCachePayload = {
        ...prev,
        pullRequest,
        checkRuns,
        checksPermissionError: false,
      };
      const nextVersions: PrCacheSliceTimestamps = {
        ...versionsRef.current,
        checkRunsFetchedAt: getServerNow(),
      };
      writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
      setChecksPermissionError(false);
      return payloadToData(next);
    } catch (caughtError) {
      if (cacheKeyRef.current === targetCacheKey && caughtError instanceof GitHubPermissionError) {
        setChecksPermissionError(true);
      }
      throw caughtError;
    }
  }, [
    cacheKey,
    fetchCurrentPullRequestDetails,
    normalizedRepoFullName,
    prNumber,
    workspaceId,
    writeCache,
  ]);

  // --- Mutations ----------------------------------------------------------
  const postComment = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed || !workspaceId || !normalizedRepoFullName || !prNumber || !cacheKey) return;
      const targetCacheKey = cacheKey;
      setIsPostingComment(true);
      try {
        const comment = await withGitHubOperationTokenRetry(
          workspaceId,
          normalizedRepoFullName,
          'write',
          (token) => githubCreatePRIssueComment(token, normalizedRepoFullName, prNumber, trimmed)
        );
        if (cacheKeyRef.current !== targetCacheKey) return;
        const prev = payloadRef.current;
        if (prev) {
          const next: PrCachePayload = {
            ...prev,
            issueComments: [...prev.issueComments, comment],
          };
          const nextVersions: PrCacheSliceTimestamps = {
            ...versionsRef.current,
            issueCommentsFetchedAt: getServerNow(),
          };
          writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
        }
      } catch (err) {
        if (cacheKeyRef.current !== targetCacheKey) return;
        throw err;
      } finally {
        if (cacheKeyRef.current === targetCacheKey) {
          setIsPostingComment(false);
        }
      }
    },
    [cacheKey, normalizedRepoFullName, prNumber, workspaceId, writeCache]
  );

  const mergePullRequest = useCallback(
    async (method: GitHubMergeMethod) => {
      if (!workspaceId || !normalizedRepoFullName || !prNumber || !cacheKey) return;
      const targetCacheKey = cacheKey;
      setIsMerging(true);
      try {
        const currentPullRequest = await fetchCurrentPullRequestDetails(targetCacheKey);
        if (!currentPullRequest) return;
        const result = await withGitHubOperationTokenRetry(
          workspaceId,
          normalizedRepoFullName,
          'write',
          (token) =>
            githubMergePullRequest(token, normalizedRepoFullName, prNumber, {
              method,
              sha: currentPullRequest.headSha,
            })
        );
        if (cacheKeyRef.current !== targetCacheKey) return;
        // Apply the authoritative merged signal from PUT /merge. We deliberately
        // do NOT call refresh() here: GitHub's GET /pulls/{n} has a short cache
        // window where it still returns merged=false right after the merge
        // succeeds, which would clobber this update. The webhook-driven Convex
        // subscription pulls fresh data once GitHub catches up.
        const prev = payloadRef.current;
        if (prev?.pullRequest && result.merged) {
          const mergedAt = new Date().toISOString();
          const next: PrCachePayload = {
            ...prev,
            pullRequest: {
              ...prev.pullRequest,
              merged: true,
              state: 'closed',
              mergedAt,
              closedAt: prev.pullRequest.closedAt ?? mergedAt,
            },
          };
          const nextVersions: PrCacheSliceTimestamps = {
            ...versionsRef.current,
            prDetailsFetchedAt: getServerNow(),
          };
          writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
          // The merge may have triggered GitHub's auto-delete of the head
          // branch. Re-probe (deferred, so the delete has time to land) to
          // refresh the delete-branch button now that the PR is merged.
          branchProbeGenerationRef.current += 1;
          scheduleBranchProbe(BRANCH_PROBE_DELAY_MS);
        }
      } catch (err) {
        if (cacheKeyRef.current !== targetCacheKey) return;
        throw err;
      } finally {
        if (cacheKeyRef.current === targetCacheKey) {
          setIsMerging(false);
        }
      }
    },
    [
      cacheKey,
      fetchCurrentPullRequestDetails,
      normalizedRepoFullName,
      prNumber,
      scheduleBranchProbe,
      workspaceId,
      writeCache,
    ]
  );

  const setPullRequestState = useCallback(
    async (nextState: 'open' | 'closed') => {
      if (!workspaceId || !normalizedRepoFullName || !prNumber || !cacheKey) return;
      const targetCacheKey = cacheKey;
      setIsUpdatingState(true);
      try {
        const pullRequest = await withGitHubOperationTokenRetry(
          workspaceId,
          normalizedRepoFullName,
          'write',
          (token) => githubSetPullRequestState(token, normalizedRepoFullName, prNumber, nextState)
        );
        if (cacheKeyRef.current !== targetCacheKey) return;
        const prev = payloadRef.current;
        if (prev) {
          const next: PrCachePayload = { ...prev, pullRequest };
          const nextVersions: PrCacheSliceTimestamps = {
            ...versionsRef.current,
            prDetailsFetchedAt: getServerNow(),
          };
          writeCache(next, nextVersions, workspaceId, normalizedRepoFullName, prNumber);
        }
      } catch (err) {
        if (cacheKeyRef.current !== targetCacheKey) return;
        throw err;
      } finally {
        if (cacheKeyRef.current === targetCacheKey) {
          setIsUpdatingState(false);
        }
      }
    },
    [cacheKey, normalizedRepoFullName, prNumber, workspaceId, writeCache]
  );

  const markReadyForReview = useCallback(async () => {
    if (!workspaceId || !normalizedRepoFullName || !prNumber || !cacheKey) return;
    const targetCacheKey = cacheKey;
    const currentPullRequest = payloadRef.current?.pullRequest;
    const pullRequestNodeId = currentPullRequest?.nodeId;
    if (!pullRequestNodeId) return;
    setIsMarkingReady(true);
    try {
      await withGitHubOperationTokenRetry(workspaceId, normalizedRepoFullName, 'write', (token) =>
        githubMarkPullRequestReadyForReview(token, pullRequestNodeId)
      );
      if (cacheKeyRef.current !== targetCacheKey) return;

      const startedAt = getServerNow();
      for (;;) {
        const pullRequest = await fetchCurrentPullRequestDetails(targetCacheKey);
        if (cacheKeyRef.current !== targetCacheKey) return;
        const latestPullRequest = pullRequest ?? payloadRef.current?.pullRequest ?? null;
        if (!isPullRequestReadyForReviewTransitionPending(latestPullRequest)) return;

        if (getServerNow() - startedAt >= READY_FOR_REVIEW_SETTLE_TIMEOUT_MS) {
          if (latestPullRequest != null && isDraftPr(latestPullRequest)) {
            throw new ReadyForReviewStillDraftError();
          }
          return;
        }

        await delay(MERGEABILITY_POLL_INTERVAL_MS);
        if (cacheKeyRef.current !== targetCacheKey) return;
      }
    } catch (err) {
      if (cacheKeyRef.current !== targetCacheKey) return;
      throw err;
    } finally {
      if (cacheKeyRef.current === targetCacheKey) {
        setIsMarkingReady(false);
      }
    }
  }, [cacheKey, fetchCurrentPullRequestDetails, normalizedRepoFullName, prNumber, workspaceId]);

  const deleteBranch = useCallback(async () => {
    if (!workspaceId || !normalizedRepoFullName || !prNumber || !cacheKey) return;
    const targetCacheKey = cacheKey;
    const headRef = payloadRef.current?.pullRequest?.headRef?.trim();
    if (!headRef) return;
    setIsDeletingBranch(true);
    try {
      await withGitHubOperationTokenRetry(workspaceId, normalizedRepoFullName, 'write', (token) =>
        githubDeleteBranch(token, normalizedRepoFullName, headRef)
      );
      if (cacheKeyRef.current !== targetCacheKey) return;
      // Branch is gone now; drop any pending probe so it can't race back a
      // stale "still exists" and re-show the button.
      cancelPendingBranchProbe();
      setBranchExists(false);
    } catch (err) {
      if (cacheKeyRef.current !== targetCacheKey) return;
      throw err;
    } finally {
      if (cacheKeyRef.current === targetCacheKey) {
        setIsDeletingBranch(false);
      }
    }
  }, [cacheKey, cancelPendingBranchProbe, normalizedRepoFullName, prNumber, workspaceId]);

  // Schedule the head-branch probe for merged PRs — the actual fetch + retry
  // lives in runBranchProbe; here we just decide when to (re)start it. We defer
  // rather than probe inline so GitHub's post-merge auto-delete has time to
  // settle (see BRANCH_PROBE_DELAY_MS). Fires once per PR: `branchExists` is
  // reset to `null` on cacheKey change (hydration effect above), and a probe
  // already in flight (timer pending) isn't double-scheduled.
  useEffect(() => {
    if (!canFetch || !workspaceId || !normalizedRepoFullName || !prNumber) return undefined;
    if (branchExists !== null) return undefined;
    if (branchProbeTimerRef.current || branchProbeInFlightRef.current) return undefined;
    const pr = payload?.pullRequest;
    if (!pr?.merged) return undefined;
    const headRef = pr.headRef.trim();
    if (!headRef || headRef === pr.baseRef) return undefined;
    branchProbeGenerationRef.current += 1;
    scheduleBranchProbe(BRANCH_PROBE_DELAY_MS);
    return undefined;
  }, [
    branchExists,
    canFetch,
    normalizedRepoFullName,
    payload,
    prNumber,
    scheduleBranchProbe,
    workspaceId,
  ]);

  // Convex can briefly look unauthenticated after a long idle while the
  // BetterAuth cookie is still valid. Keep that transition inside the loading
  // state: this hook owns token refresh + retry, while RootApp owns the only
  // confirmed-expiry redirect in the product.
  const payloadIsCurrent = loadedCacheKey === cacheKey;
  const data = payloadToData(payloadIsCurrent ? payload : null);
  const settledUnauthenticated = enabledWithInputs && !isConvexAuthLoading && !isAuthenticated;
  const unauthedAndEmpty = settledUnauthenticated && !data;
  const hasUnauthorizedError = error !== null && isGitHubUnauthorizedTokenError(error);
  const recoverableAuthError = (unauthedAndEmpty || hasUnauthorizedError) && !data;
  const currentState: GitHubPrDetailsState = payloadIsCurrent
    ? state
    : cacheKey !== null
      ? 'loading'
      : 'idle';
  const effectiveState: GitHubPrDetailsState = recoverableAuthError ? 'loading' : currentState;

  // Silent recovery from an apparent session expiry. Each refresh goes through
  // runActionWithUnauthorizedRetry, which mints a fresh Convex JWT from the
  // BetterAuth cookie; GitHub 401s also invalidate and refresh their repo token
  // in withGitHubTokenRetry. Keep retrying with a capped backoff until data is
  // available, this PR view is replaced, or RootApp confirms expiry and unmounts
  // the view. No user click participates in this recovery path.
  useEffect(() => {
    if (!enabledWithInputs || !cacheKey) return undefined;
    if (!recoverableAuthError) return undefined;
    const targetCacheKey = cacheKey;
    let cancelled = false;
    let attempt = 0;
    let retryTimeoutId: number | null = null;

    const recover = async () => {
      await refresh();
      if (
        cancelled ||
        cacheKeyRef.current !== targetCacheKey ||
        isPayloadReady(payloadRef.current)
      ) {
        return;
      }
      const delayMs = getAuthRecoveryBackoffMs(attempt);
      attempt += 1;
      retryTimeoutId = window.setTimeout(() => {
        retryTimeoutId = null;
        void recover();
      }, delayMs);
    };

    void recover();

    return () => {
      cancelled = true;
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [cacheKey, enabledWithInputs, recoverableAuthError, refresh]);

  return {
    state: effectiveState,
    data,
    error,
    checksPermissionError,
    isRevalidating,
    refresh,
    refreshCheckRuns,
    postComment,
    isPostingComment,
    mergePullRequest,
    isMerging,
    setPullRequestState,
    isUpdatingState,
    markReadyForReview,
    isMarkingReady,
    deleteBranch,
    isDeletingBranch,
    branchExists,
  };
}
