import { Effect } from 'effect';

export type HostKeyPurpose = 'personal-device' | 'machine';

/** Assigned by the authenticated host, never copied from an untrusted packet. */
export interface HostKeyRef {
  readonly accountId: string;
  readonly deviceId: string;
}

/** Canonical lowercase hex, 32 bytes each. No private material crosses this port. */
export interface HostPublicKeys {
  readonly ed25519: string;
  readonly x25519: string;
}

export interface HostKeyFailure {
  readonly _tag: 'HostKeyFailure';
  readonly kind:
    | 'missing'
    | 'already-exists'
    | 'unavailable'
    | 'invalid-record'
    | 'identity-mismatch'
    | 'unsupported';
  /** Authentication failure alone cannot distinguish locked, denied or damaged. */
  readonly reason: 'unknown';
  readonly nativeStatus?: number;
  /** Unknown creation outcome must be reconciled by read, never overwrite/retry. */
  readonly creationOutcome?: 'unknown';
}

export const hostKeyFailure = (
  kind: HostKeyFailure['kind'],
  nativeStatus?: number
): HostKeyFailure => ({ _tag: 'HostKeyFailure', kind, reason: 'unknown', nativeStatus });

/** Failure codes only; zero is success and must not be passed here. No raw messages. */
export function macOSKeyFailure(status: number): HostKeyFailure {
  return hostKeyFailure(
    status === -25300 ? 'missing' : status === -25299 ? 'already-exists' : 'unavailable',
    status
  );
}

/** Host-only implementation seam. Not an IPC handler or a renderer capability. */
export interface HostIdentityBackend {
  /** Persistent OS/browser storage and actual execution location are separate facts. */
  readonly storage: string;
  readonly execution: 'host-software' | 'webcrypto' | 'web-software';
  /** Must fail without UI when access is unavailable; a timeout is not that proof. */
  readonly interaction: 'forbid';
  /** Atomic insert only, never replace. Return the generated public identity. */
  readonly create: (
    purpose: HostKeyPurpose,
    ref: HostKeyRef
  ) => Effect.Effect<HostPublicKeys, HostKeyFailure>;
  /** Read existing material. Missing must never cause generation or deletion. */
  readonly read: (
    purpose: HostKeyPurpose,
    ref: HostKeyRef
  ) => Effect.Effect<HostPublicKeys, HostKeyFailure>;
}

export interface HostIdentityStore<P extends HostKeyPurpose> {
  readonly purpose: P;
  /** Reconcile an uncertain create. Discovery alone never enrolls/authorizes a device. */
  readonly inspect: (ref: HostKeyRef) => Effect.Effect<HostPublicKeys, HostKeyFailure>;
  readonly create: (ref: HostKeyRef) => Effect.Effect<HostPublicKeys, HostKeyFailure>;
  readonly read: (
    ref: HostKeyRef,
    expected: HostPublicKeys
  ) => Effect.Effect<HostPublicKeys, HostKeyFailure>;
}

const validKeys = (keys: HostPublicKeys) =>
  /^[0-9a-f]{64}$/.test(keys.ed25519) && /^[0-9a-f]{64}$/.test(keys.x25519);
const equalKeys = (a: HostPublicKeys, b: HostPublicKeys) =>
  a.ed25519 === b.ed25519 && a.x25519 === b.x25519;

/** Compose in the trusted host. CLI composition may construct only `machine`.
 * This port holds no private-key handle: ending a call never deletes storage.
 * Purpose-specific crypto operations await the reviewed protocol implementation.
 */
export function makeHostIdentityStore<P extends HostKeyPurpose>(
  purpose: P,
  backend: HostIdentityBackend
): HostIdentityStore<P> {
  const inspect = (input: HostKeyRef) => {
    const ref = { ...input };
    return Effect.gen(function* () {
      const actual = yield* backend.read(purpose, ref);
      if (!validKeys(actual)) return yield* Effect.fail(hostKeyFailure('invalid-record'));
      return { ...actual };
    });
  };
  const read = (input: HostKeyRef, expectedInput: HostPublicKeys) => {
    const ref = { ...input };
    const expected = { ...expectedInput };
    return Effect.gen(function* () {
      if (!validKeys(expected)) return yield* Effect.fail(hostKeyFailure('invalid-record'));
      const actual = yield* inspect(ref);
      if (!equalKeys(actual, expected)) {
        return yield* Effect.fail(hostKeyFailure('identity-mismatch'));
      }
      return { ...actual };
    });
  };
  return {
    purpose,
    inspect,
    read,
    create: (input) => {
      const ref = { ...input };
      return Effect.gen(function* () {
        const expected = yield* backend
          .create(purpose, ref)
          .pipe(
            Effect.mapError((error) =>
              error.kind === 'already-exists' || error.kind === 'unsupported'
                ? error
                : { ...error, creationOutcome: 'unknown' as const }
            )
          );
        // The write may have succeeded even if readback or validation fails.
        return yield* read(ref, expected).pipe(
          Effect.mapError((error) => ({ ...error, creationOutcome: 'unknown' as const }))
        );
      });
    },
  };
}
