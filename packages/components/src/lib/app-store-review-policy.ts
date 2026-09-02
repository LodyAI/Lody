export const APP_STORE_REVIEW_MIN_EFFECTIVE_TURNS = 51;
export const APP_STORE_REVIEW_MIN_ACTIVE_DAYS = 2;
export const APP_STORE_REVIEW_ACTIVE_DAY_WINDOW = 3;
export const APP_STORE_REVIEW_NEGATIVE_CONTEXT_MS = 72 * 60 * 60 * 1000;
export const APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

const MAX_DEDUPLICATION_IDS = 512;

export type AppStoreReviewTurnOutcome = {
  id: string;
  kind: 'completed' | 'hard_failure';
  occurredAtMs: number;
};

export type AppStoreReviewPromptState = {
  schemaVersion: 1;
  /** Capped because eligibility only distinguishes 50 turns from 51 or more. */
  effectiveTurnCount: number;
  /** Recent local-calendar dates on which a valid completed turn occurred. */
  activeDayKeys: string[];
  /** Opaque turn identifiers used to make repeated history hydration idempotent. */
  recordedOutcomeIds: string[];
  lastHardFailureAtMs: number | null;
  lastRequestAttemptAtMs: number | null;
  lastRequestedVersion: string | null;
};

export function createAppStoreReviewPromptState(): AppStoreReviewPromptState {
  return {
    schemaVersion: 1,
    effectiveTurnCount: 0,
    activeDayKeys: [],
    recordedOutcomeIds: [],
    lastHardFailureAtMs: null,
    lastRequestAttemptAtMs: null,
    lastRequestedVersion: null,
  };
}

export function getLocalCalendarDayKey(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  const date = new Date(timestampMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function getRecentLocalCalendarDayKeys(nowMs: number): Set<string> {
  const keys = new Set<string>();
  if (!Number.isFinite(nowMs) || nowMs <= 0) return keys;
  const now = new Date(nowMs);
  for (let offset = 0; offset < APP_STORE_REVIEW_ACTIVE_DAY_WINDOW; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = getLocalCalendarDayKey(date.getTime());
    if (key) keys.add(key);
  }
  return keys;
}

export function recordAppStoreReviewTurnOutcomes(
  state: AppStoreReviewPromptState,
  outcomes: readonly AppStoreReviewTurnOutcome[]
): AppStoreReviewPromptState {
  const recordedOutcomeIds = new Set(state.recordedOutcomeIds);
  const activeDayKeys = new Set(state.activeDayKeys);
  let effectiveTurnCount = state.effectiveTurnCount;
  let lastHardFailureAtMs = state.lastHardFailureAtMs;
  let changed = false;

  for (const outcome of outcomes) {
    if (!outcome.id || recordedOutcomeIds.has(outcome.id)) continue;
    recordedOutcomeIds.add(outcome.id);
    changed = true;

    if (outcome.kind === 'hard_failure') {
      if (
        Number.isFinite(outcome.occurredAtMs) &&
        outcome.occurredAtMs > 0 &&
        (lastHardFailureAtMs == null || outcome.occurredAtMs > lastHardFailureAtMs)
      ) {
        lastHardFailureAtMs = outcome.occurredAtMs;
      }
      continue;
    }

    effectiveTurnCount = Math.min(APP_STORE_REVIEW_MIN_EFFECTIVE_TURNS, effectiveTurnCount + 1);
    const dayKey = getLocalCalendarDayKey(outcome.occurredAtMs);
    if (dayKey) activeDayKeys.add(dayKey);
  }

  if (!changed) return state;

  const nextRecordedOutcomeIds = Array.from(recordedOutcomeIds);
  // Once the user has cleared the only count threshold, dropping older ids cannot make a
  // repeated history scan alter eligibility. It keeps the device-local record bounded.
  const boundedOutcomeIds =
    effectiveTurnCount >= APP_STORE_REVIEW_MIN_EFFECTIVE_TURNS &&
    nextRecordedOutcomeIds.length > MAX_DEDUPLICATION_IDS
      ? nextRecordedOutcomeIds.slice(-MAX_DEDUPLICATION_IDS)
      : nextRecordedOutcomeIds;

  return {
    ...state,
    effectiveTurnCount,
    activeDayKeys: Array.from(activeDayKeys).sort().slice(-APP_STORE_REVIEW_ACTIVE_DAY_WINDOW),
    recordedOutcomeIds: boundedOutcomeIds,
    lastHardFailureAtMs,
  };
}

/**
 * Why a candidate turn did not reach the system review sheet. Reported as the
 * `block_reason` of `mobile/app_store_review_prompt_blocked` so the funnel can
 * show which gate the prompt actually dies on. Ordered by evaluation order:
 * only the first failing gate is reported.
 */
export type AppStoreReviewBlockReason =
  | 'missing_app_version'
  | 'invalid_clock'
  | 'insufficient_turns'
  | 'insufficient_active_days'
  | 'recent_hard_failure'
  | 'already_requested_this_version'
  | 'attempt_cooldown';

/** Number of stored active days that fall inside the trailing eligibility window. */
export function countRecentActiveDays(state: AppStoreReviewPromptState, nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return 0;
  const recentDayKeys = getRecentLocalCalendarDayKeys(nowMs);
  return new Set(state.activeDayKeys.filter((dayKey) => recentDayKeys.has(dayKey))).size;
}

/** `null` when the prompt may be requested; otherwise the first failing gate. */
export function resolveAppStoreReviewBlockReason({
  state,
  appVersion,
  nowMs,
}: {
  state: AppStoreReviewPromptState;
  appVersion: string | null | undefined;
  nowMs: number;
}): AppStoreReviewBlockReason | null {
  const normalizedVersion = appVersion?.trim();
  if (!normalizedVersion) return 'missing_app_version';
  if (!Number.isFinite(nowMs) || nowMs <= 0) return 'invalid_clock';
  if (state.effectiveTurnCount < APP_STORE_REVIEW_MIN_EFFECTIVE_TURNS) {
    return 'insufficient_turns';
  }
  if (countRecentActiveDays(state, nowMs) < APP_STORE_REVIEW_MIN_ACTIVE_DAYS) {
    return 'insufficient_active_days';
  }
  if (
    state.lastHardFailureAtMs != null &&
    nowMs - state.lastHardFailureAtMs < APP_STORE_REVIEW_NEGATIVE_CONTEXT_MS
  ) {
    return 'recent_hard_failure';
  }
  if (state.lastRequestedVersion === normalizedVersion) return 'already_requested_this_version';
  if (
    state.lastRequestAttemptAtMs != null &&
    nowMs - state.lastRequestAttemptAtMs < APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS
  ) {
    return 'attempt_cooldown';
  }
  return null;
}

export function hasAppStoreReviewEligibility(input: {
  state: AppStoreReviewPromptState;
  appVersion: string | null | undefined;
  nowMs: number;
}): boolean {
  return resolveAppStoreReviewBlockReason(input) === null;
}

export function markAppStoreReviewRequestAttempt(
  state: AppStoreReviewPromptState,
  { appVersion, attemptedAtMs }: { appVersion: string; attemptedAtMs: number }
): AppStoreReviewPromptState {
  return {
    ...state,
    lastRequestedVersion: appVersion,
    lastRequestAttemptAtMs: attemptedAtMs,
  };
}
