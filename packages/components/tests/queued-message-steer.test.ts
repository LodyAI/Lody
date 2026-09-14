import { describe, expect, it } from 'vitest';
import {
  resolveQueuedMessageSteerRoute,
  shouldUseLegacyNativeQueueSteer,
} from '../src/components/sessions/message-queue';

describe('legacy queued-message steering', () => {
  it('uses true native steering only for an authoritative acknowledged capability', () => {
    expect(shouldUseLegacyNativeQueueSteer('authoritative', { acknowledgedSteer: true })).toBe(
      true
    );
    expect(shouldUseLegacyNativeQueueSteer('authoritative', { acknowledgedSteer: false })).toBe(
      false
    );
    expect(shouldUseLegacyNativeQueueSteer('provisional', { acknowledgedSteer: true })).toBe(false);
    expect(shouldUseLegacyNativeQueueSteer('unavailable', undefined)).toBe(false);
  });

  it('routes new renderers across new and old daemon capability combinations', () => {
    expect(
      resolveQueuedMessageSteerRoute({
        supportsExactDaemonProtocol: true,
        authority: 'authoritative',
        capability: { acknowledgedSteer: true },
      })
    ).toBe('exact-daemon');
    expect(
      resolveQueuedMessageSteerRoute({
        supportsExactDaemonProtocol: false,
        authority: 'authoritative',
        capability: { acknowledgedSteer: true },
      })
    ).toBe('legacy-native');
    expect(
      resolveQueuedMessageSteerRoute({
        supportsExactDaemonProtocol: false,
        authority: 'authoritative',
        capability: { acknowledgedSteer: false },
      })
    ).toBe('legacy-head');
    expect(
      resolveQueuedMessageSteerRoute({
        supportsExactDaemonProtocol: false,
        authority: 'provisional',
        capability: { acknowledgedSteer: true },
      })
    ).toBe('legacy-head');
  });
});
