import { Effect } from 'effect';
import { signingPublicKey } from '../foundation/bytes';
import { signVerified, type DeviceSigner } from '../foundation/signing';
import { requireLedgerContinuation, type LedgerView } from './replay';
import { prepareLedgerSnapshot, snapshotTrustFromView, verifyLedgerSnapshot } from './replay';
import { encodeSignedSnapshot } from './snapshot-codec';

/** Producer metadata is not a receiver's external trust confirmation. */
export const signLedgerSnapshot = Effect.fnUntraced(function* <E, R>(input: {
  readonly signer: DeviceSigner;
  readonly ledger: () => Effect.Effect<LedgerView, E, R>;
}) {
  const key = yield* Effect.fromResult(signingPublicKey(input.signer.publicKey.toBytes()));
  const before = yield* input.ledger();
  const proposal = yield* Effect.fromResult(prepareLedgerSnapshot(before, key));
  const signed = yield* signVerified(input.signer, proposal.signingBytes);
  const headSignature = yield* signVerified(input.signer, proposal.headAttestationSigningBytes);
  const snapshot = yield* Effect.fromResult(encodeSignedSnapshot(proposal.bodyBytes, signed));
  const pin = yield* Effect.fromResult(snapshotTrustFromView(before, key, headSignature));
  yield* Effect.fromResult(verifyLedgerSnapshot({ snapshot, trust: pin }));
  const after = yield* input.ledger();
  yield* Effect.fromResult(requireLedgerContinuation(before, after));
  // Role/kind eligibility is rechecked at this later real view, not from encoded claims.
  yield* Effect.fromResult(prepareLedgerSnapshot(after, key));
  return Object.freeze({
    snapshot,
    headSignature,
    genesis: before.genesis,
    head: before.head,
    length: before.length,
    endorser: key,
  });
});
