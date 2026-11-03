import { describe, expect, it } from 'vitest';

import {
  APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS,
  APP_STORE_REVIEW_MIN_WINDOWED_TURNS,
  APP_STORE_REVIEW_TURN_WINDOW_MS,
  countWindowedTurns,
  createAppStoreReviewPromptState,
  hasAppStoreReviewEligibility,
  hasRecentHardFailureOutcome,
  markAppStoreReviewRequestAttempt,
  recordAppStoreReviewTurnOutcomes,
  type AppStoreReviewTurnOutcome,
} from '../src/lib/app-store-review-policy';

const nowMs = Date.parse('2026-05-10T12:00:00.000Z');
const appVersion = '1.5.0';
const DAY_MS = 24 * 60 * 60 * 1000;

/** `count` completed turns, one per minute, ending `daysAgo` days before now. */
function completedTurns(
  count: number,
  daysAgo = 0,
  idPrefix = 'turn'
): AppStoreReviewTurnOutcome[] {
  const firstMs = nowMs - daysAgo * DAY_MS - count * 60_000;
  return Array.from({ length: count }, (_, index) => ({
    id: `${idPrefix}-${daysAgo}-${index}`,
    kind: 'completed' as const,
    occurredAtMs: firstMs + index * 60_000,
  }));
}

function record(
  state = createAppStoreReviewPromptState(),
  outcomes: readonly AppStoreReviewTurnOutcome[] = [],
  atMs = nowMs
) {
  return recordAppStoreReviewTurnOutcomes(state, outcomes, atMs);
}

function eligibleState() {
  return record(undefined, completedTurns(APP_STORE_REVIEW_MIN_WINDOWED_TURNS));
}

const eligibilityInput = { appVersion, nowMs, hasRecentHardFailure: false };

describe('app store review policy', () => {
  it('needs fifty completed turns inside the window', () => {
    const shortOfThreshold = record(
      undefined,
      completedTurns(APP_STORE_REVIEW_MIN_WINDOWED_TURNS - 1)
    );
    expect(hasAppStoreReviewEligibility({ ...eligibilityInput, state: shortOfThreshold })).toBe(
      false
    );
    expect(hasAppStoreReviewEligibility({ ...eligibilityInput, state: eligibleState() })).toBe(
      true
    );
  });

  it('forgets turns once they age out of the window', () => {
    const state = eligibleState();
    const laterMs = nowMs + APP_STORE_REVIEW_TURN_WINDOW_MS + DAY_MS;

    expect(countWindowedTurns(state, laterMs)).toBe(0);
    expect(hasAppStoreReviewEligibility({ ...eligibilityInput, state, nowMs: laterMs })).toBe(
      false
    );
  });

  it('ignores hard failures when counting engagement', () => {
    const state = record(undefined, [
      ...completedTurns(3),
      { id: 'failed', kind: 'hard_failure', occurredAtMs: nowMs },
    ]);
    expect(countWindowedTurns(state, nowMs)).toBe(3);
  });

  it('never stores a future timestamp, so a fast machine clock cannot swallow real turns', () => {
    const skewed = record(undefined, [
      { id: 'fast-machine', kind: 'completed', occurredAtMs: nowMs + DAY_MS },
    ]);
    expect(skewed.recentTurnTimesMs).toEqual([]);

    // Without this, the future value would be the watermark and every genuinely
    // newer turn below it would be ignored until real time caught up.
    const real = Array.from({ length: 10 }, (_, index) => ({
      id: `real-${index}`,
      kind: 'completed' as const,
      occurredAtMs: nowMs + index * 60_000,
    }));
    const laterMs = nowMs + 10 * 60_000;
    expect(countWindowedTurns(record(skewed, real, laterMs), laterMs)).toBe(10);
  });

  it('heals a phone clock corrected backwards instead of going quiet', () => {
    const beforeCorrection = record(undefined, completedTurns(10));
    // The phone clock jumps back a week: every stored time is now "in the future".
    const correctedNowMs = nowMs - 7 * DAY_MS;

    const healed = record(
      beforeCorrection,
      completedTurns(3, 7, 'after-correction'),
      correctedNowMs
    );
    expect(healed.recentTurnTimesMs.every((timeMs) => timeMs <= correctedNowMs)).toBe(true);
    expect(countWindowedTurns(healed, correctedNowMs)).toBe(3);
  });

  it('blocks on a failure among the session’s most recent turns only', () => {
    const outcomes: AppStoreReviewTurnOutcome[] = [
      { id: 'failed', kind: 'hard_failure', occurredAtMs: nowMs - 10_000 },
      ...completedTurns(4),
    ];
    expect(hasRecentHardFailureOutcome(outcomes)).toBe(true);
    expect(
      hasAppStoreReviewEligibility({
        ...eligibilityInput,
        state: eligibleState(),
        hasRecentHardFailure: true,
      })
    ).toBe(false);

    // One more clean turn pushes the failure out of the trailing window.
    expect(hasRecentHardFailureOutcome([...outcomes, ...completedTurns(1, 0, 'tail')])).toBe(false);
  });

  it('blocks a second request within ninety days of the last attempt', () => {
    const eligible = eligibleState();
    const justAttempted = markAppStoreReviewRequestAttempt(eligible, { attemptedAtMs: nowMs - 1 });
    expect(hasAppStoreReviewEligibility({ ...eligibilityInput, state: justAttempted })).toBe(false);

    const cooledDown = markAppStoreReviewRequestAttempt(eligible, {
      attemptedAtMs: nowMs - APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS,
    });
    expect(hasAppStoreReviewEligibility({ ...eligibilityInput, state: cooledDown })).toBe(true);
  });
});
