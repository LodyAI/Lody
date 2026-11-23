import { describe, expect, it } from 'vitest';

import { resolveSessionLiveStatus } from './session-live-status';

const idleExecution = {
  hasActiveTurn: false,
  hasBlockingPendingCreate: false,
  hasReusableSession: false,
};

describe('resolveSessionLiveStatus', () => {
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
});
