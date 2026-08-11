// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionGoalMessage } from '@lody/shared';
import { isAppForeground, shouldNotifySessionCompletion } from '../src/lib/session-completion-notification';

const activeGoal: SessionGoalMessage = {
  type: 'goal',
  threadId: 'thread-1',
  turnId: 'assistant-goal-1',
  objective: 'Keep working',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 100,
  timeUsedSeconds: 60,
  createdAt: 100,
  updatedAt: 200,
};

describe('shouldNotifySessionCompletion', () => {
  it('notifies when a normal active turn transitions to idle', () => {
    expect(
      shouldNotifySessionCompletion({
        initialized: true,
        enabled: true,
        previousStatusType: 'running',
        currentStatusType: 'idle',
        latestGoal: null,
      })
    ).toBe(true);
  });

  it('notifies when a prompt completes while a persistent goal remains active', () => {
    expect(
      shouldNotifySessionCompletion({
        initialized: true,
        enabled: true,
        previousStatusType: 'running',
        currentStatusType: 'idle',
        latestGoal: activeGoal,
      })
    ).toBe(true);
  });

  it('does not suppress when the latest goal is no longer active', () => {
    expect(
      shouldNotifySessionCompletion({
        initialized: true,
        enabled: true,
        previousStatusType: 'running',
        currentStatusType: 'idle',
        latestGoal: { ...activeGoal, status: 'complete' },
      })
    ).toBe(true);
  });
});

describe('isAppForeground', () => {
  function mockVisibilityState(value: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => value,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    mockVisibilityState('visible');
  });

  it('returns true when the document is visible and focused', () => {
    mockVisibilityState('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    expect(isAppForeground()).toBe(true);
  });

  it('returns false when the document is hidden', () => {
    mockVisibilityState('hidden');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    expect(isAppForeground()).toBe(false);
  });

  it('returns false when the document is visible but not focused', () => {
    mockVisibilityState('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(isAppForeground()).toBe(false);
  });
});
