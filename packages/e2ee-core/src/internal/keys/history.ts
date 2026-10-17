import { Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import * as Bytes from '../foundation/bytes';
import { copyEpochKeyBytes } from '../foundation/epoch-key';
import { bytesEqual } from '../foundation/cbor';
import { concat } from '../foundation/concat';
import { epochHistoryPacket, type LedgerView } from '../ledger';
import { Data } from 'effect';

/** An epoch-key commitment, history packet or recovery check failed. */
export class EpochKeyError extends Data.TaggedError('EpochKeyError')<{
  readonly code:
    | 'invalid-input'
    | 'random-unavailable'
    | 'history-invalid'
    | 'commitment-mismatch'
    | 'unauthorized'
    | 'closed'
    | 'missing-key';
}> {}
const fail = (code: EpochKeyError['code']) => Result.fail(new EpochKeyError({ code }));
const domain = (name: string) => new TextEncoder().encode(`lody-e2ee/${name}/v1\0`);
function context(genesis: Bytes.GenesisHash, epoch: number) {
  return Result.gen(function* () {
    const anchor = yield* Result.mapError(
      Bytes.genesisHash(genesis.toBytes()),
      () => new EpochKeyError({ code: 'invalid-input' })
    );
    const number = yield* Result.mapError(
      Bytes.epochNumber(epoch),
      () => new EpochKeyError({ code: 'invalid-input' })
    );
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, number);
    return { genesis: anchor.toBytes(), epoch: number, bytes };
  });
}
function material(key: Bytes.EpochKey) {
  return Result.try({
    try: () => {
      const bytes = copyEpochKeyBytes(key);
      if (bytes.length !== 32) {
        bytes.fill(0);
        throw new Error('shape');
      }
      return bytes;
    },
    catch: () => new EpochKeyError({ code: 'invalid-input' }),
  });
}
/** Preserved ledger commitment: epoch zero deliberately excludes genesis/number. */
export function commitEpochKey(
  genesis: Bytes.GenesisHash,
  epoch: number,
  key: Bytes.EpochKey
): Result.Result<Bytes.EpochCommitment, EpochKeyError> {
  const checked = context(genesis, epoch);
  if (Result.isFailure(checked)) return Result.fail(checked.failure);
  const secret = material(key);
  if (Result.isFailure(secret)) return Result.fail(secret.failure);
  try {
    return commitMaterial(checked.success, secret.success);
  } finally {
    secret.success.fill(0);
  }
}
function commitMaterial(
  checked: { genesis: Uint8Array; epoch: number; bytes: Uint8Array },
  key: Uint8Array
): Result.Result<Bytes.EpochCommitment, EpochKeyError> {
  const tagged =
    checked.epoch === 0
      ? concat([domain('epoch-key'), key])
      : concat([domain('epoch-key'), checked.genesis, checked.bytes, key]);
  try {
    return Result.mapError(
      Bytes.epochCommitment(sha256(tagged)),
      () => new EpochKeyError({ code: 'invalid-input' })
    );
  } finally {
    tagged.fill(0);
  }
}
/** Seal the previous epoch key under the new one (XChaCha20-Poly1305 with a fresh nonce) as the 72-byte history packet of a rotation record. */
export function sealHistoryPacket(input: {
  readonly genesis: Bytes.GenesisHash;
  readonly epoch: number;
  readonly currentKey: Bytes.EpochKey;
  readonly previousKey: Bytes.EpochKey;
}): Result.Result<Uint8Array, EpochKeyError> {
  const checked = context(input.genesis, input.epoch);
  if (Result.isFailure(checked)) return Result.fail(checked.failure);
  if (checked.success.epoch === 0) return fail('invalid-input');
  const current = material(input.currentKey);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  let previous: Uint8Array | undefined;
  try {
    const prior = material(input.previousKey);
    if (Result.isFailure(prior)) return Result.fail(prior.failure);
    previous = prior.success;
    const nonce = Result.try({
      try: () => globalThis.crypto.getRandomValues(new Uint8Array(24)),
      catch: () => new EpochKeyError({ code: 'random-unavailable' }),
    });
    if (Result.isFailure(nonce)) return Result.fail(nonce.failure);
    const aad = concat([domain('epoch-history'), checked.success.genesis, checked.success.bytes]);
    return Result.try({
      try: () =>
        concat([
          nonce.success,
          xchacha20poly1305(current.success, nonce.success, aad).encrypt(previous!),
        ]),
      catch: () => new EpochKeyError({ code: 'history-invalid' }),
    });
  } finally {
    current.success.fill(0);
    previous?.fill(0);
  }
}
function openMaterial(input: {
  genesis: Bytes.GenesisHash;
  epoch: number;
  currentKey: Uint8Array;
  packet: Uint8Array;
}): Result.Result<Uint8Array, EpochKeyError> {
  const checked = context(input.genesis, input.epoch);
  if (Result.isFailure(checked)) return Result.fail(checked.failure);
  if (
    checked.success.epoch === 0 ||
    !(input.packet instanceof Uint8Array) ||
    input.packet.length !== 72
  )
    return fail('invalid-input');
  const packet = new Uint8Array(input.packet);
  return Result.try({
    try: () =>
      xchacha20poly1305(
        input.currentKey,
        packet.subarray(0, 24),
        concat([domain('epoch-history'), checked.success.genesis, checked.success.bytes])
      ).decrypt(packet.subarray(24)),
    catch: () => new EpochKeyError({ code: 'history-invalid' }),
  });
}
/** AEAD only; caller still authenticates signed publication and old commitment. */
export function openHistoryPacket(input: {
  readonly genesis: Bytes.GenesisHash;
  readonly epoch: number;
  readonly currentKey: Bytes.EpochKey;
  readonly packet: Uint8Array;
}): Result.Result<Bytes.EpochKey, EpochKeyError> {
  const current = material(input.currentKey);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  let previous: Uint8Array | undefined;
  try {
    const opened = openMaterial({ ...input, currentKey: current.success });
    if (Result.isFailure(opened)) return Result.fail(opened.failure);
    previous = opened.success;
    return Result.mapError(
      Bytes.epochKey(previous),
      () => new EpochKeyError({ code: 'history-invalid' })
    );
  } finally {
    current.success.fill(0);
    previous?.fill(0);
  }
}
/** All links/commitments from a real full verified view, or no returned keys. */
export function recoverLedgerHistory(
  view: LedgerView,
  latestKey: Bytes.EpochKey
): Result.Result<ReadonlyMap<number, Bytes.EpochKey>, EpochKeyError> {
  const scratch = new Map<number, Uint8Array>();
  try {
    // Authenticate the view before inspecting any property.
    const zero = epochHistoryPacket(view, 0);
    if (Result.isFailure(zero)) return fail('unauthorized');
    const latestEpoch = view.inspectState().epoch.number;
    const copied = material(latestKey);
    if (Result.isFailure(copied)) return Result.fail(copied.failure);
    scratch.set(latestEpoch, copied.success);
    for (let epoch = latestEpoch; epoch >= 0; epoch--) {
      const row = epochHistoryPacket(view, epoch);
      if (Result.isFailure(row)) return fail('history-invalid');
      const key = scratch.get(epoch)!;
      const checked = context(view.genesis, epoch);
      if (Result.isFailure(checked)) return Result.fail(checked.failure);
      const digest = commitMaterial(checked.success, key);
      if (
        Result.isFailure(digest) ||
        !bytesEqual(digest.success.toBytes(), row.success.commitment.toBytes())
      )
        return fail('commitment-mismatch');
      if (epoch > 0) {
        const prior = openMaterial({
          genesis: view.genesis,
          epoch,
          currentKey: key,
          packet: row.success.packet,
        });
        if (Result.isFailure(prior)) return Result.fail(prior.failure);
        scratch.set(epoch - 1, prior.success);
      }
    }
    const result = new Map<number, Bytes.EpochKey>();
    for (const [epoch, key] of scratch) result.set(epoch, Result.getOrThrow(Bytes.epochKey(key)));
    return Result.succeed(result);
  } finally {
    for (const key of scratch.values()) key.fill(0);
  }
}
