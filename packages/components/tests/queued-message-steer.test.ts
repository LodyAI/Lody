import { describe, expect, it } from 'vitest';
import { shouldRequestNativeQueueSteer } from '../src/components/sessions/message-queue/queued-message-steer';

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
