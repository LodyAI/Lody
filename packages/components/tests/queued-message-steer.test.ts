import { describe, expect, it } from 'vitest';
import {
  shouldRequestNativeQueueSteer,
  shouldShowQueuedItemSteer,
} from '../src/components/sessions/message-queue/queued-message-steer';

describe('shouldRequestNativeQueueSteer', () => {
  it.each([
    ['authoritative', { acknowledgedSteer: true }, true],
    ['authoritative', { acknowledgedSteer: false }, false],
    ['authoritative', undefined, false],
    ['provisional', { acknowledgedSteer: true }, false],
    ['unavailable', { acknowledgedSteer: true }, false],
  ] as const)('routes %s capability %o to native steer: %s', (authority, capability, expected) => {
    expect(shouldRequestNativeQueueSteer(authority, capability)).toBe(expected);
  });
});

describe('shouldShowQueuedItemSteer', () => {
  it.each([
    ['first row, native available', { isFirst: true, nativeSteerAvailable: true }, true],
    ['first row, native unavailable', { isFirst: true, nativeSteerAvailable: false }, true],
    ['later row, native available', { isFirst: false, nativeSteerAvailable: true }, true],
    ['later row, native unavailable', { isFirst: false, nativeSteerAvailable: false }, false],
  ] as const)('shows steer for %s: %s', (_label, row, expected) => {
    expect(shouldShowQueuedItemSteer({ showSteerAction: true, ...row })).toBe(expected);
  });

  it('hides steer everywhere when the action itself is off', () => {
    expect(
      shouldShowQueuedItemSteer({
        showSteerAction: false,
        isFirst: true,
        nativeSteerAvailable: true,
      })
    ).toBe(false);
  });
});
