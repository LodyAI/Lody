import { Either } from 'effect';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesEqual, copyBytes } from './cbor';
import { ValidationError } from './errors';
import {
  checkEpoch,
  checkHash,
  commitEpochKey,
  concat,
  HISTORY_PACKET_BYTES,
  type Hash,
} from './wire-crypto';
import { decodeRecord } from './ledger-schema';

const invalid = () => Either.left(new ValidationError({ code: 'invalid-operation' }));

/** Structural collection only; callers must obtain records from a verified ledger. */
export function collectEpochPackets(records: readonly Uint8Array[], genesisCommitment: Hash) {
  return Either.gen(function* () {
    const packets = new Map<number, { commitment: Hash; packet: Uint8Array }>();
    packets.set(0, { commitment: yield* checkHash(genesisCommitment), packet: new Uint8Array() });
    for (const bytes of records) {
      const record = yield* decodeRecord(bytes);
      if (record.body.type !== 'ordinary') continue;
      const operation = record.body.fields.operation;
      if (operation.type === 'publishEpoch')
        packets.set(operation.epoch, {
          commitment: operation.commitment,
          packet: operation.previousEpochKey,
        });
    }
    return packets;
  });
}
function aad(genesis: Hash, epoch: number): Uint8Array {
  const number = new Uint8Array(4);
  new DataView(number.buffer).setUint32(0, epoch);
  return concat([new TextEncoder().encode('lody-e2ee/epoch-history/v1\0'), genesis, number]);
}

/** Nonce generation belongs to the caller's entropy Service, never pure code. */
export function sealHistoryPacket(input: {
  readonly currentKey: Uint8Array;
  readonly previousKey: Uint8Array;
  readonly genesis: Hash;
  readonly epoch: number;
  readonly nonce: Uint8Array;
}): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    if (
      input.currentKey.byteLength !== 32 ||
      input.previousKey.byteLength !== 32 ||
      input.nonce.byteLength !== 24
    )
      return yield* invalid();
    yield* checkEpoch(input.epoch, 1);
    const sealed = xchacha20poly1305(
      copyBytes(input.currentKey),
      copyBytes(input.nonce),
      aad(input.genesis, input.epoch)
    ).encrypt(copyBytes(input.previousKey));
    if (sealed.byteLength !== 48) return yield* invalid();
    return concat([input.nonce, sealed]);
  });
}

export function openHistoryPacket(input: {
  readonly currentKey: Uint8Array;
  readonly packet: Uint8Array;
  readonly genesis: Hash;
  readonly epoch: number;
}): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    if (input.currentKey.byteLength !== 32 || input.packet.byteLength !== HISTORY_PACKET_BYTES)
      return yield* invalid();
    yield* checkEpoch(input.epoch, 1);
    return yield* Either.try({
      try: () =>
        xchacha20poly1305(
          copyBytes(input.currentKey),
          input.packet.subarray(0, 24),
          aad(input.genesis, input.epoch)
        ).decrypt(input.packet.subarray(24)),
      catch: () => new ValidationError({ code: 'invalid-operation' }),
    });
  });
}

/** Complete historical chain, or typed failure; never skips a missing/bad link. */
export function recoverHistory(input: {
  readonly genesis: Hash;
  readonly latestEpoch: number;
  readonly latestKey: Uint8Array;
  readonly packets: ReadonlyMap<number, { readonly commitment: Hash; readonly packet: Uint8Array }>;
}): Either.Either<Map<number, Uint8Array>, ValidationError> {
  return Either.gen(function* () {
    const latest = input.packets.get(input.latestEpoch);
    if (!latest) return yield* invalid();
    const commitment = yield* commitEpochKey(input.genesis, input.latestEpoch, input.latestKey);
    if (!bytesEqual(commitment, latest.commitment)) return yield* invalid();
    const keys = new Map<number, Uint8Array>();
    keys.set(input.latestEpoch, copyBytes(input.latestKey));
    let current: Uint8Array = copyBytes(input.latestKey);
    for (let epoch = input.latestEpoch; epoch >= 1; epoch--) {
      const row = input.packets.get(epoch);
      if (!row) return yield* invalid();
      const previous = yield* openHistoryPacket({
        currentKey: current,
        packet: row.packet,
        genesis: input.genesis,
        epoch,
      });
      const expected = input.packets.get(epoch - 1);
      const previousCommitment = yield* commitEpochKey(input.genesis, epoch - 1, previous);
      if (!expected || !bytesEqual(previousCommitment, expected.commitment))
        return yield* invalid();
      keys.set(epoch - 1, previous);
      current = previous;
    }
    return keys;
  });
}
