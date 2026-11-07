import type { SessionId } from '@lody/shared';

/**
 * Priority projection (spec `specs/pr-status-reconciler.md` — 优先级投影).
 *
 * Priority only shortens desired refresh intervals — it is never a
 * precondition for refreshing. With no signals at all, an owner stays in the
 * low lane and keeps its low-cadence refresh.
 */

export type PrPollLane = 'high' | 'low';

export type OwnerActivityInput = {
  ownerSessionId: SessionId;
  /** Owner + child tabs; a viewer on any member counts for the owner. */
  memberSessionIds: readonly SessionId[];
  /** Newest `lastMessageAt` across members (epoch ms); null when absent. */
  lastMessageAtMs: number | null;
};

export type PrPollPriorityOptions = {
  /** High-candidacy window after conversation activity (default 10 min). */
  activityWindowMs: number;
  /** Max owners in the high lane; overflow spills to low (default 100). */
  highOwnerCap: number;
};

/**
 * Owners in the high lane: viewed (fresh `session-viewing` presence, TTL
 * enforced upstream) or with conversation activity within the window, capped
 * at `highOwnerCap` by a stable ranking (viewed first, then most-recent
 * activity, then owner id).
 */
export function selectHighOwners(
  owners: readonly OwnerActivityInput[],
  viewedSessionIds: ReadonlySet<SessionId>,
  nowMs: number,
  options: PrPollPriorityOptions
): Set<SessionId> {
  const candidates: Array<{ ownerSessionId: SessionId; viewed: boolean; activityMs: number }> = [];
  for (const owner of owners) {
    const viewed = owner.memberSessionIds.some((sessionId) => viewedSessionIds.has(sessionId));
    const activityMs = owner.lastMessageAtMs ?? 0;
    const active = nowMs - activityMs <= options.activityWindowMs;
    if (viewed || (owner.lastMessageAtMs !== null && active)) {
      candidates.push({ ownerSessionId: owner.ownerSessionId, viewed, activityMs });
    }
  }
  candidates.sort((a, b) => {
    if (a.viewed !== b.viewed) return a.viewed ? -1 : 1;
    if (a.activityMs !== b.activityMs) return b.activityMs - a.activityMs;
    return a.ownerSessionId < b.ownerSessionId ? -1 : a.ownerSessionId > b.ownerSessionId ? 1 : 0;
  });
  return new Set(candidates.slice(0, options.highOwnerCap).map((c) => c.ownerSessionId));
}

/** Entrusted CI needs observations within its admission freshness window, regardless of UI presence. */
export function statusRefreshInterval(
  lane: PrPollLane,
  workflowDemand: boolean,
  config: {
    highIntervalMs: number;
    lowStatusIntervalMs: number;
  }
): number {
  return workflowDemand
    ? Math.min(config.highIntervalMs, config.lowStatusIntervalMs)
    : lane === 'high'
      ? config.highIntervalMs
      : config.lowStatusIntervalMs;
}
