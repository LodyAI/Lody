import {
  parseGitHubPullRequestUrl,
  type PrStatus,
  type SessionMeta,
  type SessionPullRequestMeta,
  type SessionPullRequestStateMeta,
} from '@lody/shared';
import type { PrObservation } from './github-graphql-client';

/**
 * Current-PR selection + write-back planning (spec
 * `specs/pr-status-reconciler.md` — 当前 PR 选择与写回规划).
 *
 * Pure planning against the FRESH owner session meta (re-read after each
 * poll — never a cache). Returns null when nothing changed, which is the
 * "no meta writes when nothing changed" predicate.
 *
 * Shared metadata contract enforced here:
 * - `pullRequests` last item is the current PR; entries are `{url, status}`
 *   only (legacy detail fields are stripped on rewrite — ordering bootstrap);
 * - `pullRequestState` entries stay ≤50B: `{s?, m?, t}`; legacy `r` is never
 *   written and is deleted on first touch; terminal/no-signal PRs get their
 *   record deleted; entries for non-associated URLs are pruned.
 */

const isTerminal = (status: PrStatus): boolean => status === 'merged' || status === 'closed';

/**
 * Deterministic current-PR selection over associated entries (fresh meta
 * order) and this round's observations. Stable ranking:
 * 1. observed `headRefName` equals the runtime branch;
 * 2. open/draft over merged/closed (stored status when unobserved);
 * 3. newer observed `updatedAt` (unobserved ranks below any observed);
 * 4. larger PR number;
 * 5. later original array position (preserves the existing current as the
 *    fallback when everything else ties — observations never lose to it).
 */
export function selectCurrentPullRequestUrl(args: {
  associated: readonly SessionPullRequestMeta[];
  observations: ReadonlyMap<string, PrObservation>;
  runtimeBranch: string | null;
}): string | null {
  const { associated, observations, runtimeBranch } = args;
  let best: { url: string; rank: [number, number, number, number, number] } | null = null;
  for (let index = 0; index < associated.length; index += 1) {
    const pr = associated[index];
    if (!pr) {
      continue;
    }
    const observation = observations.get(pr.url);
    const status = observation?.status ?? pr.status;
    const branchMatch =
      observation && runtimeBranch && observation.headRefName === runtimeBranch ? 1 : 0;
    const open = isTerminal(status) ? 0 : 1;
    const updatedAtMs = observation ? Date.parse(observation.updatedAt) || 0 : -1;
    const prNumber = observation?.number ?? parseGitHubPullRequestUrl(pr.url)?.prNumber ?? -1;
    const rank: [number, number, number, number, number] = [
      branchMatch,
      open,
      updatedAtMs,
      prNumber,
      index,
    ];
    if (!best || compareRank(rank, best.rank) > 0) {
      best = { url: pr.url, rank };
    }
  }
  return best ? best.url : null;
}

