/**
 * Explicit side-effect ports for e2ee-core.
 *
 * Pure TS (no Effect, no I/O): codecs, hashes, signature algorithms, policy,
 * and ledger state transitions (`Ledger.verify` / `extend` / `prepare`).
 *
 * Capabilities below are injected by callers. Live defaults use secure entropy
 * and real clocks; tests replace them. Ordinary callers never pick nonces.
 *
 * Effect entrypoints (C2+): `LedgerClient.submit` / `resume` and later delivery,
 * recovery, and snapshot admission. Promise wrappers stay thin and call the
 * same implementation. This file does not create an Effect runtime.
 *
 * Ownership:
 * - Entropy / Clock / TimerSchedule / CryptoPlatform: this module
 * - SignatureVerifyExecutor: sequential default here; Node worker adapter is
 *   opt-in via `@lody/e2ee-core/ledger-node`
 * - Storage / streams: existing `LedgerStore` / `LedgerStream` ports
 * - Live authority: caller policy (`ContentPolicy`, admission `mayWriteDocument`)
 *
 * Uninjected (documented gaps, not replay-closed):
 * - Loro/Flock Wasm physical clocks belong to those libraries
 * - noble-ed25519 `hashes.sha512` is pinned at module init and is not a
 *   public verification bypass
 *
 * Lab clients bind Loro/Flock peer IDs from Entropy (`loro-peer-id` /
 * `flock-peer-id`) through the library `setPeerId` / constructor. That is not
 * a Wasm clock hook.
 *
 * HPKE DHKEM: production `seal` omits `ekm` so `@hpke/core` uses WebCrypto
 * `generateKeyPair`. Tests may pass Entropy; IKM is filled as
 * `hpke-dhkem-ikm` (32 bytes) and supplied to the library `ekm` hook.
 * Algorithms stay RFC 9180 DeriveKeyPair; this is not a crypto rewrite.
 */

export interface Entropy {
  /** Fill `bytes` in place. `label` is a replay tag and is not mixed into bits. */
  fill(label: string, bytes: Uint8Array): Uint8Array;
}

export interface Clock {
  /** Trusted Unix milliseconds. */
  now(): number;
}

export interface TimerHandle {
  clear(): void;
}

export type TimerSchedule = (ms: number, fire: () => void) => TimerHandle;

export type CryptoPlatform = Pick<Crypto, 'subtle' | 'getRandomValues'>;

export interface SignatureJob {
  readonly pk: Uint8Array;
  readonly msg: Uint8Array;
  readonly sig: Uint8Array;
}

export interface SignatureVerifyExecutor {
  verify(jobs: readonly SignatureJob[]): Promise<boolean[]>;
}

export const liveEntropy: Entropy = {
  fill(_label, bytes) {
    crypto.getRandomValues(bytes);
    return bytes;
  },
};

export const liveClock: Clock = {
  now: () => Date.now(),
};

export const liveTimerSchedule: TimerSchedule = (ms, fire) => {
  const id = setTimeout(fire, ms);
  return {
    clear() {
      clearTimeout(id);
    },
  };
};

export const liveCryptoPlatform: CryptoPlatform = globalThis.crypto;
