import { Context, type Effect, Result, Schema } from 'effect';
import type { GenesisHash, SigningPublicKey } from '../internal/foundation/bytes';
import { LocalStoreError } from './errors';

/** Routing slot known before reading an installation; genesis is independently pinned, not a server label. */
export interface ClientCustodyScope {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly genesis: GenesisHash;
}

/**
 * One personal-device installation. Capture and validate this entire binding
 * when acquiring either port, never from a ciphertext or a server hint. Account
 * and workspace identifiers are routing scope, not authority; genesis is pinned
 * independently and device is the expected signing identity. installationId is
 * lowercase hex of 32 secure random bytes retained before creating protection, never a PID,
 * timestamp or substitute for desktop approval.
 */
export interface ClientCustodyBinding extends ClientCustodyScope {
  readonly device: SigningPublicKey;
  readonly installationId: string;
}

/** Closed local-wrapping purposes; installed and unpublished keys remain distinct capabilities. */
export const CLIENT_KEY_PURPOSES = Object.freeze([
  'signing-private-key',
  'encryption-private-key',
  'device-credential',
  'installed-epoch-key',
  'rotation-candidate',
] as const);

/** One of the fixed local-wrapping purpose strings shared by all platform adapters. */
export type ClientKeyPurpose = (typeof CLIENT_KEY_PURPOSES)[number];

/** Protection availability only; even available grants no ledger or runtime authority. */
export type ClientCustodyStatus =
  | 'missing'
  | 'locked'
  | 'available'
  | 'unavailable'
  | 'indeterminate';

/**
 * Content-free failure. locked waits for platform unlock; unavailable refuses
 * protected opening. identity-lost, corrupt and indeterminate preserve originals
 * and require desktop reapproval unless the exact interrupted install can be
 * reconciled. conflict never displaces a competing writer. No error authorizes
 * a new identity, file/plaintext fallback or deletion.
 */
export class ClientCustodyError extends Schema.TaggedError<ClientCustodyError>()(
  'ClientCustodyError',
  {
    reason: Schema.Literals([
      'locked',
      'unavailable',
      'identity-lost',
      'corrupt',
      'indeterminate',
      'conflict',
      'closed',
    ]),
  }
) {}

/**
 * Narrow trusted-platform boundary, captured for one complete binding. Web uses
 * a persisted non-extractable AES-GCM KEK; mobile uses device-bound native
 * protection. It never exports the KEK, signs, verifies, accesses arbitrary
 * files, or decides approval. wrap/unwrap authenticate version, complete binding
 * and purpose using the client custody Spec's local wrapping v1 encoding;
 * blobs own their bytes. No transaction spans crypto/native work.
 *
 * The acquiring Scope owns admission and native settlement: reject new work on
 * close, join actual operations before wiping borrowed input or releasing the
 * writer, and retain uncertain installation outcomes for reconciliation. A
 * cancelled waiter or elapsed deadline never proves native termination.
 */
export class ClientKeyCustody extends Context.Service<
  ClientKeyCustody,
  {
    /** Exact captured scope, including the retained installation incarnation. */
    readonly binding: ClientCustodyBinding;
    /** Observe without creating or replacing any key; missing is never permission to initialize. */
    status(): Effect.Effect<ClientCustodyStatus, ClientCustodyError>;
    /**
     * Explicit new installation or replacement candidate only, after durable
     * preparation and pairing consent. A replacement candidate does not select
     * current identity; only the store's post-approval replace may do that.
     * Persist/read back the KEK; identical retry reconciles the
     * same installation, never regenerates a missing retained KEK or replaces
     * residual or uncertain state.
     */
    create(): Effect.Effect<void, ClientCustodyError>;
    /** Secure nonce unique under this KEK across writers/recovery; borrow input until settlement and return owned ciphertext. */
    wrap(
      purpose: ClientKeyPurpose,
      body: Uint8Array
    ): Effect.Effect<Uint8Array, ClientCustodyError>;
    /**
     * Exact authenticated body or failure. The caller atomically acquires the
     * returned plaintext with wipe registration (acquireRelease/acquireUseRelease),
     * so interruption cannot abandon native output before cleanup owns it.
     */
    unwrap(
      purpose: ClientKeyPurpose,
      blob: Uint8Array
    ): Effect.Effect<Uint8Array, ClientCustodyError>;
    /**
     * Explicit scoped hard reset or authenticated terminal removal only, after
     * users drain; never close/logout/cache cleanup. Compare the retained
     * incarnation before deletion, spare replacements and other bindings, and
     * retain an unknown outcome for readback. The host owns authorization.
     */
    delete(): Effect.Effect<void, ClientCustodyError>;
  }
