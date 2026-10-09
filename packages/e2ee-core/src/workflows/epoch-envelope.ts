import { Effect } from 'effect';
import { DeviceSigner, SignatureVerifier } from '../ports/ledger';
import { HpkeRecipient, HpkeSender } from '../ports/hpke';
import { EpochKeyring } from '../ports/epoch-rotation';
import {
  encryptionPublicKey,
  epochNumber,
  signature,
  type EpochKey,
  type SigningPublicKey,
} from '../pure/bytes';
import {
  checkEpochKey,
  decodeEnvelopeFrame,
  envelopeAad,
  envelopeSigningBytes,
  preparedEnvelope,
  recipientEncryptionKey,
  recheckEnvelopeContext,
} from '../pure/epoch-envelope';
import { concat } from '../pure/wire-crypto';
import { bytesEqual } from '../pure/cbor';
import { ContextMismatch, EpochRotationError } from '../pure/errors';
import { epochDeliveryId } from '../pure/key-delivery';
import { keyId } from '../pure/identifiers';
import { deliverFrame } from './key-delivery';
import type { LedgerClient } from './ledger-client';

/** One intent; the slot is stable across restart, while ciphertext is generated only once. */
export function sendEpochKey(
  client: LedgerClient,
  signer: DeviceSigner['Service'],
  recipient: SigningPublicKey,
  key: EpochKey
) {
  return Effect.gen(function* () {
    const view = yield* client.refresh();
    const state = view.inspectState();
    yield* Effect.fromResult(
      recipientEncryptionKey(state, signer.publicKey.toBytes(), recipient.toBytes())
    );
    yield* Effect.fromResult(checkEpochKey(state, key));
    const epoch = yield* Effect.fromResult(epochNumber(state.epoch.number));
    const id = yield* Effect.fromResult(
      epochDeliveryId(view.genesis, epoch, signer.publicKey, recipient)
    );
    const prepare = prepareEpochEnvelope(client, signer, recipient, key).pipe(
      Effect.flatMap((prepared) =>
        prepared.genesis.equals(view.genesis) && prepared.epoch === epoch
          ? Effect.succeed(prepared.toBytes())
          : Effect.fail(new ContextMismatch({ context: 'epoch' }))
      )
    );
    const outcome = yield* deliverFrame(
      keyId(id.toBytes()),
      undefined,
      (bytes) => authorizeEpochDelivery(client, signer.publicKey, recipient, bytes),
      prepare
    );
    return { ...outcome, deliveryId: id };
  });
}

/** Ordinary send: the caller names the recipient device, not its encryption key. */
export function sendCurrentEpochKey(
  client: LedgerClient,
  signer: DeviceSigner['Service'],
  recipient: SigningPublicKey
) {
  return Effect.gen(function* () {
    const keyring = yield* EpochKeyring;
    const view = yield* client.refresh();
    const epoch = yield* Effect.fromResult(epochNumber(view.inspectState().epoch.number));
    const key = yield* keyring.get(view.genesis, epoch);
    if (key === null) return yield* Effect.fail(new EpochRotationError({ reason: 'key-missing' }));
    return yield* sendEpochKey(client, signer, recipient, key);
  });
}

/** Verified open plus durable install. Returning is not a secret export. */
export function installEpochEnvelope(
  client: LedgerClient,
  recipient: SigningPublicKey,
  sender: SigningPublicKey,
  frame: Uint8Array
) {
  const owned = new Uint8Array(frame);
  return Effect.gen(function* () {
    const keyring = yield* EpochKeyring;
    const opened = yield* openVerifiedEnvelope(client, recipient, sender, owned);
    // Install into the slot whose commitment was checked. A later refresh may already
    // be at the next epoch; that slot belongs to a different key.
    yield* keyring.put(opened.genesis, opened.epoch, opened.key);
    return { _tag: 'Installed' as const, epoch: opened.epoch as number };
  });
}

