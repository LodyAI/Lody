import { describe, expect, it } from 'vitest';
import { SessionStatusFactory } from '@lody/shared';
import { resolveSessionLiveStatus } from './session-live-status';

const idleExecution = {
  hasActiveTurn: false,
  hasBlockingPendingCreate: false,
  hasReusableSession: false,
};

describe('resolveSessionLiveStatus', () => {
  it('maps permission presence to waiting', () => {
    expect(
      resolveSessionLiveStatus({
        presence: SessionStatusFactory.requestPermission(),
        execution: idleExecution,
        hasPendingDispatch: false,
      })
    ).toEqual({ state: 'waiting' });
  });

  it('reports active execution before presence as initializing', () => {
    expect(
      resolveSessionLiveStatus({
        presence: null,
        execution: { ...idleExecution, hasActiveTurn: true },
        hasPendingDispatch: false,
      })
    ).toEqual({ state: 'initializing' });
  });

  it('reports an unconfirmed release as busy waiting with its reason, not initializing', () => {
    const live = resolveSessionLiveStatus({
      presence: null,
      execution: {
        ...idleExecution,
        hasActiveTurn: true,
        releaseBlocked: { reason: 'release outage' },
      },
      hasPendingDispatch: false,
    });
    expect(live).toEqual({
      state: 'waiting',
      reason: 'The previous turn has not confirmed releasing its resources: release outage',
    });
    // Fork and MCP treat every state except `unknown` as busy.
    expect(live.state).not.toBe('unknown');
  });

  it('reports an acknowledged pending dispatch as waiting', () => {
    expect(
      resolveSessionLiveStatus({
        presence: null,
        execution: idleExecution,
        hasPendingDispatch: true,
      })
    ).toEqual({ state: 'waiting' });
  });

  it('does not infer idle without positive daemon evidence', () => {
    expect(
      resolveSessionLiveStatus({
        presence: null,
        execution: idleExecution,
        hasPendingDispatch: false,
      })
    ).toEqual({
      state: 'unknown',
      reason: 'No active session presence or pending daemon work was observed.',
    });
  });

  it('prefers running presence over pending signals', () => {
    expect(
      resolveSessionLiveStatus({
        presence: SessionStatusFactory.running(),
        execution: { ...idleExecution, hasActiveTurn: true },
        hasPendingDispatch: true,
      })
    ).toEqual({ state: 'running' });
  });
});
