import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';

import {
  canStopAgentEnabled,
  isSessionContextCompacting,
} from '../src/lib/session-context-compaction';

const historyWithStatus = (
  status: 'pending' | 'in_progress' | 'completed' | 'failed',
  finished = false
) =>
  [
    {
      finished,
      items: [
        {
          type: 'tool_call',
          toolCallId: 'context-compaction-1',
          title: 'Context compacting',
          status,
          activityKind: 'context_compaction',
        },
      ],
    },
  ] as Pick<SessionHistory, 'finished' | 'items'>[];

describe('isSessionContextCompacting', () => {
  it('tracks pending and in-progress compaction tool calls', () => {
    expect(isSessionContextCompacting(historyWithStatus('pending'))).toBe(true);
    expect(isSessionContextCompacting(historyWithStatus('in_progress'))).toBe(true);
  });

  it('stops loading after compaction completes or fails', () => {
    expect(isSessionContextCompacting(historyWithStatus('completed'))).toBe(false);
    expect(isSessionContextCompacting(historyWithStatus('failed'))).toBe(false);
  });

  it('does not treat host turn finalization as provider termination', () => {
    expect(isSessionContextCompacting(historyWithStatus('pending', true))).toBe(true);
    expect(isSessionContextCompacting(historyWithStatus('in_progress', true))).toBe(true);
  });
});

describe('canStopAgentEnabled', () => {
  const base = {
    activeAssistantTurnId: null,
    isGoalActive: false,
    canPauseGoal: false,
  };

  it('exposes Stop exactly while an assistant turn is unfinished', () => {
    // No live-activity input exists: a turn whose agent died is still
    // unfinished and must stay stoppable.
    expect(canStopAgentEnabled({ ...base, activeAssistantTurnId: 'turn-1' })).toBe(true);
    expect(canStopAgentEnabled(base)).toBe(false);
  });

  it('exposes Stop for a pausable goal', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isGoalActive: true,
        canPauseGoal: true,
      })
    ).toBe(true);
  });

  it('does not expose Stop for an unpausable goal', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isGoalActive: true,
        canPauseGoal: false,
      })
    ).toBe(false);
  });
});
