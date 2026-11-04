import { Context, Effect, Layer } from 'effect';
import type { MailboxSlot } from '../internal/keys/reports';
import type { EpochStagedGroup, EpochStagedGroupKey } from '../internal/keys/staging';
import { KeyProtectorError, type BackendError } from './errors';

/**
 * Delivery state of one (workspace, epoch, recipient device) slot as the
 * mailbox backend sees it. A hint for scheduling work, never authority.
 *
 * @category Backend ports
 */
export type KeyMailboxStatus =
  | 'NeedsEnvelope'
  | 'EnvelopeStored'
  | 'InstallationReported'
  | 'Ineligible'
  | 'Obsolete';

/**
 * The backend mailbox that relays epoch-key envelopes to devices that joined
 * after a rotation, plus installation reports and repair requests.
 *
 * The adapter must bind every call to the authenticated local device: the
 * backend authenticates the caller and never lets request bodies choose the
 * sender or recipient. Everything returned is re-verified by the library
 * against the ledger, so a misbehaving backend can delay delivery but cannot
 * inject keys or grant access.
 *
 * Backend implementers: the rules a mailbox backend must enforce, and the wire
 * schemas for each call, are in `@lody/e2ee-core/host`.
 *
 * @category Backend ports
 */
export class KeyMailbox extends Context.Service<
  KeyMailbox,
  {
    /** Delivery state and current repair revision of one slot. */
    status(
      slot: MailboxSlot
    ): Effect.Effect<
      MailboxSlot & { readonly revision: number; readonly status: KeyMailboxStatus },
      BackendError
    >;
    /** Upload a signed installation report (and, for a local publication, its record). */
    report(report: Uint8Array, publication?: Uint8Array): Effect.Effect<void, BackendError>;
    /** Page through envelopes addressed to the authenticated device for `epoch`. */
    fetch(
      epoch: number,
      cursor: string | null,
      limit: number
    ): Effect.Effect<
      {
        readonly items: readonly { readonly sender: string; readonly frame: Uint8Array }[];
        readonly next: string | null;
      },
      BackendError
    >;
    /** Ask senders for a fresh envelope, optionally rejecting one received frame. */
    repair(
      slot: MailboxSlot,
      id: string,
      rejectedDigest?: string
    ): Effect.Effect<void, BackendError>;
    /** Store one envelope authored by the authenticated device under a stable id. */
    put(id: string, frame: Uint8Array): Effect.Effect<void, BackendError>;
    /** Read back an envelope this device stored under `id` for the current epoch. */
    read(id: string): Effect.Effect<Uint8Array | null, BackendError>;
  }
>()('@lody/e2ee-core/KeyMailbox') {}

/**
 * Backend storage for epoch-key envelope groups staged before an epoch is
 * published.
 *
 * A publisher stages every post-rotation envelope here and reads it back before
 * it appends the rotation record, so the new key is retrievable even if the
 * publisher disappears right after committing. Groups are inert until the ledger
 * contains their exact record; recipients verify that before opening anything.
 *
 * Contract for implementers (see `@lody/e2ee-core/host` for rules and schemas):
 * - a group is immutable at its key; a retry must match every byte or fail;
 * - only the record's signing device may stage or delete its group, and the
 *   ownership check and deletion happen atomically;
 * - the store never reads or interprets the ledger.
 *
 * @category Backend ports
 */
export class EpochStagingStore extends Context.Service<
  EpochStagingStore,
  {
    /** Store an immutable original group; identical retries succeed, different bytes at the same key conflict. */
    stageGroup(group: EpochStagedGroup): Effect.Effect<void, BackendError>;
    /** Return the original stored group or `null`; presence alone never proves ledger commitment. */
    readGroup(key: EpochStagedGroupKey): Effect.Effect<EpochStagedGroup | null, BackendError>;
    /** `occupied` is the client-verified different commitment now holding this epoch. */
    deleteGroup(
      key: EpochStagedGroupKey,
      occupied: { readonly epoch: number; readonly commitment: string }
    ): Effect.Effect<void, BackendError>;
  }
>()('@lody/e2ee-core/EpochStagingStore') {}

/**
 * Platform protection for installed epoch keys stored on this device.
 * Unpublished rotation candidates use the distinct {@link CandidateProtector}.
 *
 * `protect` must authenticate and encrypt the entire body; `unprotect` returns
 * the exact body or fails. The library binds purpose, workspace, device, epoch
 * and commitment inside the body and checks them after `unprotect`, so the
 * protector need not understand the format.
 *
 * Implementations must not complete (or be interruptible) before their native
 * work settles, because the library wipes buffers only after completion. A
 * protector can always read what it protects: it is a trust boundary of the host
 * platform, not an isolation guarantee. The Electron adapter wraps a
 * safeStorage-protected key; tests use a synthetic AES protector.
 *
 * @category Platform ports
 */
export class KeyProtector extends Context.Service<
  KeyProtector,
  {
    /** Authenticate and encrypt the complete body; borrow it only until native settlement and return an owned blob. */
    protect(body: Uint8Array): Effect.Effect<Uint8Array, KeyProtectorError>;
    /** Authenticate and open the blob, or fail; return an owned plaintext buffer that the caller will wipe. */
    unprotect(blob: Uint8Array): Effect.Effect<Uint8Array, KeyProtectorError>;
  }
>()('@lody/e2ee-core/KeyProtector') {
  /**
   * A protector from Promise-returning native calls (for example Electron
   * `safeStorage` behind IPC). Each call is uninterruptible, so the library
   * never wipes a buffer the native side may still be reading; a rejected call
   * becomes {@link KeyProtectorError} with the rejection as `cause` (never
   * shown to users).
   */
  static fromPromises(native: {
    readonly protect: (body: Uint8Array) => Promise<Uint8Array>;
    readonly unprotect: (blob: Uint8Array) => Promise<Uint8Array>;
  }): KeyProtector['Service'] {
    const protect = native.protect.bind(native),
      unprotect = native.unprotect.bind(native);
    const call = (work: () => Promise<Uint8Array>) =>
      Effect.uninterruptible(
        Effect.tryPromise({ try: work, catch: (cause) => new KeyProtectorError({ cause }) })
      );
    return KeyProtector.of({
      protect: (body) => call(() => protect(body)),
      unprotect: (blob) => call(() => unprotect(blob)),
    });
  }

  /** {@link KeyProtector.fromPromises} as a Layer. */
  static layerFromPromises(native: Parameters<typeof KeyProtector.fromPromises>[0]) {
    return Layer.succeed(KeyProtector, KeyProtector.fromPromises(native));
  }
}

/**
 * Platform protection for this device's *unpublished* rotation candidates (the
 * new epoch key before the ledger commits it), used only by `EpochPublisher`.
 *
 * Same contract as {@link KeyProtector}, but a distinct capability on purpose:
 * installed-key protection is approved only for keys the ledger already
 * committed, so an application must decide explicitly what protects a key that
 * is not yet published. Providing the same native backend for both is allowed,
 * but it must be a deliberate composition choice.
 *
 * @category Platform ports
 */
export class CandidateProtector extends Context.Service<
  CandidateProtector,
  KeyProtector['Service']
>()('@lody/e2ee-core/CandidateProtector') {
  /** See {@link KeyProtector.fromPromises}. */
  static layerFromPromises(native: Parameters<typeof KeyProtector.fromPromises>[0]) {
    return Layer.succeed(CandidateProtector, KeyProtector.fromPromises(native));
  }
}
