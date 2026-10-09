import { Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeCbor } from './cbor';
import {
  deliveryId,
  epochNumber,
  type GenesisHash,
  type EpochNumber,
  type SigningPublicKey,
} from './bytes';
import { bytesEqual } from './cbor';
import { ValidationError } from './errors';

export function checkDeliveryId(id: string): Result.Result<string, ValidationError> {
  return /^[0-9a-f]{32}$/.test(id)
    ? Result.succeed(id)
    : Result.fail(new ValidationError({ code: 'canonical' }));
}

/** Persistence wins; a retry may not replace the original sealed bytes. */
export function selectDeliveryFrame(
  saved: Uint8Array | null,
  proposed: Uint8Array | undefined
): Result.Result<Uint8Array, ValidationError> {
  if (saved && proposed && !bytesEqual(saved, proposed))
    return Result.fail(new ValidationError({ code: 'replay' }));
  const frame = saved ?? proposed;
  return frame === undefined
    ? Result.fail(new ValidationError({ code: 'invalid-operation' }))
    : Result.succeed(new Uint8Array(frame));
}

export type DeliveryOutcome =
  | { readonly _tag: 'Observed'; readonly frame: Uint8Array }
  | { readonly _tag: 'Pending'; readonly frame: Uint8Array };

/** Local idempotency slot, NOT an authorization token or a new signed wire field. */
export function epochDeliveryId(
  genesis: GenesisHash,
  epoch: EpochNumber,
  sender: SigningPublicKey,
  recipient: SigningPublicKey
) {
  return unverifiedEpochDeliveryId(genesis.toBytes(), epoch, sender.toBytes(), recipient.toBytes());
}

/** Routing hash only. Does not assert curve validity, signature validity or authority. */
export function unverifiedEpochDeliveryId(
  genesis: Uint8Array,
  epoch: number,
  sender: Uint8Array,
  recipient: Uint8Array
) {
  return Result.gen(function* () {
    yield* epochNumber(epoch);
    if (genesis.length !== 32 || sender.length !== 32 || recipient.length !== 32)
      return yield* Result.fail(new ValidationError({ code: 'canonical' }));
    const bytes = yield* encodeCbor([
      new TextEncoder().encode('lody-e2ee/local-epoch-delivery/v0'),
      genesis,
      epoch,
      sender,
      recipient,
    ]);
    return yield* deliveryId(sha256(bytes).subarray(0, 16));
  });
}

export function observeDelivery(
  expected: Uint8Array,
  observed: Uint8Array | null
): DeliveryOutcome {
  const frame = new Uint8Array(expected);
  return observed && bytesEqual(expected, observed)
    ? { _tag: 'Observed', frame }
    : { _tag: 'Pending', frame };
}
