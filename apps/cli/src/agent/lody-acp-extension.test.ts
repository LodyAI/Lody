import { describe, expect, it } from 'vitest';
import { LODY_EXTENSION_METHODS } from 'acp-extension-core';
import { parseRateLimitsSnapshot, parseLodyExtensionMessage } from './lody-acp-extension';

describe('rate-limit window labels', () => {
  const window = { usedPercent: 0, windowDurationSeconds: 604_800, resetsAtEpochSeconds: null };
  const snapshot = {
    rateLimits: [
      {
        limitId: 'claude',
        scope: { providerId: 'claude' },
        windows: [window, { ...window, label: 'Fable' }],
      },
    ],
  };

  it('preserves same-duration labeled windows in query responses', () => {
    expect(parseRateLimitsSnapshot(snapshot)).toEqual(snapshot);
  });

  it('preserves labels in proactive updates', () => {
    expect(
      parseLodyExtensionMessage({
        method: LODY_EXTENSION_METHODS.rateLimitsUpdate,
        params: snapshot,
        provider: 'claude',
        sessionId: 'synthetic-session',
      })
    ).toEqual({ type: 'rateLimits', snapshot });
  });
});
