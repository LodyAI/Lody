import { describe, expect, it } from 'vitest';
import { deliveryStep, explore, exploreDelivery, exploreSubmit, submitStep } from './ledger-model';

describe('M1 bounded authorization exploration', () => {
  it('enumerates reachable Lean-equivalent states and records out-of-model events', () => {
    const bounds = { maxMember: 1, maxDevice: 3, maxEpoch: 1, maxDepth: 6 };
    const result = explore(bounds);
    const submit = exploreSubmit();
    const delivery = exploreDelivery();
    process.stdout.write(
      `${JSON.stringify({ bounds, ...result, submit, delivery, fairness: 'every enabled op at every state; no scheduler luck' }, null, 2)}\n`
    );
    expect(result.states).toBeGreaterThan(8);
    expect(result.maxDepthReached).toBeGreaterThanOrEqual(3);
    expect(result.enabled).toBeGreaterThan(result.states);
    expect(result.rejected).toBeGreaterThan(result.enabled);
    expect(result.recoveryStates).toBeGreaterThan(0);
    expect(result.retiredStates).toBeGreaterThan(0);
    expect(submit.states).toBeGreaterThan(3);
    expect(delivery.states).toBeGreaterThan(3);
    expect(result.outOfBound).toEqual(
      expect.arrayContaining([
        'R2 Passkey wrap not in authorization or submit/delivery step',
        'cross-Org not in single-Org step',
      ])
    );
    expect(result.outOfBound).not.toEqual(
      expect.arrayContaining([
        'L5 CAS fork/lost-ACK not in authorization step',
        'K3 in-flight encrypt/revoke not in authorization step',
        'D1 owner-transfer in step (D1 A)',
        'D5 setRole→guest omitted (Guest unreachable)',
      ])
    );
    const lost = submitStep(
      { phase: 'pending', candidate: 'A', remote: 'empty', lostAck: false, falseAck: false },
      { type: 'loseAck' }
    );
    expect(lost).toMatchObject({ phase: 'pending', candidate: 'A', remote: 'A', lostAck: true });
    expect(submitStep(lost!, { type: 'readBack' })).toMatchObject({
      phase: 'committed',
      candidate: 'A',
    });
    const stale = submitStep(
      { phase: 'pending', candidate: 'B', remote: 'A', lostAck: false, falseAck: false },
      { type: 'cas' }
    );
    expect(stale).toMatchObject({ phase: 'conflict', candidate: 'B' });
    const barrier = deliveryStep(
      { recipient: 'active', outbox: 'empty', remote: 'empty', phase: 'authorizing' },
      { type: 'revoke' }
    );
    expect(barrier).toMatchObject({ recipient: 'revoked', outbox: 'empty', phase: 'idle' });
    expect(
      deliveryStep(
        { recipient: 'revoked', outbox: 'empty', remote: 'empty', phase: 'idle' },
        { type: 'persist' }
      )
    ).toBeNull();
  });
});
