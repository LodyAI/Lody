/**
 * Device-local eligibility for the iOS App Store review prompt.
 *
 * The product layer deliberately keeps only two durable gates — recent
 * engagement and a request cooldown. StoreKit already caps the system sheet at
 * three presentations per device per 365 days and silently drops the rest, so a
 * second, stricter rate limiter here bought nothing and made the prompt
 * unreachable. What StoreKit does NOT protect against is asking for a rating
 * right after the user's turn failed, so a narrow negative-context check
 * survives — but it reads the live session instead of durable state
 * (see `hasRecentHardFailureOutcome`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const APP_STORE_REVIEW_MIN_WINDOWED_TURNS = 50;
export const APP_STORE_REVIEW_TURN_WINDOW_MS = 60 * DAY_MS;
export const APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS = 90 * DAY_MS;
/** How many of the session's most recent finalized turns must be failure-free. */
export const APP_STORE_REVIEW_NEGATIVE_CONTEXT_TURNS = 5;

export type AppStoreReviewTurnOutcome = {
  id: string;
  kind: 'completed' | 'hard_failure';
  occurredAtMs: number;
};

export type AppStoreReviewPromptState = {
  schemaVersion: 2;
  /**
   * Completion times of the most recent successful turns, ascending, capped at
   * `APP_STORE_REVIEW_MIN_WINDOWED_TURNS`.
   *
   * The cap loses nothing: eligibility only asks whether at least that many
   * turns fall inside the window, and if the oldest of the newest N is already
   * outside it then fewer than N are inside it. Keeping timestamps rather than
   * v1's lifetime counter is also what gives the window its meaning — that
   * counter never decayed, so someone who used Lody heavily months ago stayed
   * "engaged" forever.
   *
   * The last element doubles as the watermark: a turn is only counted when it
   * is strictly newer, which makes re-scanning a session's history idempotent
   * without storing per-turn identity. v1 needed a list of up to 512
   * `sessionId:turnId` strings for that, roughly 25KB re-serialized into
   * localStorage on every completed turn. The trade is that opening a session
   * OLDER than the watermark does not backfill its turns; the error only ever
   * runs toward under-counting, so it cannot manufacture eligibility, and
   * forward usage is exact.
   *
   * Because the newest element is the watermark, no entry may ever be dated in
   * the future — see `recordAppStoreReviewTurnOutcomes`.
   */
  recentTurnTimesMs: number[];
  lastRequestAttemptAtMs: number | null;
};

export function createAppStoreReviewPromptState(): AppStoreReviewPromptState {
  return { schemaVersion: 2, recentTurnTimesMs: [], lastRequestAttemptAtMs: null };
}

/** Recorded turns that fall inside the trailing engagement window. */
export function countWindowedTurns(state: AppStoreReviewPromptState, nowMs: number): number {
  const windowStartMs = nowMs - APP_STORE_REVIEW_TURN_WINDOW_MS;
  return state.recentTurnTimesMs.filter((timeMs) => timeMs >= windowStartMs && timeMs <= nowMs)
    .length;
}

/**
 * Fold newly observed turn outcomes into the stored timestamps. Returns the
 * same state object when nothing was new, so callers can skip the localStorage
 * write that a streaming history update would otherwise trigger every frame.
 *
 * Hard failures are not recorded at all: the negative-context gate reads the
 * live session (`hasRecentHardFailureOutcome`) rather than durable state.
 */
