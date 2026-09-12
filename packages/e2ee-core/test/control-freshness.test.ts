import { describe, expect, it } from 'vitest';
import { ControlFreshnessLease, type TrustedControlObservation } from '../src/index';

const genesis = '01'.repeat(32);
const checkpoint = { head: '02'.repeat(32), length: 4 };
const observation: TrustedControlObservation = {
  genesis,
  ...checkpoint,
  observedAt: 1000,
  expiresAt: 901000,
};

describe('fixed control freshness lease', () => {
  it('does not extend expiry on receipt, repeated use or reconstruction', () => {
    let now = 900000;
    const lease = new ControlFreshnessLease(genesis, observation, () => now);
    lease.assert(checkpoint);
    now = 900999;
    lease.assert(checkpoint);
    const restarted = new ControlFreshnessLease(genesis, observation, () => now);
    restarted.assert(checkpoint);
    now = 901000;
    expect(() => lease.assert(checkpoint)).toThrow('freshness-expired');
    expect(() => restarted.assert(checkpoint)).toThrow('freshness-expired');
    expect(() => new ControlFreshnessLease(genesis, observation, () => now)).toThrow(
      'freshness-expired'
    );
  });

  it('cannot revive an expired, logged-out or clock-invalidated instance', () => {
    let now = 1000;
    const expired = new ControlFreshnessLease(genesis, observation, () => now);
    const loggedOut = new ControlFreshnessLease(genesis, observation, () => now);
    loggedOut.invalidate();
    now = observation.expiresAt;
    expect(() => expired.assert(checkpoint)).toThrow('freshness-expired');
    now = 1000;
    expect(() => expired.assert(checkpoint)).toThrow('freshness-invalidated');
    expect(() => loggedOut.assert(checkpoint)).toThrow('freshness-invalidated');
    const rollback = new ControlFreshnessLease(genesis, observation, () => now);
    now = 2000;
    rollback.assert(checkpoint);
    now = 1999;
    expect(() => rollback.assert(checkpoint)).toThrow('freshness-clock-rollback');
    now = 2001;
    expect(() => rollback.assert(checkpoint)).toThrow('freshness-invalidated');
  });

  it('pins the exact checkpoint and copies caller input', () => {
    const mutable = { ...observation };
    const lease = new ControlFreshnessLease(genesis, mutable, () => 2000);
    Object.assign(mutable, { head: '03'.repeat(32), length: 5, expiresAt: 999999 });
    lease.assert(checkpoint);
    expect(() => lease.assert({ head: mutable.head, length: mutable.length })).toThrow(
      'freshness-checkpoint-mismatch'
    );
    expect(() => lease.assert({ ...checkpoint, length: 3 })).toThrow(
      'freshness-checkpoint-mismatch'
    );
    expect(() => new ControlFreshnessLease('04'.repeat(32), observation, () => 2000)).toThrow(
      'wrong-freshness-org'
    );
  });

  it('rejects invalid times, excessive windows and impossible checkpoints', () => {
    for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        () => new ControlFreshnessLease(genesis, { ...observation, observedAt: value }, () => 2000)
      ).toThrow();
      expect(
        () => new ControlFreshnessLease(genesis, { ...observation, expiresAt: value }, () => 2000)
      ).toThrow();
      expect(() => new ControlFreshnessLease(genesis, observation, () => value)).toThrow();
    }
    for (const update of [
      { expiresAt: 901001 },
      { expiresAt: 1000 },
      { expiresAt: 999 },
      { length: 0 },
      { length: -1 },
      { length: 1.5 },
      { head: genesis },
    ])
      expect(
        () => new ControlFreshnessLease(genesis, { ...observation, ...update }, () => 2000)
      ).toThrow();
    expect(() => new ControlFreshnessLease(genesis, observation, () => 999)).toThrow(
      'freshness-clock-rollback'
    );
    new ControlFreshnessLease(
      genesis,
      { ...observation, head: genesis, length: 0 },
      () => 2000
    ).assert({ head: genesis, length: 0 });
  });

  it('makes clock failure terminal even if the clock later recovers', () => {
    let available = true;
    const lease = new ControlFreshnessLease(genesis, observation, () => {
      if (!available) throw new Error('clock unavailable');
      return 2000;
    });
    available = false;
    expect(() => lease.assert(checkpoint)).toThrow('clock unavailable');
    available = true;
    expect(() => lease.assert(checkpoint)).toThrow('freshness-invalidated');
  });
});
