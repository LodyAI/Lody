import { Effect } from 'effect';
import {
  EpochCandidateStore,
  EpochKeyring,
  type EpochCandidateTransaction,
} from '../ports/epoch-rotation';
import { CryptoEntropy } from '../ports/entropy';
import type { DeviceSigner } from '../ports/ledger';
import { epochKey, epochNumber, type SigningPublicKey } from '../pure/bytes';
import { bytesEqual } from '../pure/cbor';
import { decodeEpochCandidate, encodeEpochCandidate } from '../pure/epoch-candidate';
import { checkEpochKey } from '../pure/epoch-envelope';
import { copyEpochKeyBytes } from '../pure/epoch-key';
import { sealHistoryPacket } from '../pure/epoch-history';
import { commitEpochKey } from '../pure/wire-crypto';
import { EpochRotationError, type ClientError } from '../pure/errors';
import { decodeRecord } from '../pure/ledger-schema';
import type { LedgerView } from '../pure/records';
import type { LedgerEngine } from './ledger-engine';

export type EpochRotationOutcome =
  | { readonly _tag: 'Idle'; readonly ledger: LedgerView }
  | {
      readonly _tag: 'Committed';
      readonly ledger: LedgerView;
      readonly epoch: number;
      readonly binding: 'current' | 'historical';
    }
  | {
      readonly _tag: 'Pending' | 'Conflict' | 'Unsupported';
      readonly ledger: LedgerView;
      readonly epoch: number;
    };

/** No entropy or signing: retries the exact durable candidate, including after lost ACKs. */
export function resumeEpochRotation(
  engine: LedgerEngine,
  signer: SigningPublicKey
): Effect.Effect<
  EpochRotationOutcome,
  ClientError | EpochRotationError,
  EpochCandidateStore | EpochKeyring
> {
  return Effect.gen(function* () {
    const store = yield* EpochCandidateStore;
    const keyring = yield* EpochKeyring;
    const initial = yield* engine.refresh();
    return yield* store.exclusive(initial.genesis, (tx) =>
      Effect.gen(function* () {
        const text = yield* tx.load;
        if (text === null) {
          if (yield* engine.hasPendingEpochPublication())
            return yield* Effect.fail(new EpochRotationError({ reason: 'candidate-missing' }));
          return { _tag: 'Idle', ledger: initial } as const;
        }
        return yield* settleCandidate(engine, signer, tx, keyring, initial, text);
      })
    );
  }).pipe(Effect.withSpan('e2ee.epoch-rotation.resume'));
}

function settleCandidate(
  engine: LedgerEngine,
  signer: SigningPublicKey,
  tx: EpochCandidateTransaction,
  keyring: EpochKeyring['Type'],
  initial: LedgerView,
  text: string
): Effect.Effect<EpochRotationOutcome, ClientError | EpochRotationError> {
  return Effect.gen(function* () {
    const candidate = yield* decodeEpochCandidate(text).pipe(
      Effect.mapError(() => new EpochRotationError({ reason: 'candidate-corrupt' }))
    );
    const record = yield* decodeRecord(candidate.record);
    if (!bytesEqual(record.body.fields.signer, signer.toBytes()))
      return yield* Effect.fail(new EpochRotationError({ reason: 'candidate-mismatch' }));
    if (initial.inspectEpochCandidate(candidate) === 'mismatch')
      return yield* Effect.fail(new EpochRotationError({ reason: 'candidate-mismatch' }));
    // Reconciles the journal too, even if refresh already observed this exact record.
    const result = yield* engine.submitEncoded(candidate.record);
    if (result._tag === 'Conflict') {
      yield* tx.clear;
      return { ...result, epoch: candidate.epoch };
    }
    if (result._tag !== 'Committed') return { ...result, epoch: candidate.epoch };
    const binding = result.ledger.inspectEpochCandidate(candidate);
    if (binding !== 'current' && binding !== 'historical')
      return yield* Effect.fail(new EpochRotationError({ reason: 'candidate-mismatch' }));
    yield* keyring.put(
      result.ledger.genesis,
      yield* epochNumber(candidate.epoch),
      yield* epochKey(candidate.secret)
    );
    yield* tx.clear;
    return { ...result, epoch: candidate.epoch, binding };
  });
}

/** Existing candidates always win: an explicit retry never regenerates secret or signature. */
export function rotateEpoch(
  engine: LedgerEngine,
  signer: DeviceSigner['Type']
): Effect.Effect<
  EpochRotationOutcome,
  ClientError | EpochRotationError,
  EpochCandidateStore | EpochKeyring | CryptoEntropy
> {
  return Effect.gen(function* () {
    const store = yield* EpochCandidateStore;
    const keyring = yield* EpochKeyring;
    const initial = yield* engine.refresh();
    return yield* store.exclusive(initial.genesis, (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx.load;
        if (existing !== null)
          return yield* settleCandidate(engine, signer.publicKey, tx, keyring, initial, existing);
        if (yield* engine.hasPendingEpochPublication())
          return yield* Effect.fail(new EpochRotationError({ reason: 'candidate-missing' }));
        const current = yield* engine.refresh();
        const state = current.inspectState();
        const previous = yield* keyring.get(
          current.genesis,
          yield* epochNumber(state.epoch.number)
        );
        if (previous === null)
          return yield* Effect.fail(new EpochRotationError({ reason: 'key-missing' }));
        yield* checkEpochKey(state, previous);
        const epoch = yield* epochNumber(state.epoch.number + 1);
        const entropy = yield* CryptoEntropy;
        const secret = new Uint8Array(yield* entropy.bytes('publish-epoch-secret', 32));
        const previousBytes = copyEpochKeyBytes(previous);
        return yield* Effect.gen(function* () {
          const nonce = yield* entropy.bytes('history-packet-nonce', 24);
          const commitment = yield* commitEpochKey(state.genesis, epoch, secret);
          const packet = yield* sealHistoryPacket({
            currentKey: secret,
            previousKey: previousBytes,
            genesis: state.genesis,
            epoch,
            nonce,
          });
          const record = yield* engine.prepareEpochPublication(
            { type: 'publishEpoch', epoch, commitment, previousEpochKey: packet },
            signer
          );
          const text = yield* encodeEpochCandidate({
            genesis: state.genesis,
            epoch,
            commitment,
            secret,
            record,
          });
          yield* Effect.uninterruptible(tx.save(text));
          return yield* settleCandidate(engine, signer.publicKey, tx, keyring, current, text);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              secret.fill(0);
              previousBytes.fill(0);
            })
          )
        );
      })
    );
  }).pipe(Effect.withSpan('e2ee.epoch-rotation.rotate'));
}
