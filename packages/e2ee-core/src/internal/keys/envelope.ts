import { Effect, Exit, Result } from 'effect';
import * as Bytes from '../foundation/bytes';
import { bytesEqual, copyBytes } from '../foundation/cbor';
import { concat } from '../foundation/concat';
import { keyId } from '../foundation/identifiers';
import { ContentError } from '../foundation/errors';
import { disposeEpochKey } from '../foundation/epoch-key';
import { verifySignature } from '../foundation/signature';
import { signVerified, type DeviceSigner } from '../foundation/signing';
import {
  decodeRecord,
  epochHistoryPacket,
  extendLedger,
  hashRecordBytes,
  requireLedgerContinuation,
  type LedgerView,
} from '../ledger';
import {
  epochHpkeAad,
  sealEpochKeyHpke,
  openEpochKeyHpke,
  type EpochHpkeContext,
} from '../crypto/hpke';
import { commitEpochKey } from './history';

const fail = (code: string) => Result.fail(new ContentError({ code }));
const signingBytes = (bytes: Uint8Array) =>
  concat([new TextEncoder().encode('lody-e2ee/epoch-env/v1\0'), bytes]);
/** Independently expected routing, not values decoded from the incoming frame. */
export type EpochEnvelopeContext = EpochHpkeContext;
function ownContext(input: EpochEnvelopeContext) {
  return Result.try({
    try: () =>
      Result.getOrThrow(
        Result.gen(function* () {
          return Object.freeze({
            genesis: yield* Bytes.genesisHash(input.genesis.toBytes()),
            epoch: yield* Bytes.epochNumber(input.epoch),
            sender: yield* Bytes.signingPublicKey(input.sender.toBytes()),
            recipient: yield* Bytes.signingPublicKey(input.recipient.toBytes()),
          });
        })
      ),
    catch: () => new ContentError({ code: 'invalid-envelope-context' }),
  });
}
function eligibility(view: LedgerView, context: EpochEnvelopeContext) {
  return Result.gen(function* () {
    const fact = yield* Result.mapError(
      epochHistoryPacket(view, context.epoch),
      () => new ContentError({ code: 'unauthorized' })
    );
    const aad = yield* epochHpkeAad(context);
    if (!view.genesis.equals(context.genesis)) return yield* fail('content-context-mismatch');
    const state = view.inspectState();
    if (state.epoch.number !== context.epoch) return yield* fail('unauthorized');
    const sender = state.devices.get(keyId(context.sender.toBytes()));
    const recipient = state.devices.get(keyId(context.recipient.toBytes()));
    if (
      !sender ||
      sender.kind === 'recovery' ||
      !recipient ||
      !state.members.has(keyId(sender.membershipId.toBytes())) ||
      !state.members.has(keyId(recipient.membershipId.toBytes()))
    )
      return yield* fail('unauthorized');
    return { aad, recipientKey: recipient.encryptionPublicKey, commitment: fact.commitment };
  });
}
function recheck(before: LedgerView, after: LedgerView, context: EpochEnvelopeContext) {
  return Result.gen(function* () {
    yield* Result.mapError(
      requireLedgerContinuation(before, after),
      () => new ContentError({ code: 'unauthorized' })
    );
    const first = yield* eligibility(before, context),
      latest = yield* eligibility(after, context);
    if (
      !first.recipientKey.equals(latest.recipientKey) ||
      !first.commitment.equals(latest.commitment)
    )
      return yield* fail('content-context-mismatch');
    return latest;
  });
}
/** Fixed outer signature and expected routing only; grants no ledger permission,
 * committed publication, decryption or key-possession evidence. */
