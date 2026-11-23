/**
 * Session pull-request field types and pure helpers shared by the session
 * schema, the PR reconciler, and boot-path consumers (session list atoms,
 * notification presentation). Kept free of loro/loro-mirror imports so the
 * renderer's boot chunk can consume these without pulling the loro graph;
 * `schema.ts` re-exports the whole module, so existing `@lody/shared` imports
 * are unaffected.
 */

export type PrStatus = 'open' | 'closed' | 'merged' | 'draft';

export type SessionPullRequestMeta = {
  url: string;
  status: PrStatus;
};

export type SessionPullRequestLegacyMetaFields = {
  /** Deprecated legacy detail. New writes derive this from `url` when needed. */
  number?: number;
  /** Deprecated legacy detail. New writes derive this from `url` or session project when needed. */
  repository?: string;
  /** Deprecated legacy detail. Branch lives on `SessionMeta.branchName` / `ProjectRef`. */
  branch?: string;
  /** Deprecated legacy detail. PR details cache should provide the head SHA when needed. */
  headCommitSha?: string;
  /** Deprecated legacy ordering detail. New writes keep array order instead. */
  reportedAt?: string;
};

export type SessionPullRequestMetaWithLegacy = SessionPullRequestMeta &
  Partial<SessionPullRequestLegacyMetaFields>;

export function getSessionPullRequestLegacyFields(
  pr: SessionPullRequestMeta | null | undefined
): Partial<SessionPullRequestLegacyMetaFields> {
  return (pr ?? {}) as Partial<SessionPullRequestLegacyMetaFields>;
}

export function normalizeSessionPullRequestMeta(value: unknown): SessionPullRequestMeta | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  const status = record.status;
  if (
    !url ||
    (status !== 'open' && status !== 'closed' && status !== 'merged' && status !== 'draft')
  ) {
    return null;
  }
  return { url, status };
}

/**
 * Auto delivery progress. `pr`: waiting for the requested pull request; `ci`:
 * waiting for checks; `fix`/`conflict`/`merge`: the matching request was sent;
 * `ready`: checks passed and merge is left to the user; `stalled`: Lody stopped
 * and needs the user, with `reason`.
 */
export type SessionAutoDeliveryState =
  | 'pr'
  | 'ci'
  | 'fix'
  | 'conflict'
  | 'merge'
  | 'ready'
  | 'merged'
  | 'stalled';

export type SessionAutoDeliveryStallReason =
  | 'ci_failed'
  | 'ci_limit'
  | 'conflicts'
  | 'conflict_limit'
  | 'no_new_commit'
  | 'merge_blocked'
  | 'merge_behind'
  | 'merge_failed'
  | 'pr_closed'
  | 'pr_draft'
  | 'pr_not_created'
  | 'multiple_prs'
  | 'workspace_unpushed'
  | 'stopped'
  | 'request_failed';

export type SessionAutoDelivery = {
  state: SessionAutoDeliveryState;
  /** 1-based count of the current kind of request (`fix` or `conflict`). */
  attempt?: number;
  reason?: SessionAutoDeliveryStallReason;
  prUrl?: string;
  updatedAt: number;
};

/** Rollup CI state of a PR's head commit: success/failure/pending/error/expected. */
export type SessionPullRequestCiState = 's' | 'f' | 'p' | 'e' | 'x';

/**
 * Merge readiness reported by the provider (GitHub `mergeStateStatus`):
 * clean / blocked (protection rules) / dirty (conflicts) / behind (needs
 * rebase) / unstable (checks failing but mergeable). Absent = unknown
 * (provider still computing); drafts are already covered by `PrStatus`.
 */
export type SessionPullRequestMergeState = 'c' | 'b' | 'd' | 'h' | 'u';

/**
 * Product-level merge readiness. `y` means the PR is cleanly mergeable with
 * successful or no CI. Legacy: the CLI poller used to compute this (factoring
 * in review decision and unresolved review threads) and write it as `r`; the
 * reconciler no longer writes `r` and deletes it on touch, so consumers must
 * derive readiness from `s`/`m` via `deriveSessionPullRequestReadiness`.
 */
export type SessionPullRequestReadiness = 'y' | 'n';

/**
 * Compact per-PR CI + merge/readiness record synced by the CLI PR poller.
 * Single-letter codes keep one entry under 50B — repo meta is costly sync state
 * and the budget for these signals together is 50B (see plan
 * `plans/20260717-cli-pr-status-poller.md` §5). `t` is the epoch SECOND of
 * the last change to `s`, `m`, or `r` (not of the last poll).
 */
export type SessionPullRequestStateMeta = {
  s?: SessionPullRequestCiState;
  m?: SessionPullRequestMergeState;
  r?: SessionPullRequestReadiness;
  t: number;
};

/**
 * Derive merge readiness from the poller-synced CI (`s`) and merge (`m`)
 * codes. A PR is ready when GitHub reports a clean merge state and CI is
 * either successful or absent. The legacy `r` field is intentionally ignored:
 * nothing writes it anymore and a stale value must not authorize a merge.
 */
export function deriveSessionPullRequestReadiness(
  state: SessionPullRequestStateMeta | null | undefined
): SessionPullRequestReadiness | null {
  if (!state || state.m !== 'c') {
    return null;
  }
  return state.s === undefined || state.s === 's' ? 'y' : null;
}

export type SessionPullRequestLifecycle = { s: PrStatus; u: number };
export type SessionPullRequestLifecycleFields = {
  [field: `prLifecycle:${string}`]: SessionPullRequestLifecycle | undefined;
};

/**
 * Explicit link intent for one pull request, stored at
 * `prLink:<case-folded canonical URL>`. `k`: linked / unlinked; `o`: who wrote it
 * (the managed `gh` shim, the user, or the agent through a Lody tool); `t`: epoch
 * milliseconds of the write. Membership/order still come only from `pullRequests`.
 */
export type SessionPullRequestLink = { k: 'l' | 'u'; o: 's' | 'u' | 'a'; t: number };
/** Reconciler result for a linked URL it could not read: `u` = unreadable at `t` (epoch ms). */
export type SessionPullRequestLinkCheck = { r: 'u'; t: number };
export type SessionPullRequestLinkFields = {
  [field: `prLink:${string}`]: SessionPullRequestLink | undefined;
  [field: `prLinkCheck:${string}`]: SessionPullRequestLinkCheck | undefined;
};

/** Per-PR records stored as top-level Session metadata keys (lifecycle and links). */
export type SessionPullRequestRecordFields = SessionPullRequestLifecycleFields &
  SessionPullRequestLinkFields;
