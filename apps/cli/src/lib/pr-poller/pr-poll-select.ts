import type { SessionId } from '@lody/shared';
import type { PrPollLane } from './pr-poll-priority';
import type { PrPollDiscoveryTarget, PrPollStatusTarget } from './pr-poll-targets';

/**
 * Scheduling selection (spec `specs/pr-status-reconciler.md` — 调度选择).
 *
 * Dueness is a pure function of last success/attempt + the current desired
 * interval — "next poll time" is never stored, so a priority change
 * (promotion/demotion) takes effect immediately without rewriting state.
 * Lane fairness lives here and only here; quota is lane-blind.
 */

export type PrPollTargetKind = 'status' | 'discovery';

export type SchedulableTarget = {
  /**
   * Stable key for last-success persistence:
   * `ws|owner|repo|status|<prNumber>` or `ws|owner|repo|discovery|<branch>`.
   * The qualifier identifies the ACTUAL target, so a newly associated PR or a
   * switched branch starts as never-refreshed (immediately due) instead of
   * inheriting a stale success stamp. Only the FIRST segment is ever parsed
   * back (workspace pruning), so a `|` inside a branch name is harmless.
   */
  key: string;
  kind: PrPollTargetKind;
  workspaceId: string;
  ownerSessionId: SessionId;
  repoFullName: string;
  lane: PrPollLane;
  desiredIntervalMs: number;
  /** Hard floor between attempts (spacing for failures). */
  minIntervalMs: number;
  lastSuccessAtMs: number | null;
  lastAttemptAtMs: number | null;
  /** Payload for batch building. Exactly one is set, matching `kind`. */
  status?: PrPollStatusTarget;
  discovery?: PrPollDiscoveryTarget;
};

export function prPollTargetKey(
  workspaceId: string,
  ownerSessionId: SessionId,
  repoFullName: string,
  kind: PrPollTargetKind,
  qualifier: string
): string {
  return `${workspaceId}|${ownerSessionId}|${repoFullName}|${kind}|${qualifier}`;
}

/** Never-refreshed targets are due immediately. */
export function computeTargetDueAtMs(target: SchedulableTarget): number {
  const successDue =
    target.lastSuccessAtMs === null ? 0 : target.lastSuccessAtMs + target.desiredIntervalMs;
  const attemptFloor =
    target.lastAttemptAtMs === null ? 0 : target.lastAttemptAtMs + target.minIntervalMs;
  return Math.max(successDue, attemptFloor);
}

/**
 * One GitHub call: all due targets of a `(workspace, repository)` pair.
 * The batch lane is the highest lane among its targets.
 */
export type PrPollBatchPlan = {
  workspaceId: string;
  repoFullName: string;
  lane: PrPollLane;
  oldestDueAtMs: number;
  targets: SchedulableTarget[];
};

export function planDueBatches(
  targets: readonly SchedulableTarget[],
  nowMs: number
): PrPollBatchPlan[] {
  const batches = new Map<string, PrPollBatchPlan>();
  for (const target of targets) {
    const dueAtMs = computeTargetDueAtMs(target);
    if (dueAtMs > nowMs) {
      continue;
    }
    const key = `${target.workspaceId}|${target.repoFullName}`;
    const batch = batches.get(key);
    if (!batch) {
      batches.set(key, {
        workspaceId: target.workspaceId,
        repoFullName: target.repoFullName,
        lane: target.lane,
        oldestDueAtMs: dueAtMs,
        targets: [target],
      });
      continue;
    }
    batch.targets.push(target);
    batch.oldestDueAtMs = Math.min(batch.oldestDueAtMs, dueAtMs);
    if (target.lane === 'high') {
      batch.lane = 'high';
    }
  }
  return Array.from(batches.values());
}

/**
 * Anti-starvation pick: high before low, oldest-due first within a lane —
 * but after `lowEveryNBatches − 1` consecutive high dispatches, a due low
 * batch MUST be picked next (low gets ≥1/N of dispatch opportunities under
 * contention). `consecutiveHighDispatches` is the caller-maintained streak of
 * actually-dispatched high batches.
 */
export function pickNextBatch(
  batches: readonly PrPollBatchPlan[],
  consecutiveHighDispatches: number,
  lowEveryNBatches: number
): PrPollBatchPlan | null {
  if (batches.length === 0) {
    return null;
  }
  const byOldest = (a: PrPollBatchPlan, b: PrPollBatchPlan): number =>
    a.oldestDueAtMs - b.oldestDueAtMs ||
    (a.workspaceId + a.repoFullName < b.workspaceId + b.repoFullName ? -1 : 1);
  const highs = batches.filter((batch) => batch.lane === 'high').sort(byOldest);
  const lows = batches.filter((batch) => batch.lane === 'low').sort(byOldest);
  if (
    lows.length > 0 &&
    (highs.length === 0 || consecutiveHighDispatches >= lowEveryNBatches - 1)
  ) {
    return lows[0] ?? null;
  }
  return highs[0] ?? lows[0] ?? null;
}

/**
 * Next wake time: the earliest future dueness across all targets, any gate
 * hints (quota/freeze/cooldown availability), capped at `nowMs + capMs` (the
 * cap re-checks presence TTL and activity expiry).
 */
export function computeNextWakeAtMs(
  targets: readonly SchedulableTarget[],
  deferredHintsMs: readonly number[],
  nowMs: number,
  capMs: number
): number {
  let earliest = nowMs + capMs;
  for (const target of targets) {
    const dueAtMs = computeTargetDueAtMs(target);
    if (dueAtMs > nowMs) {
      earliest = Math.min(earliest, dueAtMs);
    }
  }
  for (const hint of deferredHintsMs) {
    if (hint > nowMs) {
      earliest = Math.min(earliest, hint);
    }
  }
  return earliest;
}