export function recordAppStoreReviewTurnOutcomes(
  state: AppStoreReviewPromptState,
  outcomes: readonly AppStoreReviewTurnOutcome[],
  nowMs: number
): AppStoreReviewPromptState {
  // Nothing dated in the future is ever stored, and the newest stored time is
  // also the watermark. `occurredAtMs` is the agent machine's clock while
  // `nowMs` is the phone's, so the two disagree routinely — and a stored future
  // value swallows every genuinely newer turn until real time catches up to it.
  // Dropping stored future times as well makes the invariant hold in both
  // directions, so a phone clock corrected backwards heals on the next turn
  // instead of going quiet for the length of the correction.
  const usableTimesMs = state.recentTurnTimesMs.filter((timeMs) => timeMs <= nowMs);
  const watermarkMs = usableTimesMs[usableTimesMs.length - 1] ?? null;
  const addedTimesMs: number[] = [];

  for (const outcome of outcomes) {
    if (outcome.kind !== 'completed') continue;
    const timeMs = outcome.occurredAtMs;
    if (!Number.isFinite(timeMs) || timeMs <= 0 || timeMs > nowMs) continue;
    if (watermarkMs != null && timeMs <= watermarkMs) continue;
    addedTimesMs.push(timeMs);
  }

  // A turn the machine dated slightly ahead of the phone is deferred, not lost:
  // the recording effect re-scans the whole session on the next history update,
  // by which point the timestamp has fallen into the past.
  const droppedFutureCount = state.recentTurnTimesMs.length - usableTimesMs.length;
  if (addedTimesMs.length === 0 && droppedFutureCount === 0) return state;

  // Everything added is strictly above the watermark, so appending the sorted
  // additions to the already-ascending usable times keeps the whole list sorted.
  addedTimesMs.sort((left, right) => left - right);
  return {
    ...state,
    recentTurnTimesMs: [...usableTimesMs, ...addedTimesMs].slice(
      -APP_STORE_REVIEW_MIN_WINDOWED_TURNS
    ),
  };
}

/**
 * Whether the session's most recent finalized turns contain a failure.
 *
 * Scoped to the turns the user just watched, because that is the whole point:
 * asking for a rating moments after a turn failed is the most reliable way to
 * earn a one-star review. v1 blocked on any failure in any session opened in
 * the last 72 hours, which for anyone active enough to clear the turn
 * threshold was very nearly always true.
 */
export function hasRecentHardFailureOutcome(
  outcomes: readonly AppStoreReviewTurnOutcome[]
): boolean {
  return outcomes
    .slice(-APP_STORE_REVIEW_NEGATIVE_CONTEXT_TURNS)
    .some((outcome) => outcome.kind === 'hard_failure');
}

/**
 * Why a candidate turn did not reach the system review sheet. Reported as the
 * `block_reason` of `mobile/app_store_review_prompt_blocked` so the funnel can
 * show which gate the prompt actually dies on. Ordered by evaluation order:
 * only the first failing gate is reported.
 */
export type AppStoreReviewBlockReason =
  | 'missing_app_version'
  | 'insufficient_turns'
  | 'recent_hard_failure'
  | 'attempt_cooldown';

export type AppStoreReviewEligibilityInput = {
  state: AppStoreReviewPromptState;
  appVersion: string | null | undefined;
  nowMs: number;
  hasRecentHardFailure: boolean;
};

/** `null` when the prompt may be requested; otherwise the first failing gate. */
export function resolveAppStoreReviewBlockReason({
  state,
  appVersion,
  nowMs,
  hasRecentHardFailure,
}: AppStoreReviewEligibilityInput): AppStoreReviewBlockReason | null {
  if (!appVersion?.trim()) return 'missing_app_version';
  if (countWindowedTurns(state, nowMs) < APP_STORE_REVIEW_MIN_WINDOWED_TURNS) {
    return 'insufficient_turns';
  }
  if (hasRecentHardFailure) return 'recent_hard_failure';
  if (
    state.lastRequestAttemptAtMs != null &&
    nowMs - state.lastRequestAttemptAtMs < APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS
  ) {
    return 'attempt_cooldown';
  }
  return null;
}

export function hasAppStoreReviewEligibility(input: AppStoreReviewEligibilityInput): boolean {
  return resolveAppStoreReviewBlockReason(input) === null;
}

export function markAppStoreReviewRequestAttempt(
  state: AppStoreReviewPromptState,
  { attemptedAtMs }: { attemptedAtMs: number }
): AppStoreReviewPromptState {
  return { ...state, lastRequestAttemptAtMs: attemptedAtMs };
}
