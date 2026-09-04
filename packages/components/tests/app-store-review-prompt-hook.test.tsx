// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistory, SessionId } from '@lody/shared';

import { useAppStoreReviewPrompt } from '../src/hooks/use-app-store-review-prompt';

const capture = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/deferred-posthog', () => ({
  deferredPostHog: { capture },
}));

type PromptInput = Parameters<typeof useAppStoreReviewPrompt>[0];

const nowMs = Date.parse('2026-05-10T12:00:00.000Z');
const sessionId = 'review-session' as SessionId;

function assistantTurn(id: string, occurredAtMs: number, userTurnId?: string): SessionHistory {
  return {
    id,
    role: 'assistant',
    timestamp: new Date(occurredAtMs).toISOString(),
    endedAt: occurredAtMs,
    finished: true,
    items: [{ type: 'text', text: `Completed ${id}` }],
    fileDiff: [],
    ...(userTurnId ? { userTurnId } : {}),
  } as SessionHistory;
}

function userTurn(id: string, status: 'handled' | 'processing' | 'failed'): SessionHistory {
  return {
    id,
    role: 'user',
    status,
    timestamp: new Date(nowMs).toISOString(),
    items: [{ type: 'text', text: 'Please continue.' }],
    fileDiff: [],
  } as SessionHistory;
}

// Fifty completed turns inside the sixty-day window, one per minute, in
// chronological order: the stored watermark only counts turns above it.
function eligibleHistoricalTurns(): SessionHistory[] {
  return Array.from({ length: 50 }, (_, index) =>
    assistantTurn(`historical-${index}`, nowMs - (50 - index) * 60_000)
  );
}

function Probe(input: PromptInput) {
  useAppStoreReviewPrompt(input);
  return null;
}