function compareRank(
  a: readonly [number, number, number, number, number],
  b: readonly [number, number, number, number, number]
): number {
  for (let i = 0; i < a.length; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

export type PrAssociationPlan = {
  url: string;
  prNumber: number;
  status: PrStatus;
};

/**
 * Decide whether a discovered PR should become a canonical association: run
 * current-PR selection over associated ∪ discovered; when the winner is not
 * yet associated, it must go through the association effect BEFORE any local
 * meta write. Returns null when the winner is already associated (or nothing
 * was discovered).
 *
 * `observations` must include EVERY observation of this round (status and
 * discovery alike): an already-associated PR needs its own branch/updatedAt
 * evidence in the ranking, or an older terminal candidate on the same branch
 * could outrank it and trigger a pointless association.
 */
export function planAssociation(args: {
  meta: Pick<SessionMeta, 'pullRequests'> | undefined;
  /** All of this round's observations (associated and discovered). */
  observations: readonly PrObservation[];
  /** Exact-branch discovery candidates — the only PRs eligible for a NEW association. */
  discovered: readonly PrObservation[];
  runtimeBranch: string | null;
}): PrAssociationPlan | null {
  const associatedUrls = new Set((args.meta?.pullRequests ?? []).map((pr) => pr.url));
  const candidates: SessionPullRequestMeta[] = (args.meta?.pullRequests ?? []).map((pr) => ({
    url: pr.url,
    status: pr.status,
  }));
  const observations = new Map<string, PrObservation>();
  for (const pr of [...args.observations, ...args.discovered]) {
    if (!observations.has(pr.url)) {
      observations.set(pr.url, pr);
    }
  }
  const eligible = new Map<string, PrObservation>();
  for (const pr of args.discovered) {
    if (associatedUrls.has(pr.url) || eligible.has(pr.url)) {
      continue;
    }
    eligible.set(pr.url, pr);
    candidates.push({ url: pr.url, status: pr.status });
  }
  if (eligible.size === 0) {
    return null;
  }
  const currentUrl = selectCurrentPullRequestUrl({
    associated: candidates,
    observations,
    runtimeBranch: args.runtimeBranch,
  });
  const winner = currentUrl === null ? undefined : eligible.get(currentUrl);
  if (!winner) {
    return null;
  }
  return { url: winner.url, prNumber: winner.number, status: winner.status };
}

export type PrMetaWritePlan = {
  /** New pullRequests array, or null when unchanged. */
  pullRequests: SessionPullRequestMeta[] | null;
  /** New pullRequestState record, or null when unchanged. */
  pullRequestState: Record<string, SessionPullRequestStateMeta> | null;
  /** URLs whose stored status differed from the observation (webhook-gap corrections). */
  changedStatusUrls: string[];
  /** URLs whose state record was written (new or s/m changed, or legacy r dropped). */
  changedStateUrls: string[];
  /** URLs whose state record was deleted (terminal PR, or no signals left). */
  removedStateUrls: string[];
  /** State entries pruned because the URL is no longer an associated PR. */
  prunedStateUrls: string[];
};

export function planPullRequestMetaWrite(args: {
  meta: Pick<SessionMeta, 'pullRequests' | 'pullRequestState'> | undefined;
  /** This round's observations; applied only to already-associated URLs. */
  observations: readonly PrObservation[];
  /** Freshly (successfully) associated PRs to upsert into the array. */
  newlyAssociated?: readonly PrObservation[];
  runtimeBranch: string | null;
  /** Epoch seconds — stamped as `t` only when a state signal actually changed. */
  nowSec: number;
}): PrMetaWritePlan | null {
  const { meta, nowSec } = args;
  const originalPrs = meta?.pullRequests ?? [];
  const currentState = meta?.pullRequestState ?? {};

  // 1. Normalize (strip legacy fields, dedupe by URL) and apply observed
  //    lifecycle to associated entries.
  const changedStatusUrls: string[] = [];
  const observationByUrl = new Map<string, PrObservation>();
  for (const observation of args.observations) {
    observationByUrl.set(observation.url, observation);
  }
  const seenUrls = new Set<string>();
  const nextPrs: SessionPullRequestMeta[] = [];
  for (const pr of originalPrs) {
    if (seenUrls.has(pr.url)) {
      continue;
    }
    seenUrls.add(pr.url);
    const observation = observationByUrl.get(pr.url);
    const status = observation?.status ?? pr.status;
    if (observation && observation.status !== pr.status) {
      changedStatusUrls.push(pr.url);
    }
    nextPrs.push({ url: pr.url, status });
  }

  // 2. Append freshly associated PRs (association effect already succeeded).
  for (const pr of args.newlyAssociated ?? []) {
    if (seenUrls.has(pr.url)) {
      continue;
    }
    seenUrls.add(pr.url);
    observationByUrl.set(pr.url, pr);
    nextPrs.push({ url: pr.url, status: pr.status });
    changedStatusUrls.push(pr.url);
  }

  // 3. Move the selected current PR to the last position (stable otherwise).
  const currentUrl = selectCurrentPullRequestUrl({
    associated: nextPrs,
    observations: observationByUrl,
    runtimeBranch: args.runtimeBranch,
  });
  if (currentUrl !== null) {
    const index = nextPrs.findIndex((pr) => pr.url === currentUrl);
    if (index >= 0 && index !== nextPrs.length - 1) {
      const [current] = nextPrs.splice(index, 1);
      if (current) {
        nextPrs.push(current);
      }
    }
  }

  const pullRequests = pullRequestsChanged(originalPrs, nextPrs) ? nextPrs : null;

  // 4. Live state per associated URL: `s`/`m` on change, delete on
  //    terminal/no-signal, prune non-associated, drop legacy `r`.
  let pullRequestState: Record<string, SessionPullRequestStateMeta> | null = null;
  const changedStateUrls: string[] = [];
  const removedStateUrls: string[] = [];
  const nextState: Record<string, SessionPullRequestStateMeta> = { ...currentState };
  const associatedUrls = new Set(nextPrs.map((pr) => pr.url));
  for (const [url, observation] of observationByUrl) {
    if (!associatedUrls.has(url)) {
      continue;
    }
    const existing = nextState[url];
    const desired = isTerminal(observation.status)
      ? null
      : buildStateEntry(observation, existing, nowSec);
    if (desired === null) {
      if (existing) {
        delete nextState[url];
        pullRequestState = nextState;
        removedStateUrls.push(url);
      }
      continue;
    }
    if (
      existing?.s !== desired.s ||
      existing?.m !== desired.m ||
      existing?.r !== undefined // legacy readiness: always dropped on touch
    ) {
      nextState[url] = desired;
      pullRequestState = nextState;
      changedStateUrls.push(url);
    }
  }

  const prunedStateUrls: string[] = [];
  for (const url of Object.keys(nextState)) {
    if (!associatedUrls.has(url)) {
      delete nextState[url];
      pullRequestState = nextState;
      prunedStateUrls.push(url);
    }
  }

  if (!pullRequests && !pullRequestState) {
    return null;
  }
  return {
    pullRequests,
    pullRequestState,
    changedStatusUrls,
    changedStateUrls,
    removedStateUrls,
    prunedStateUrls,
  };
}

/**
 * Array change predicate. Stripping legacy detail fields counts as a change
 * exactly once (the ordering bootstrap write); afterwards identical polls
 * compare equal and produce no write.
 */
function pullRequestsChanged(
  original: readonly SessionPullRequestMeta[],
  next: readonly SessionPullRequestMeta[]
): boolean {
  if (original.length !== next.length) {
    return true;
  }
  for (let i = 0; i < original.length; i += 1) {
    const before = original[i];
    const after = next[i];
    if (!before || !after || before.url !== after.url || before.status !== after.status) {
      return true;
    }
    // Legacy fields (number/repository/branch/headCommitSha/reportedAt) are
    // stripped on rewrite; their presence means the normalized array differs.
    if (Object.keys(before).length !== 2) {
      return true;
    }
  }
  return false;
}

/**
 * Desired state record for a non-terminal PR, preserving `t` when no signal
 * changed (so `t` always marks the last real state change, not the last
 * poll). Returns null when all signals are absent. Never emits legacy `r`.
 */
function buildStateEntry(
  observation: Pick<PrObservation, 'ciState' | 'mergeState'>,
  existing: SessionPullRequestStateMeta | undefined,
  nowSec: number
): SessionPullRequestStateMeta | null {
  const { ciState, mergeState } = observation;
  if (ciState === null && mergeState === null) {
    return null;
  }
  const changed =
    existing?.s !== (ciState ?? undefined) || existing?.m !== (mergeState ?? undefined);
  const entry: SessionPullRequestStateMeta = {
    t: changed ? nowSec : (existing?.t ?? nowSec),
  };
  if (ciState !== null) {
    entry.s = ciState;
  }
  if (mergeState !== null) {
    entry.m = mergeState;
  }
  return entry;
}