>()('@lody/e2ee-core/ClientKeyCustody') {}

/**
 * One account/workspace/genesis single-writer capability. The host enters it
 * before allocating an installation and holds it through actual protection work.
 * It supplies exclusion, never approval. Busy fails conflict, without stealing a
 * live writer or guessing that a cancelled waiter stopped native operations.
 * @category Platform ports
 */
export class ClientCustodyWriter extends Context.Service<
  ClientCustodyWriter,
  {
    /** Captured routing scope shared by all incarnations. */
    readonly scope: ClientCustodyScope;
    /** Run finite local work with exclusive ownership; release after actual native calls settle and before any network wait. */
    run<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E | ClientCustodyError, R>;
  }
>()('@lody/e2ee-core/ClientCustodyWriter') {}

/** A local authenticated wrapper, never unprotected key material or a wire-format envelope. */
export interface ClientWrappedKey {
  readonly purpose: Exclude<ClientKeyPurpose, 'installed-epoch-key' | 'rotation-candidate'>;
  readonly blob: Uint8Array;
}

/**
 * First durable identity wrappers produced by the platform custody adapter,
 * including a partially completed installation. This read-only port grants no
 * approval and cannot create a key, replace a wrapper or select current identity.
 * A pending/unknown protection result fails indeterminate; never re-wrap it.
 * @category Platform ports
 */
export class ClientIdentityOriginals extends Context.Service<
  ClientIdentityOriginals,
  {
    /** Exact local incarnation whose original wrappers are retained. */
    readonly binding: ClientCustodyBinding;
    /** Owned first wrappers; the host requires all three and verifies actual key pairs/credential before ready. */
    read(): Effect.Effect<readonly ClientWrappedKey[], ClientCustodyError>;
  }
>()('@lody/e2ee-core/ClientIdentityOriginals') {}

/**
 * Recoverable local installation receipt, not approval evidence. prepared is
 * saved before KEK creation; protected retains the first complete wrappers;
 * ready follows readback, actual unwrap and key-pair verification. retired stops
 * reopening that incarnation and is retained by replace for reconciliation.
 * Revision is monotonic across replacements in the same routing slot, never
 * reset per incarnation. Missing/unknown halves never imply fresh install.
 */
export interface ClientInstallation {
  readonly binding: ClientCustodyBinding;
  readonly revision: number;
  readonly phase: 'prepared' | 'protected' | 'ready' | 'retired';
  readonly wrapped: readonly ClientWrappedKey[];
}

/**
 * Installation-only atomic storage; ledger pins and submission/key journals
 * keep their existing ports. Capture one routing scope, including on an empty store.
 * The slot is keyed by account/workspace/genesis, not installationId or device:
 * ordinary CAS cannot change a retained incarnation. Explicit replacement
 * archives the retired receipt and switches the current pointer atomically.
 * Returned bytes are owned copies and untrusted until authenticated. Quota or
 * abort leaves originals intact; commit-with-lost-response is reconciled by read.
 * Stores never interpret a receipt as authority or persist unwrapped secrets.
 */
