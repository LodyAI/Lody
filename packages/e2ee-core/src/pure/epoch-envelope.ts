import { Either } from 'effect';
import { bytesEqual, copyBytes, encodeCbor } from './cbor';
import { ContextMismatch, ValidationError } from './errors';
import type * as Bytes from './bytes';
import { copyEpochKeyBytes } from './epoch-key';
import { keyId } from './identifiers';
import type { OrgState } from './ledger-state';
import { commitEpochKey, concat, type Hash, type SigningPublicKey } from './wire-crypto';

class PreparedEnvelopeValue {
  readonly #frame: Uint8Array;
  readonly stage = 'Prepared' as const;
  constructor(
    readonly genesis: Bytes.GenesisHash,
    readonly epoch: Bytes.EpochNumber,
    readonly sender: Bytes.SigningPublicKey,
    readonly recipient: Bytes.SigningPublicKey,
    frame: Uint8Array
  ) {
    this.#frame = copyBytes(frame);
    Object.freeze(this);
  }
  toBytes(): Uint8Array {
    return copyBytes(this.#frame);
  }
}
/** Preparation proves neither future authorization nor durable delivery. */
export type PreparedEpochEnvelope = PreparedEnvelopeValue;
/** Package internal, not an exported public constructor. */
export const preparedEnvelope = (
  genesis: Bytes.GenesisHash,
  epoch: Bytes.EpochNumber,
  sender: Bytes.SigningPublicKey,
  recipient: Bytes.SigningPublicKey,
  frame: Uint8Array
) => new PreparedEnvelopeValue(genesis, epoch, sender, recipient, frame);

export function checkEpochKey(state: OrgState, key: Bytes.EpochKey) {
  const bytes = copyEpochKeyBytes(key);
  try {
    return Either.flatMap(commitEpochKey(state.genesis, state.epoch.number, bytes), (commitment) =>
      bytesEqual(commitment, state.epoch.keyCommitment)
        ? Either.void
        : Either.left(new ContextMismatch({ context: 'epoch' }))
    );
  } finally {
    bytes.fill(0);
  }
}

/** Recheck the exact data relevant to delivery after asynchronous crypto work.
 * Unrelated ledger advances are allowed, but rights/key/epoch changes are not. */
export function recheckEnvelopeContext(
  before: OrgState,
  after: OrgState,
  sender: SigningPublicKey,
  recipient: SigningPublicKey
) {
  return Either.gen(function* () {
    const previous = yield* recipientEncryptionKey(before, sender, recipient);
    const current = yield* recipientEncryptionKey(after, sender, recipient);
    if (!bytesEqual(before.genesis, after.genesis))
      return yield* Either.left(new ContextMismatch({ context: 'genesis' }));
    if (
      before.epoch.number !== after.epoch.number ||
      !bytesEqual(before.epoch.keyCommitment, after.epoch.keyCommitment)
    )
      return yield* Either.left(new ContextMismatch({ context: 'epoch' }));
    if (!bytesEqual(previous, current))
      return yield* Either.left(new ContextMismatch({ context: 'recipient' }));
    return undefined;
  });
}

export interface EnvelopeContext {
  readonly genesis: Hash;
  readonly epoch: number;
  readonly sender: SigningPublicKey;
  readonly recipient: SigningPublicKey;
}

/** Key forwarding is separate from management, content writing and endorsement. */
export function canSendEpoch(state: OrgState, sender: SigningPublicKey): boolean {
  const device = state.devices.get(keyId(sender));
  return device !== undefined && device.kind !== 'recovery';
}

/** A pure lookup, not evidence that this state is authenticated or fresh. */
export function recipientEncryptionKey(
  state: OrgState,
  sender: SigningPublicKey,
  recipient: SigningPublicKey
): Either.Either<Uint8Array, ValidationError> {
  const device = state.devices.get(keyId(recipient));
  return canSendEpoch(state, sender) && device !== undefined
    ? Either.right(copyBytes(device.encryptionPublicKey))
    : Either.left(new ValidationError({ code: 'unauthorized' }));
}

export function envelopeAad(input: EnvelopeContext): Either.Either<Uint8Array, ValidationError> {
  return encodeCbor([input.genesis, input.epoch, input.sender, input.recipient]);
}

export function envelopeSigningBytes(unsigned: Uint8Array): Uint8Array {
  return concat([new TextEncoder().encode('lody-e2ee/epoch-env/v1\0'), unsigned]);
}

/** Framing only. Neither parsing nor an admitted sender authenticates a key. */
export function decodeEnvelopeFrame(input: EnvelopeContext, frame: Uint8Array) {
  return Either.gen(function* () {
    const aad = yield* envelopeAad(input);
    if (
      frame.byteLength !== aad.byteLength + 32 + 48 + 64 ||
      !bytesEqual(frame.subarray(0, aad.byteLength), aad)
    ) {
      return yield* Either.left(new ValidationError({ code: 'canonical' }));
    }
    return {
      aad,
      enc: copyBytes(frame.subarray(aad.byteLength, aad.byteLength + 32)),
      ct: copyBytes(frame.subarray(aad.byteLength + 32, aad.byteLength + 80)),
      signature: copyBytes(frame.subarray(aad.byteLength + 80)),
      signingBytes: envelopeSigningBytes(frame.subarray(0, -64)),
    };
  });
}
