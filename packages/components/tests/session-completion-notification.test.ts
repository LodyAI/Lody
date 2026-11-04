// @vitest-environment jsdom

// @vitest-environment jsdom
// @vitest-environment jsdom
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { SessionGoalMessage } from '@lody/shared';
import { shouldNotifySessionCompletion } from '../src/lib/session-completion-notification';

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
});
