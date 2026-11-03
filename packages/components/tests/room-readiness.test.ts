import { describe, expect, it } from 'vitest';
import type { RepoRoomSubscription } from 'loro-repo';
import { readinessBinding } from '../src/lib/room-readiness';

const makeSub = (transportIds: string[]): RepoRoomSubscription => {
  const bindings = new Map<string, { transportId: string }>();
  const subscription = (transportId: string) => {
    let binding = bindings.get(transportId);
    if (!binding) {
      binding = { transportId };
      bindings.set(transportId, binding);
    }
    return binding;
  };
  return {
    transportIds: () => transportIds,
    subscription,
    subscriptions: () => transportIds.map(subscription),
  } as unknown as RepoRoomSubscription;
};

describe('readinessBinding', () => {
  it('prefers the local plane on dual-homed rooms', () => {
    expect(readinessBinding(makeSub(['local', 'cloud'])).transportId).toBe('local');
  });

  it('falls back to cloud for multi-transport routes without local', () => {
    expect(readinessBinding(makeSub(['a', 'cloud'])).transportId).toBe('cloud');
  });
});