export class ClientInstallationStore extends Context.Service<
  ClientInstallationStore,
  {
    /** Routing scope for reopen before the retained device/incarnation is known. */
    readonly scope: ClientCustodyScope;
    /** Read the retained original without generating, repairing or deleting anything. */
    read(): Effect.Effect<ClientInstallation | null, LocalStoreError>;
    /** Read an exact replaced incarnation in this scope; reject scope mismatch, never relabel it as current or regenerate it. */
    readRetired(
      binding: ClientCustodyBinding
    ): Effect.Effect<ClientInstallation | null, LocalStoreError>;
    /**
     * null requires absence and next.revision=0; otherwise require the exact
     * current revision and next.revision=expected+1. Validate binding, phase and
     * immutable original wrappers; write and read back in one short transaction.
     * The first row selects device/installationId once; later rows must match.
     * prepared starts empty and gains exactly one original for each identity
     * purpose on transition to protected. protected advances to ready; any
     * live phase may retire without replacing wrappers. Never clear a retired row
     * to manufacture absence. No crypto/network await inside the transaction.
     */
    compareAndSet(
      expected: number | null,
      next: ClientInstallation
    ): Effect.Effect<void, LocalStoreError>;
    /**
     * After the host verifies new desktop approval and drains the old identity,
     * compare the current retired receipt with the complete old binding/revision.
     * In ONE transaction retain that exact old receipt, including all wrappers,
     * and switch current to next. Use prepareReplacement's guards or equivalent;
     * next is protected, has fresh device/installationId and revision=expected+1.
     * Reject reuse of ANY archived device/installationId. The host's existing
     * pairing journal durably retains the wrapped candidate and exact request
     * before approval; this operation switches current, never creates approval.
     *
     * Keep old pending journals and pins intact under their original bindings;
     * never delete, re-sign, relabel or namespace-reset them. Verify both archive
     * and current writes before committing. An identical retry succeeds only
     * when the retained archive matches expected and current is exactly next;
     * otherwise conflict and reconcile via read/readRetired. Abort/quota leaves
     * both unchanged; lost replies never authorize another replacement.
     */
    replace(
      expected: { readonly binding: ClientCustodyBinding; readonly revision: number },
      next: ClientInstallation
    ): Effect.Effect<void, LocalStoreError>;
  }
>()('@lody/e2ee-core/ClientInstallationStore') {
  /**
   * Pure replacement precondition/ownership check for a store transaction.
   * Returns detached old/current write values, not desktop approval or a commit.
   * The adapter must read current under its transaction, check archive uniqueness,
   * then publish/read back BOTH values atomically; this helper does no I/O and
   * cannot establish durability. Ordinary compareAndSet never replaces identity.
   */
  static prepareReplacement(
    current: ClientInstallation | null,
    expected: { readonly binding: ClientCustodyBinding; readonly revision: number },
    next: ClientInstallation
  ): Result.Result<
    { readonly retired: ClientInstallation; readonly current: ClientInstallation },
    LocalStoreError
  > {
    const error = (reason: 'conflict' | 'corrupt') =>
      new LocalStoreError({ store: 'ClientInstallationStore', reason });
    const sameScope = (a: ClientCustodyBinding, b: ClientCustodyBinding) =>
      a.accountId === b.accountId && a.workspaceId === b.workspaceId && a.genesis.equals(b.genesis);
    const sameBinding = (a: ClientCustodyBinding, b: ClientCustodyBinding) =>
      sameScope(a, b) && a.device.equals(b.device) && a.installationId === b.installationId;
    const own = (row: ClientInstallation): ClientInstallation => {
      if (row.wrapped.length > 3) throw error('corrupt');
      return {
        ...row,
        binding: { ...row.binding },
        wrapped: row.wrapped.map(({ purpose, blob }) => ({ purpose, blob: new Uint8Array(blob) })),
      };
    };
    const complete = (row: ClientInstallation) =>
      row.wrapped.length === 3 &&
      CLIENT_KEY_PURPOSES.slice(0, 3).every(
        (purpose) => row.wrapped.filter((item) => item.purpose === purpose).length === 1
      );
    return Result.try({
      try: () => {
        if (!current) throw error('conflict');
        const old = own(current),
          replacement = own(next);
        for (const row of [old, replacement]) {
          if (
            !Number.isSafeInteger(row.revision) ||
            row.revision < 0 ||
            !/^[0-9a-f]{64}$/.test(row.binding.installationId)
          )
            throw error('corrupt');
        }
        // Old ciphertext may be why desktop reapproval is needed. Archive it
        // verbatim; only the incoming identity must have complete v1 wrappers.
        if (replacement.wrapped.some(({ blob }) => blob.length < 29 || blob[0] !== 1))
          throw error('corrupt');
        if (
          old.phase !== 'retired' ||
          old.revision !== expected.revision ||
          !sameBinding(old.binding, expected.binding) ||
          !sameScope(old.binding, replacement.binding) ||
          replacement.binding.device.equals(old.binding.device) ||
          replacement.binding.installationId === old.binding.installationId ||
          replacement.revision !== old.revision + 1 ||
          replacement.phase !== 'protected' ||
          !complete(replacement)
        )
          throw error('conflict');
        return { retired: old, current: replacement };
      },
      catch: (cause) => (cause instanceof LocalStoreError ? cause : error('corrupt')),
    });
  }
}
