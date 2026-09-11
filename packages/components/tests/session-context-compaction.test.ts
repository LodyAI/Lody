import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';

import {
  findActiveSessionContextCompaction,
  isSessionContextCompacting,
} from '../src/lib/session-context-compaction';

const historyWithStatus = (
  status: 'pending' | 'in_progress' | 'completed' | 'failed',
  finished = false
) =>
  [
    {
      id: 'assistant:turn-1',
      role: 'assistant' as const,
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
  ] as Pick<SessionHistory, 'id' | 'role' | 'finished' | 'items'>[];

describe('isSessionContextCompacting', () => {
  it('tracks pending and in-progress compaction tool calls', () => {
    expect(isSessionContextCompacting(historyWithStatus('pending'))).toBe(true);
    expect(isSessionContextCompacting(historyWithStatus('in_progress'))).toBe(true);
  });

  it('returns the exact active activity owner for reconciliation', () => {
    expect(findActiveSessionContextCompaction(historyWithStatus('in_progress'))).toEqual({
      turnId: 'assistant:turn-1',
      toolCallId: 'context-compaction-1',
      status: 'in_progress',
      turnFinished: false,
    });
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