export function authenticateEpochEnvelopeSignature(
  inputContext: EpochEnvelopeContext,
  input: Uint8Array
) {
  return Result.gen(function* () {
    const context = yield* ownContext(inputContext);
    const aad = yield* epochHpkeAad(context);
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength !== aad.length + 144 ||
      !bytesEqual(input.subarray(0, aad.length), aad)
    )
      return yield* fail('invalid-envelope');
    const bytes = copyBytes(input);
    yield* Result.mapError(
      verifySignature(
        context.sender.toBytes(),
        signingBytes(bytes.subarray(0, -64)),
        bytes.subarray(-64)
      ),
      () => new ContentError({ code: 'bad-signature' })
    );
    return { enc: bytes.slice(aad.length, aad.length + 32), ct: bytes.slice(aad.length + 32, -64) };
  });
}
/** Signature/admission only: a host cannot verify the encrypted key preimage. */
export function authenticateEpochEnvelope(
  view: LedgerView,
  inputContext: EpochEnvelopeContext,
  input: Uint8Array
) {
  return Result.gen(function* () {
    const context = yield* ownContext(inputContext);
    yield* eligibility(view, context);
    return yield* authenticateEpochEnvelopeSignature(context, input);
  });
}
/** Creates one signed ciphertext only. Durable delivery/retry belongs to its owner. */
export const prepareEpochEnvelope = Effect.fnUntraced(function* <E, R>(input: {
  readonly context: EpochEnvelopeContext;
  readonly key: Bytes.EpochKey;
  readonly signer: DeviceSigner;
  readonly ledger: () => Effect.Effect<LedgerView, E, R>;
  /** Original signed publication; fixed replay derives its genuine candidate poststate. */
  readonly candidate?: { readonly before: LedgerView; readonly record: Uint8Array };
}) {
  const context = yield* Effect.fromResult(ownContext(input.context));
  if (
    input.candidate &&
    (!(input.candidate.record instanceof Uint8Array) ||
      input.candidate.record.length < 1 ||
      input.candidate.record.length > 8192)
  )
    return yield* Effect.fail(new ContentError({ code: 'invalid-envelope' }));
  const candidate = input.candidate && {
    before: input.candidate.before,
    record: new Uint8Array(input.candidate.record),
  };
  if (candidate) {
    const record = yield* Effect.fromResult(decodeRecord(candidate.record));
    if (
      record.body.type !== 'ordinary' ||
      (record.body.operation.type !== 'publishEpoch' &&
        record.body.operation.type !== 'removeMemberAndPublishEpoch') ||
      record.body.operation.epoch !== context.epoch ||
      !record.body.signer.equals(context.sender)
    )
      return yield* Effect.fail(new ContentError({ code: 'unauthorized' }));
  }
  const lookup = candidate
    ? () =>
        Effect.gen(function* () {
          const current = yield* input.ledger();
          yield* Effect.fromResult(requireLedgerContinuation(candidate.before, current));
          if (
            !current.head.equals(candidate.before.head) ||
            current.length !== candidate.before.length
          )
            return yield* Effect.fail(new ContentError({ code: 'content-context-mismatch' }));
          return yield* Effect.fromResult(
            extendLedger(candidate.before, [candidate.record], {
              head: hashRecordBytes(candidate.record),
              length: candidate.before.length + 1,
            })
          );
        })
    : input.ledger;
  const before = yield* lookup();
  const bound = yield* Effect.fromResult(eligibility(before, context));
  if (!input.signer.publicKey.equals(context.sender))
    return yield* Effect.fail(new ContentError({ code: 'unauthorized' }));
  const commitment = yield* Effect.fromResult(
    commitEpochKey(context.genesis, context.epoch, input.key)
  );
  if (!commitment.equals(bound.commitment))
    return yield* Effect.fail(new ContentError({ code: 'commitment-mismatch' }));
  const sealed = yield* sealEpochKeyHpke(bound.recipientKey, input.key, context);
  const unsigned = concat([bound.aad, sealed.enc, sealed.ct]);
  const signature = yield* signVerified(input.signer, signingBytes(unsigned));
  const after = yield* lookup();
  yield* Effect.fromResult(recheck(before, after, context));
  const frame = concat([unsigned, signature.toBytes()]);
  yield* Effect.fromResult(authenticateEpochEnvelope(after, context, frame));
  return frame;
});
/** Opens a current, authenticated exact commitment; it performs no durable install. */
export const openEpochEnvelope = Effect.fnUntraced(function* <E, R>(input: {
  readonly context: EpochEnvelopeContext;
  readonly pair: CryptoKeyPair;
  readonly frame: Uint8Array;
  readonly ledger: () => Effect.Effect<LedgerView, E, R>;
}) {
  const context = yield* Effect.fromResult(ownContext(input.context));
  if (!(input.frame instanceof Uint8Array) || input.frame.length > 512)
    return yield* Effect.fail(new ContentError({ code: 'invalid-envelope' }));
  const frame = copyBytes(input.frame);
  const pair = { publicKey: input.pair?.publicKey, privateKey: input.pair?.privateKey };
  const before = yield* input.ledger();
  const payload = yield* Effect.fromResult(authenticateEpochEnvelope(before, context, frame));
  const bound = yield* Effect.fromResult(eligibility(before, context));
  return yield* Effect.acquireUseRelease(
    openEpochKeyHpke(pair, bound.recipientKey, context, payload),
    (key) =>
      Effect.gen(function* () {
        const commitment = yield* Effect.fromResult(
          commitEpochKey(context.genesis, context.epoch, key)
        );
        if (!commitment.equals(bound.commitment))
          return yield* Effect.fail(new ContentError({ code: 'commitment-mismatch' }));
        const after = yield* input.ledger();
        yield* Effect.fromResult(recheck(before, after, context));
        return key;
      }),
    (key, exit) =>
      Effect.sync(() => {
        if (Exit.isFailure(exit)) disposeEpochKey(key);
      })
  );
});
