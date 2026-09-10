import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';

import {
  isSessionContextCompacting,
  resolveContextCompactionDisplayStatus,
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

describe('resolveContextCompactionDisplayStatus', () => {
  it('ends an unresolved compaction when its owning turn has finished', () => {
    expect(resolveContextCompactionDisplayStatus('pending', true)).toBe('failed');
    expect(resolveContextCompactionDisplayStatus('in_progress', true)).toBe('failed');
  });

  it('preserves active compactions and provider terminal states', () => {
    expect(resolveContextCompactionDisplayStatus('pending', false)).toBe('pending');
    expect(resolveContextCompactionDisplayStatus('in_progress', false)).toBe('in_progress');
    expect(resolveContextCompactionDisplayStatus('completed', true)).toBe('completed');
    expect(resolveContextCompactionDisplayStatus('failed', true)).toBe('failed');
  });
});

describe('isSessionContextCompacting', () => {
  it('tracks pending and in-progress compaction tool calls', () => {
    expect(isSessionContextCompacting(historyWithStatus('pending'))).toBe(true);
    expect(isSessionContextCompacting(historyWithStatus('in_progress'))).toBe(true);
  });

  it('stops loading after compaction completes or fails', () => {
    expect(isSessionContextCompacting(historyWithStatus('completed'))).toBe(false);
    expect(isSessionContextCompacting(historyWithStatus('failed'))).toBe(false);
  });

  it('stops loading when the owning turn finishes without a terminal tool update', () => {
    expect(isSessionContextCompacting(historyWithStatus('pending', true))).toBe(false);
    expect(isSessionContextCompacting(historyWithStatus('in_progress', true))).toBe(false);
  });
});
