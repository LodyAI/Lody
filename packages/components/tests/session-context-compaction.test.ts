import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';

import { canStopAgentEnabled, isSessionContextCompacting } from '../src/lib/session-context-compaction';

const historyWithStatus = (status: 'pending' | 'in_progress' | 'completed' | 'failed') =>
  [
    {
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
  ] as Pick<SessionHistory, 'items'>[];

describe('isSessionContextCompacting', () => {
  it('tracks pending and in-progress compaction tool calls', () => {
    expect(isSessionContextCompacting(historyWithStatus('pending'))).toBe(true);
    expect(isSessionContextCompacting(historyWithStatus('in_progress'))).toBe(true);
  });

  it('stops loading after compaction completes or fails', () => {
    expect(isSessionContextCompacting(historyWithStatus('completed'))).toBe(false);
    expect(isSessionContextCompacting(historyWithStatus('failed'))).toBe(false);
  });
});

describe('canStopAgentEnabled', () => {
  const base = {
    isContextCompacting: false,
    isSessionActive: false,
    activeAssistantTurnId: null,
    isGoalActive: false,
    canPauseGoal: false,
  };

  it('does not expose Stop during compaction without a cancellable turn', () => {
    // A pending/in-progress compaction marker remains in history but its
    // assistant entry is already finished (restart, interrupted notification
    // stream). Stop must NOT be shown — clicking it would be rejected as
    // missing_active_turn, leaving a permanently nonfunctional button.
    expect(
      canStopAgentEnabled({ ...base, isContextCompacting: true, activeAssistantTurnId: null })
    ).toBe(false);
  });

  it('exposes Stop during compaction when a cancellable turn exists', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isContextCompacting: true,
        activeAssistantTurnId: 'turn-1',
      })
    ).toBe(true);
  });

  it('exposes Stop for an active assistant turn regardless of compaction', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isSessionActive: true,
        activeAssistantTurnId: 'turn-2',
      })
    ).toBe(true);
  });

  it('does not expose Stop for an active session without a turn', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isSessionActive: true,
        activeAssistantTurnId: null,
      })
    ).toBe(false);
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
