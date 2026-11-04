import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  MAX_ARRAY_LENGTH,
  MAX_BSTR_BYTES,
  MAX_RECORD_BYTES,
  MAX_RETAINED_STATE_BYTES,
  MAX_SNAPSHOT_BYTES,
  decodeCbor,
  decodeRetainedCbor,
  decodeSnapshotCbor,
  encodeCanonical,
  encodeRetainedCbor,
  encodeSnapshotCbor,
  referenceCodec,
  type CborValue,
} from '../src/internal/foundation/cbor';

// Deterministic generator: the same cases on every run.
function random(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  return { next, int: (n: number) => Math.floor(next() * n) };
}
const outcome = <A>(result: Result.Result<A, { readonly code: string }>) =>
  Result.isSuccess(result) ? { ok: result.success } : { error: result.failure.code };

const BOUNDARY = [
  0,
  1,
  23,
  24,
  255,
  256,
  65_535,
  65_536,
  2 ** 32 - 1,
  2 ** 32,
  Number.MAX_SAFE_INTEGER,
];
function value(r: ReturnType<typeof random>, depth: number): unknown {
  const pick = r.int(depth > 9 ? 6 : 9);
  if (pick === 0) return BOUNDARY[r.int(BOUNDARY.length)]! + (r.next() < 0.2 ? 1 : 0);
  if (pick === 1) return r.int(1000);
  if (pick === 2) {
    // Around the record limit, and table-sized for snapshot and retained state.
    const roll = r.next();
    const length = roll < 0.1 ? 250 + r.int(12) : roll < 0.15 ? 300 + r.int(4000) : r.int(40);
    return new Uint8Array(length).map(() => r.int(256));
  }
  if (pick === 3) return [null, true, false][r.int(3)];
  if (pick === 4) return r.next() < 0.5 ? -1 - r.int(5) : 1.5; // never valid
  if (pick === 5) return r.next() < 0.5 ? 'text' : undefined; // never valid
  const length = r.next() < 0.1 ? 30 + r.int(8) : r.int(5);
  return Array.from({ length }, () => value(r, depth + 1));
}

/** Handwritten edge encodings the fast decoder must hand to the reference path. */
const EDGES = [
  '',
  '00',
  '17',
  '1817',
  '1818',
  '190017',
  '1a0000ffff',
  '1b00000000ffffffff',
  '1b0020000000000000',
  '1bffffffffffffffff',
  '1c',
  '1f',
  '20',
  '3b0000000000000000',
  '40',
  '4100',
  '5801',
  '58010000',
  '5900020102',
  '5f4100ff',
  '60',
  '6161',
  '80',
  '8100',
  '81',
  '9f00ff',
  'a0',
  'a10000',
  'c240',
  'd82a4100',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8ff',
  'f97e00',
  'fa3fc00000',
  'fb3ff8000000000000',
  'ff',
  '0000',
  '8000',
  '818181818181818181',
  '81818181818181818100',
  '8181818181818181818100',
].map((hex) => new Uint8Array(Buffer.from(hex, 'hex')));
// Over the byte-string, array and record limits.
EDGES.push(
  new Uint8Array([0x59, 0x01, 0x01, ...new Uint8Array(257)]),
  new Uint8Array([0x98, 33, ...new Uint8Array(33)]),
  new Uint8Array([0x5a, 0, 0, 0x20, 0x01, ...new Uint8Array(8193)])
);

describe('CBOR fast paths agree with the dag-cbor reference', () => {
  it('encodes every generated value to the same bytes or the same error', () => {
    const r = random(0x5eed);
    for (let i = 0; i < 6000; i++) {
      const input = value(r, 0) as CborValue;
      for (const [maxBytes, maxBstr, encode] of [
        [MAX_RECORD_BYTES, MAX_BSTR_BYTES, encodeCanonical],
        [MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES, encodeSnapshotCbor],
        [MAX_RETAINED_STATE_BYTES, MAX_RETAINED_STATE_BYTES, encodeRetainedCbor],
      ] as const)
        expect(outcome(encode(input))).toEqual(
          outcome(referenceCodec.encode(input, maxBytes, MAX_ARRAY_LENGTH, maxBstr))
        );
    }
  });

  it('decodes valid, mutated, edge and random inputs to the same value or the same error', () => {
    const r = random(0xc0ffee);
    const inputs: Uint8Array[] = [...EDGES];
    for (let i = 0; i < 4000; i++) {
      const encoded = referenceCodec.encode(
        value(r, 0) as CborValue,
        MAX_SNAPSHOT_BYTES,
        64,
        MAX_SNAPSHOT_BYTES
      );
      if (Result.isFailure(encoded)) continue;
      const bytes = encoded.success;
      inputs.push(bytes);
      const mutated = bytes.slice();
      mutated[r.int(mutated.length)] = r.int(256);
      inputs.push(
        mutated,
        bytes.subarray(0, r.int(bytes.length)),
        new Uint8Array([...bytes, r.int(256)])
      );
    }
    for (let i = 0; i < 4000; i++) inputs.push(new Uint8Array(1 + r.int(24)).map(() => r.int(256)));
    let accepted = 0;
    for (const input of inputs) {
      const fast = outcome(decodeCbor(input));
      expect(fast).toEqual(
        outcome(referenceCodec.decode(input, MAX_RECORD_BYTES, MAX_ARRAY_LENGTH))
      );
      expect(outcome(decodeSnapshotCbor(input))).toEqual(
        outcome(
          referenceCodec.decode(input, MAX_SNAPSHOT_BYTES, MAX_ARRAY_LENGTH, MAX_SNAPSHOT_BYTES)
        )
      );
      expect(outcome(decodeRetainedCbor(input))).toEqual(
        outcome(
          referenceCodec.decode(
            input,
            MAX_RETAINED_STATE_BYTES,
            MAX_ARRAY_LENGTH,
            MAX_RETAINED_STATE_BYTES
          )
        )
      );
      if ('ok' in fast) accepted++;
    }
    // The corpus must exercise acceptance as well as every rejection kind.
    expect(accepted).toBeGreaterThan(3000);
    const codes = new Set(
      inputs
        .map((input) => outcome(decodeCbor(input)))
        .flatMap((o) => ('error' in o ? [o.error] : []))
    );
    expect([...codes].sort()).toEqual(
      expect.arrayContaining(['canonical', 'nesting', 'oversize', 'trailing', 'truncated'])
    );
  });

  it('returns fresh copies, never views of the input', () => {
    const input = new Uint8Array(Buffer.from('824201020a', 'hex'));
    const decoded = Result.getOrThrow(decodeCbor(input)) as [Uint8Array, number];
    input[2] = 9;
    expect([...decoded[0]]).toEqual([1, 2]);
  });
});