describe('useAppStoreReviewPrompt lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let requestReview: ReturnType<typeof vi.fn>;
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  const render = async (input: PromptInput) => {
    await act(async () => {
      root.render(<Probe {...input} />);
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    localStorage.clear();
    capture.mockClear();
    requestReview = vi.fn(async () => undefined);
    window.__LODY_NATIVE__ = true;
    window.__LODY_APP_INFO__ = { app_version: '1.5.0' };
    window.__LODY_APP_STORE_REVIEW__ = { requestReview };
    Object.defineProperty(window, 'Capacitor', {
      configurable: true,
      value: {
        getPlatform: () => 'ios',
        isNativePlatform: () => true,
      },
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    Reflect.deleteProperty(window, '__LODY_NATIVE__');
    Reflect.deleteProperty(window, '__LODY_APP_INFO__');
    Reflect.deleteProperty(window, '__LODY_APP_STORE_REVIEW__');
    Reflect.deleteProperty(window, 'Capacitor');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses hydrated history only as a baseline, then prompts after a genuinely new completion', async () => {
    const historical = eligibleHistoricalTurns();
    const baseInput = {
      sessionId,
      sessionOwnerId: 'hydration-user',
      currentUserId: 'hydration-user',
      sessionCompleted: true,
    } as const;

    await render({
      ...baseInput,
      history: [],
      historyHydrated: false,
      lastCompletedAssistantMessageId: null,
    });
    await render({
      ...baseInput,
      history: historical,
      historyHydrated: true,
      lastCompletedAssistantMessageId: 'historical-49',
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(requestReview).not.toHaveBeenCalled();

    const nextHistory = [
      ...historical,
      userTurn('new-user-turn', 'handled'),
      assistantTurn('new-assistant-turn', nowMs, 'new-user-turn'),
    ];
    await render({
      ...baseInput,
      history: nextHistory,
      historyHydrated: true,
      lastCompletedAssistantMessageId: 'new-assistant-turn',
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_499);
    });
    expect(requestReview).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(requestReview).toHaveBeenCalledTimes(1);
  });

  it('keeps the idle timer across a semantically unchanged history identity update', async () => {
    const historical = eligibleHistoricalTurns();
    const baseInput = {
      sessionId,
      sessionOwnerId: 'identity-user',
      currentUserId: 'identity-user',
      historyHydrated: true,
      sessionCompleted: true,
    } as const;

    await render({
      ...baseInput,
      history: historical,
      lastCompletedAssistantMessageId: 'historical-49',
    });

    const completedHistory = [
      ...historical,
      userTurn('identity-user-turn', 'handled'),
      assistantTurn('identity-assistant-turn', nowMs, 'identity-user-turn'),
    ];
    await render({
      ...baseInput,
      history: completedHistory,
      lastCompletedAssistantMessageId: 'identity-assistant-turn',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    await render({
      ...baseInput,
      history: [...completedHistory],
      lastCompletedAssistantMessageId: 'identity-assistant-turn',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(requestReview).toHaveBeenCalledTimes(1);
  });

  it('does not retry the same completed turn after real user interaction cancels its timer', async () => {
    const historical = eligibleHistoricalTurns();
    const completedHistory = [
      ...historical,
      userTurn('interaction-user-turn', 'handled'),
      assistantTurn('interaction-assistant-turn', nowMs, 'interaction-user-turn'),
    ];
    const input = {
      sessionId,
      sessionOwnerId: 'interaction-user',
      currentUserId: 'interaction-user',
      historyHydrated: true,
      history: historical,
      sessionCompleted: true,
      lastCompletedAssistantMessageId: 'historical-49',
    } as const;

    await render(input);
    await render({
      ...input,
      history: completedHistory,
      lastCompletedAssistantMessageId: 'interaction-assistant-turn',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      window.dispatchEvent(new Event('pointerdown'));
    });
    await render({
      ...input,
      history: [...completedHistory],
      lastCompletedAssistantMessageId: 'interaction-assistant-turn',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(requestReview).not.toHaveBeenCalled();
  });

  it('does not rewrite local storage for streaming updates without a new finalized outcome', async () => {
    const completed = [assistantTurn('completed', nowMs)];
    const baseInput = {
      sessionId,
      sessionOwnerId: 'stream-user',
      currentUserId: 'stream-user',
      historyHydrated: true,
      sessionCompleted: false,
      lastCompletedAssistantMessageId: 'completed',
    } as const;

    await render({ ...baseInput, history: completed });
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    setItemSpy.mockClear();

    await render({
      ...baseInput,
      history: [
        ...completed,
        userTurn('stream-user-turn', 'processing'),
        {
          ...assistantTurn('stream-assistant-turn', nowMs, 'stream-user-turn'),
          finished: false,
          endedAt: undefined,
          items: [{ type: 'text', text: 'Partial' }],
        } as SessionHistory,
      ],
    });
    await render({
      ...baseInput,
      history: [
        ...completed,
        userTurn('stream-user-turn', 'processing'),
        {
          ...assistantTurn('stream-assistant-turn', nowMs, 'stream-user-turn'),
          finished: false,
          endedAt: undefined,
          items: [{ type: 'text', text: 'Partial output grew' }],
        } as SessionHistory,
      ],
    });

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(requestReview).not.toHaveBeenCalled();
  });

  it('reports the request to analytics with the eligibility counters that allowed it', async () => {
    const historical = eligibleHistoricalTurns();
    const baseInput = {
      sessionId,
      sessionOwnerId: 'analytics-user',
      currentUserId: 'analytics-user',
      historyHydrated: true,
      sessionCompleted: true,
    } as const;

    await render({ ...baseInput, history: historical, lastCompletedAssistantMessageId: null });
    await render({
      ...baseInput,
      history: [
        ...historical,
        userTurn('analytics-user-turn', 'handled'),
        assistantTurn('analytics-assistant-turn', nowMs, 'analytics-user-turn'),
      ],
      lastCompletedAssistantMessageId: 'analytics-assistant-turn',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(requestReview).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      'mobile/app_store_review_prompt_requested',
      expect.objectContaining({
        app_version: '1.5.0',
        // Saturates at the threshold: stored turns are capped there, which is
        // all eligibility asks. Below the threshold the count is exact, which
        // is the half the funnel needs.
        windowed_turn_count: 50,
        stored_turn_count: 50,
        has_requested_before: false,
        native_platform: 'ios',
      })
    );
  });

  it('does not ask for a rating when the session just failed a turn', async () => {
    const historical = eligibleHistoricalTurns();
    const baseInput = {
      sessionId,
      sessionOwnerId: 'failure-user',
      currentUserId: 'failure-user',
      historyHydrated: true,
      sessionCompleted: true,
    } as const;

    await render({ ...baseInput, history: historical, lastCompletedAssistantMessageId: null });
    await render({
      ...baseInput,
      history: [
        ...historical,
        // A failed send sits among the session's most recent finalized turns.
        userTurn('failure-user-turn', 'failed'),
        userTurn('recovered-user-turn', 'handled'),
        assistantTurn('recovered-assistant-turn', nowMs, 'recovered-user-turn'),
      ],
      lastCompletedAssistantMessageId: 'recovered-assistant-turn',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(requestReview).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(
      'mobile/app_store_review_prompt_blocked',
      expect.objectContaining({ block_reason: 'recent_hard_failure' })
    );
  });

  it('drops the v1 blob when it reads v2 state', async () => {
    const legacyKey = 'lody:app-store-review:v1:legacy-user';
    localStorage.setItem(
      legacyKey,
      JSON.stringify({ effectiveTurnCount: 51, recordedOutcomeIds: ['a', 'b'] })
    );

    await render({
      sessionId,
      sessionOwnerId: 'legacy-user',
      currentUserId: 'legacy-user',
      historyHydrated: true,
      sessionCompleted: true,
      history: [assistantTurn('legacy-turn', nowMs)],
      lastCompletedAssistantMessageId: 'legacy-turn',
    });

    expect(localStorage.getItem(legacyKey)).toBeNull();
    // The v1 total cannot be reprojected onto day buckets, so v2 starts fresh.
    expect(localStorage.getItem('lody:app-store-review:v2:legacy-user')).toContain(
      'recentTurnTimesMs'
    );
  });

  it('reports the first blocking gate once per user instead of on every completed turn', async () => {
    // One completed turn: far below the effective-turn threshold.
    const completedHistory = [
      userTurn('blocked-user-turn', 'handled'),
      assistantTurn('blocked-assistant-turn', nowMs, 'blocked-user-turn'),
    ];
    const baseInput = {
      sessionId,
      sessionOwnerId: 'blocked-user',
      currentUserId: 'blocked-user',
      historyHydrated: true,
      sessionCompleted: true,
    } as const;

    await render({ ...baseInput, history: [], lastCompletedAssistantMessageId: null });
    await render({
      ...baseInput,
      history: completedHistory,
      lastCompletedAssistantMessageId: 'blocked-assistant-turn',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(requestReview).not.toHaveBeenCalled();
    const blockedCalls = capture.mock.calls.filter(
      ([eventName]) => eventName === 'mobile/app_store_review_prompt_blocked'
    );
    expect(blockedCalls).toHaveLength(1);
    expect(blockedCalls[0]?.[1]).toMatchObject({
      block_reason: 'insufficient_turns',
      windowed_turn_count: 1,
    });

    // A second completed turn for the same user must not emit a second event.
    const moreHistory = [
      ...completedHistory,
      userTurn('blocked-user-turn-2', 'handled'),
      assistantTurn('blocked-assistant-turn-2', nowMs, 'blocked-user-turn-2'),
    ];
    await render({
      ...baseInput,
      history: moreHistory,
      lastCompletedAssistantMessageId: 'blocked-assistant-turn-2',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(
      capture.mock.calls.filter(
        ([eventName]) => eventName === 'mobile/app_store_review_prompt_blocked'
      )
    ).toHaveLength(1);
  });
});
