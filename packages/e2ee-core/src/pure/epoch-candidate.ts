import { Result } from 'effect';
import { bytesEqual } from './cbor';
import { decodeRecord } from './ledger-schema';
import type { InternalState } from './ledger-state';
import { commitEpochKey, hashRecordBytes } from './wire-crypto';
import { ValidationError } from './errors';
import { keyId } from './identifiers';

export interface EpochCandidate {
  readonly genesis: Uint8Array;
  readonly epoch: number;
  readonly commitment: Uint8Array;
  readonly secret: Uint8Array;
  readonly record: Uint8Array;
}

export type CandidateBinding = 'current' | 'historical' | 'absent' | 'mismatch';

/** Storage decoding establishes shape only, never authority or commitment validity. */
export function decodeEpochCandidate(text: string): Result.Result<EpochCandidate, ValidationError> {
  return Result.gen(function* () {
    const row: unknown = yield* Result.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    if (row === null || typeof row !== 'object' || Array.isArray(row))
      return yield* Result.fail(new ValidationError({ code: 'canonical' }));
    if (
      !('epoch' in row) ||
      typeof row.epoch !== 'number' ||
      !Number.isSafeInteger(row.epoch) ||
      row.epoch < 1
    )
      return yield* Result.fail(new ValidationError({ code: 'invalid-operation' }));
    const hex = (input: unknown, length?: number): Result.Result<Uint8Array, ValidationError> => {
      if (
        typeof input !== 'string' ||
        !/^(?:[0-9a-f]{2})+$/.test(input) ||
        (length !== undefined && input.length !== length * 2)
      )
        return Result.fail(new ValidationError({ code: 'canonical' }));
      const bytes = new Uint8Array(input.length / 2);
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = Number.parseInt(input.slice(i * 2, i * 2 + 2), 16);
      return Result.succeed(bytes);
    };
    return {
      genesis: yield* hex('genesisHex' in row ? row.genesisHex : undefined, 32),
      epoch: row.epoch,
      commitment: yield* hex('commitmentHex' in row ? row.commitmentHex : undefined, 32),
      secret: yield* hex('secretHex' in row ? row.secretHex : undefined, 32),
      record: yield* hex('recordHex' in row ? row.recordHex : undefined),
    };
  });
}

/** Preserves the existing Lab JSON field order and trailing newline. */
export function encodeEpochCandidate(
  candidate: EpochCandidate
): Result.Result<string, ValidationError> {
  const text = `${JSON.stringify({
    genesisHex: keyId(candidate.genesis),
    epoch: candidate.epoch,
    commitmentHex: keyId(candidate.commitment),
    secretHex: keyId(candidate.secret),
    recordHex: keyId(candidate.record),
  })}\n`;
  return Result.map(decodeEpochCandidate(text), () => text);
}

/** Internal pure query. Only a verified Ledger supplies the state; disk is not authority. */
export function classifyEpochCandidate(
  state: InternalState,
  candidate: EpochCandidate
): CandidateBinding {
  if (!bytesEqual(state.genesis, candidate.genesis)) return 'mismatch';
  const commitment = commitEpochKey(candidate.genesis, candidate.epoch, candidate.secret);
  if (Result.isFailure(commitment) || !bytesEqual(commitment.success, candidate.commitment))
    return 'mismatch';
  const decoded = decodeRecord(candidate.record);
  if (Result.isFailure(decoded) || decoded.success.body.type !== 'ordinary') return 'mismatch';
  const operation = decoded.success.body.fields.operation;
  if (
    operation.type !== 'publishEpoch' ||
    operation.epoch !== candidate.epoch ||
    !bytesEqual(operation.commitment, commitment.success)
  )
    return 'mismatch';
  const digest = hashRecordBytes(candidate.record);
  if (!state.hashes.some((hash) => hash !== undefined && bytesEqual(hash, digest))) return 'absent';
  if (state.epoch.number === candidate.epoch)
    return bytesEqual(state.epoch.keyCommitment, commitment.success) ? 'current' : 'mismatch';
  if (state.epoch.number > candidate.epoch) {
    const row = state.historyPackets.get(candidate.epoch);
    return row && bytesEqual(row.commitment, commitment.success) ? 'historical' : 'mismatch';
  }
  return 'mismatch';
}