/** Internal client workflow; sender identity is already bound by LedgerClient. */
export function prepareEpochEnvelope(
  client: LedgerClient,
  signer: DeviceSigner['Service'],
  recipient: SigningPublicKey,
  key: EpochKey
) {
  return Effect.gen(function* () {
    const sealer = yield* HpkeSender;
    const verifier = yield* SignatureVerifier;
    const view = yield* client.refresh();
    const state = view.inspectState();
    const senderBytes = signer.publicKey.toBytes(),
      recipientBytes = recipient.toBytes();
    const recipientKey = yield* Effect.fromResult(
      encryptionPublicKey(
        yield* Effect.fromResult(recipientEncryptionKey(state, senderBytes, recipientBytes))
      )
    );
    yield* Effect.fromResult(checkEpochKey(state, key));
    const epoch = yield* Effect.fromResult(epochNumber(state.epoch.number));
    const aad = yield* Effect.fromResult(
      envelopeAad({
        genesis: view.genesis.toBytes(),
        epoch,
        sender: senderBytes,
        recipient: recipientBytes,
      })
    );
    const sealed = yield* sealer.seal({ recipient: recipientKey, key, aad });
    const unsigned = concat([aad, sealed.enc, sealed.ct]);
    const message = envelopeSigningBytes(unsigned);
    const signed = yield* signer.sign(message);
    yield* verifier.verify({ publicKey: signer.publicKey, message, signature: signed });
    const latest = yield* client.refresh();
    yield* Effect.fromResult(
      recheckEnvelopeContext(state, latest.inspectState(), senderBytes, recipientBytes)
    );
    return preparedEnvelope(
      view.genesis,
      epoch,
      signer.publicKey,
      recipient,
      concat([unsigned, signed.toBytes()])
    );
  });
}

/** Returns an authenticated secret, not proof that it has been durably installed. */
export function openEpochEnvelope(
  client: LedgerClient,
  recipient: SigningPublicKey,
  sender: SigningPublicKey,
  input: Uint8Array
) {
  return openVerifiedEnvelope(client, recipient, sender, input).pipe(
    Effect.map((opened) => opened.key)
  );
}

/** The key together with the exact genesis/epoch whose commitment it matched. */
function openVerifiedEnvelope(
  client: LedgerClient,
  recipient: SigningPublicKey,
  sender: SigningPublicKey,
  input: Uint8Array
) {
  const frame = new Uint8Array(input);
  return Effect.gen(function* () {
    const opener = yield* HpkeRecipient;
    const verifier = yield* SignatureVerifier;
    const view = yield* client.refresh();
    const state = view.inspectState();
    const senderBytes = sender.toBytes(),
      recipientBytes = recipient.toBytes();
    const expected = yield* Effect.fromResult(
      recipientEncryptionKey(state, senderBytes, recipientBytes)
    );
    if (!bytesEqual(expected, opener.publicKey.toBytes()))
      return yield* Effect.fail(new ContextMismatch({ context: 'recipient' }));
    const parts = yield* Effect.fromResult(
      decodeEnvelopeFrame(
        {
          genesis: view.genesis.toBytes(),
          epoch: state.epoch.number,
          sender: senderBytes,
          recipient: recipientBytes,
        },
        frame
      )
    );
    yield* verifier.verify({
      publicKey: sender,
      message: parts.signingBytes,
      signature: yield* Effect.fromResult(signature(parts.signature)),
    });
    const key = yield* opener.open(parts);
    yield* Effect.fromResult(checkEpochKey(state, key));
    const latest = yield* client.refresh();
    yield* Effect.fromResult(
      recheckEnvelopeContext(state, latest.inspectState(), senderBytes, recipientBytes)
    );
    return {
      key,
      genesis: view.genesis,
      epoch: yield* Effect.fromResult(epochNumber(state.epoch.number)),
    };
  });
}

/** Re-authorizes saved ciphertext without decrypting or regenerating it. */
export function authorizeEpochDelivery(
  client: LedgerClient,
  sender: SigningPublicKey,
  recipient: SigningPublicKey,
  input: Uint8Array
) {
  const frame = new Uint8Array(input);
  return Effect.gen(function* () {
    const verifier = yield* SignatureVerifier;
    const view = yield* client.refresh();
    const state = view.inspectState();
    const senderBytes = sender.toBytes(),
      recipientBytes = recipient.toBytes();
    yield* Effect.fromResult(recipientEncryptionKey(state, senderBytes, recipientBytes));
    const parts = yield* Effect.fromResult(
      decodeEnvelopeFrame(
        {
          genesis: view.genesis.toBytes(),
          epoch: state.epoch.number,
          sender: senderBytes,
          recipient: recipientBytes,
        },
        frame
      )
    );
    yield* verifier.verify({
      publicKey: sender,
      message: parts.signingBytes,
      signature: yield* Effect.fromResult(signature(parts.signature)),
    });
    const latest = yield* client.refresh();
    yield* Effect.fromResult(
      recheckEnvelopeContext(state, latest.inspectState(), senderBytes, recipientBytes)
    );
  });
}
