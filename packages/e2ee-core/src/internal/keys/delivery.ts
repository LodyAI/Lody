import { own } from '../lifecycle';
import { Effect, Result, Schema } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Bytes from '../foundation/bytes';
import { encodeCbor, bytesEqual } from '../foundation/cbor';
import { keyId } from '../foundation/identifiers';
import { requireLedgerContinuation, type LedgerView } from '../ledger';
import { type DeviceSigner } from '../foundation/signing';
import type { BackendError } from '../../services/errors';
import { KeyMailbox } from '../../services/keys';
import { DeliveryOutbox } from '../../services/stores';
import {
  authenticateEpochEnvelope,
  prepareEpochEnvelope,
  type EpochEnvelopeContext,
} from './envelope';

/**
 * A delivery could not start: the outbox holds an invalid frame (`corrupt`), or
 * there is no saved frame and no key to prepare one with (`missing`).
 *
 * @category Errors
 */
export class DeliveryError extends Schema.TaggedError<DeliveryError>()('DeliveryError', {
  reason: Schema.Literals(['corrupt', 'missing']),
}) {}
/** Result of one envelope delivery round: `Stored` (exact read-back matched) or `Pending` (retry the same original later). */
export type DeliveryOutcome = {
  readonly outcome: 'Stored' | 'Pending';
  readonly slot: string;
  readonly frame: Uint8Array;
};
/** Stable 16-byte delivery slot id (hex) for one (workspace, epoch, sender, recipient) envelope. */
export function epochDeliveryId(context: EpochEnvelopeContext) {
  return Result.gen(function* () {
    const anchor = yield* Bytes.genesisHash(context.genesis.toBytes());
    const number = yield* Bytes.epochNumber(context.epoch);
    const sender = yield* Bytes.signingPublicKey(context.sender.toBytes());
    const recipient = yield* Bytes.signingPublicKey(context.recipient.toBytes());
    const value = yield* encodeCbor([
      new TextEncoder().encode('lody-e2ee/local-epoch-delivery/v0'),
      anchor.toBytes(),
      number,
      sender.toBytes(),
      recipient.toBytes(),
    ]);
    return keyId(sha256(value).subarray(0, 16));
  });
}
/**
 * Deliver one envelope to the mailbox: reuse the outbox original or prepare and
 * save one, authenticate it against the current ledger, put it and read it
 * back. `Stored` means the read-back matched; `Pending` means retry later.
 * Finite: no scheduler, implicit retry, key publication or install receipt.
 */
export const deliverEpochEnvelope = Effect.fnUntraced(function* <E, R>(input: {
  readonly context: EpochEnvelopeContext;
  readonly ledger: () => Effect.Effect<LedgerView, E, R>;
  readonly prepare?: { readonly key: Bytes.EpochKey; readonly signer: DeviceSigner };
}) {
  const context = {
    genesis: yield* Effect.fromResult(Bytes.genesisHash(input.context.genesis.toBytes())),
    epoch: yield* Effect.fromResult(Bytes.epochNumber(input.context.epoch)),
    sender: yield* Effect.fromResult(Bytes.signingPublicKey(input.context.sender.toBytes())),
    recipient: yield* Effect.fromResult(Bytes.signingPublicKey(input.context.recipient.toBytes())),
  };
  const slot = yield* Effect.fromResult(epochDeliveryId(context));
  const outbox = own(yield* DeliveryOutbox),
    mailbox = own(yield* KeyMailbox);
  let seen: LedgerView | undefined;
  const currentLedger = () =>
    Effect.gen(function* () {
      const current = yield* input.ledger();
      yield* Effect.fromResult(requireLedgerContinuation(current, current));
      if (seen) yield* Effect.fromResult(requireLedgerContinuation(seen, current));
      seen = current;
      return current;
    });
  yield* currentLedger();
  const saved = yield* outbox.load(slot);
  let frame: Uint8Array;
  if (saved) {
    if (!(saved instanceof Uint8Array) || saved.length < 1 || saved.length > 512)
      return yield* new DeliveryError({ reason: 'corrupt' });
    frame = new Uint8Array(saved);
  } else {
    if (!input.prepare) return yield* new DeliveryError({ reason: 'missing' });
    const proposed = yield* prepareEpochEnvelope({
      context,
      key: input.prepare.key,
      signer: input.prepare.signer,
      ledger: currentLedger,
    });
    const original = yield* outbox.saveOriginal(slot, proposed);
    if (!(original instanceof Uint8Array) || original.length < 1 || original.length > 512)
      return yield* new DeliveryError({ reason: 'corrupt' });
    frame = new Uint8Array(original);
  }
  // Disk and injected transport/storage capabilities cannot establish author permission.
  const view = yield* currentLedger();
  yield* Effect.fromResult(authenticateEpochEnvelope(view, context, frame));
  // An unavailable backend leaves the delivery Pending; the caller retries the same
  // original. A refusal (unauthorized, conflict, invalid response) is a failure.
  const unavailable =
    <A>(fallback: A) =>
    (error: BackendError) =>
      error.reason === 'unavailable' ? Effect.succeed(fallback) : Effect.fail(error);
  yield* mailbox
    .put(slot, new Uint8Array(frame))
    .pipe(Effect.catchTag('BackendError', unavailable<void>(undefined)));
  const readback = yield* mailbox
    .read(slot)
    .pipe(Effect.catchTag('BackendError', unavailable<Uint8Array | null>(null)));
  const observed =
    readback instanceof Uint8Array &&
    readback.length === frame.length &&
    bytesEqual(readback, frame);
  return {
    outcome: observed ? 'Stored' : 'Pending',
    slot,
    frame: new Uint8Array(frame),
  } satisfies DeliveryOutcome;
});
