import { bytesEqual } from './cbor';
import type { SigningPointCache } from './crypto';
import { fail } from './error';
import { decodeRecord } from './schema';

/** Pure submit/resume choices. I/O, CAS and persistence stay in the Effect runner. */
export function selectSubmitWire(
  pending: Uint8Array | null,
  requested: Uint8Array | undefined
): Uint8Array {
  if (requested === undefined) {
    if (pending === null) fail('invalid-operation');
    return pending;
  }
  if (pending !== null && !bytesEqual(pending, requested)) fail('replay');
  return requested;
}

export function classifyLedgerPresence(input: {
  containsWire: boolean;
  previousMatchesHead: boolean;
}): 'committed' | 'conflict' | 'absent' {
  if (input.containsWire) return 'committed';
  if (!input.previousMatchesHead) return 'conflict';
  return 'absent';
}

export function classifyUnresolvedSubmit(input: {
  cas: 'accepted' | 'conflict' | 'unsupported' | 'unknown';
  retrying: boolean;
}): 'unsupported' | 'unknown' {
  if (input.cas === 'unsupported' && !input.retrying) return 'unsupported';
  return 'unknown';
}

export function ordinaryPreviousHash(record: Uint8Array, cache?: SigningPointCache): Uint8Array {
  const decoded = decodeRecord(record, cache);
  if (decoded.body.type !== 'ordinary') fail('genesis-mismatch');
  return decoded.body.fields.previousHash;
}
