import type { ChainSnapshot } from './chain';
import { checkHex, invariant } from './wire';

/** Trusted application input, NOT a wire format or an authenticated server response.
 * The caller must authenticate the observation and its Org binding before construction.
 * observedAt is when the authoritative head was observed, not receipt/cache insertion time.
 * expiresAt must already deduct the application's clock/delivery/enforcement budget. */
export interface TrustedControlObservation {
  readonly genesis: string;
  readonly head: string;
  readonly length: number;
  readonly observedAt: number;
  readonly expiresAt: number;
}

const MAX_WINDOW_MS = 15 * 60 * 1000;

function timestamp(value: number): void {
  invariant(Number.isSafeInteger(value) && value >= 0, 'invalid-freshness-time');
}

/** Local checkpoint/time guard, not device authentication or a cloud access token.
 * Supply a trusted Unix-millisecond clock (including conservative clock uncertainty).
 * Date.now alone is not a server clock proof. A new instance retains the original
 * absolute deadline; only a newly authenticated observation may renew authority. */
export class ControlFreshnessLease {
  private readonly observation: TrustedControlObservation;
  private lastTime = 0;
  private invalidated = false;

  constructor(
    genesis: string,
    observation: TrustedControlObservation,
    private readonly now: () => number
  ) {
    const stable = { ...observation };
    checkHex(genesis, 32);
    checkHex(stable.head, 32);
    invariant(stable.genesis === genesis, 'wrong-freshness-org');
    invariant(
      Number.isSafeInteger(stable.length) && stable.length >= 0,
      'invalid-freshness-length'
    );
    invariant((stable.length === 0) === (stable.head === genesis), 'invalid-freshness-checkpoint');
    timestamp(stable.observedAt);
    timestamp(stable.expiresAt);
    invariant(
      stable.expiresAt > stable.observedAt && stable.expiresAt - stable.observedAt <= MAX_WINDOW_MS,
      'invalid-freshness-window'
    );
    this.observation = stable;
    this.checkTime();
  }

  /** Logout or known revocation is permanent for this lease, including future calls. */
  invalidate(): void {
    this.invalidated = true;
  }

  private checkTime(): void {
    invariant(!this.invalidated, 'freshness-invalidated');
    try {
      const time = this.now();
      timestamp(time);
      invariant(
        time >= this.lastTime && time >= this.observation.observedAt,
        'freshness-clock-rollback'
      );
      invariant(time < this.observation.expiresAt, 'freshness-expired');
      this.lastTime = time;
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  /** Use as OrgKeyExchange's guard via snapshot => lease.assert(snapshot).
   * Only the exact observed checkpoint is covered, not an unproven later head. */
  assert(snapshot: Pick<ChainSnapshot<unknown>, 'head' | 'length'>): void {
    this.checkTime();
    invariant(
      snapshot.head === this.observation.head && snapshot.length === this.observation.length,
      'freshness-checkpoint-mismatch'
    );
  }
}
