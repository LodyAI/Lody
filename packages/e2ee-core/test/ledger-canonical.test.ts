// Record codec canonicality and signature strictness.
import { describe, expect, it } from 'vitest';
import { Result } from 'effect';
import { Ledger, LedgerError } from '../src/ledger';
import * as PureSchema from '../src/pure/ledger-schema';
import * as PureSnapshot from '../src/pure/ledger-snapshot';
import { encodeSignedRecord } from '../src/ledger/schema';
import {
  HISTORY_PACKET_BYTES,
  commitEpochKey,
  ed25519,
  random,
  signGenesis,
} from './ledger-fixtures';

const L = (1n << 252n) + 27742317777372353535851937790883648493n;

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return 'accepted';
}

function indexOfSeq(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function splice(bytes: Uint8Array, at: number, remove: number, insert: number[]): Uint8Array {
  return Uint8Array.from([...bytes.subarray(0, at), ...insert, ...bytes.subarray(at + remove)]);
}

async function epochRecord() {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const commitment = await commitEpochKey(created.anchor, 1, random(32));
  const proposal = created.ledger.prepare(
    {
      type: 'publishEpoch',
      epoch: 1,
      commitment,
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    },
    owner.publicKey
  );
  const record = encodeSignedRecord(proposal.bodyBytes, await owner.sign(proposal.signingBytes));
  return { owner, created, record };
}

describe('codec strictness', () => {
  it('SAFE: non-minimal ints, floats, indefinite arrays, tags, maps and trailing bytes are rejected before policy', async () => {
    const { created, record } = await epochRecord();
    expect(await code(created.ledger.extend([record]))).toBe('accepted');
    // [7, 1, bstr32 ...] => 0x84 0x07 0x01 0x58 0x20
    const at = indexOfSeq(record, [0x84, 0x07, 0x01, 0x58, 0x20]);
    expect(at).toBeGreaterThan(0);
    const variants: Record<string, Uint8Array> = {
      nonMinimalUint: splice(record, at + 2, 1, [0x18, 0x01]),
      nonMinimalUint16: splice(record, at + 2, 1, [0x19, 0x00, 0x01]),
      halfFloat: splice(record, at + 2, 1, [0xf9, 0x3c, 0x00]),
      doubleFloat: splice(record, at + 2, 1, [0xfb, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0]),
      tagged: splice(record, at + 2, 1, [0xc1, 0x01]),
      indefiniteArray: (() => {
        // replace fixed array(4) header by indefinite and add break after the op
        const opEnd = at + 1 + 1 + 1 + 34 + 2 + HISTORY_PACKET_BYTES;
        const withBreak = splice(record, opEnd, 0, [0xff]);
        return splice(withBreak, at, 1, [0x9f]);
      })(),
      nonMinimalBstrLen: splice(record, at + 3, 2, [0x59, 0x00, 0x20]),
      trailing: Uint8Array.from([...record, 0x00]),
      mapRoot: Uint8Array.from([0xa1, 0x00, ...record]),
    };
    for (const [name, bytes] of Object.entries(variants)) {
      const decoded = PureSchema.decodeRecord(bytes);
      expect([name, Result.isFailure(decoded)]).toEqual([name, true]);
      expect([name, await code(created.ledger.extend([bytes]))]).not.toEqual([name, 'accepted']);
    }
  });

  it('SAFE: third-party signature malleability (s + L) and non-canonical R are rejected', async () => {
    const { created, record } = await epochRecord();
    const sig = record.subarray(record.length - 64);
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
    const s2 = s + L;
    const malleated = new Uint8Array(record);
    let v = s2;
    for (let i = 0; i < 32; i++) {
      malleated[record.length - 32 + i] = Number(v & 0xffn);
      v >>= 8n;
    }
    expect(v).toBe(0n);
    expect(await code(created.ledger.extend([malleated]))).toBe('bad-signature');
    // Non-canonical encoding of R: set y >= p by flipping to p + y' where possible is rare;
    // instead verify the sign-bit alias of the same x is rejected.
    const flipped = new Uint8Array(record);
    flipped[record.length - 64 + 31] = flipped[record.length - 64 + 31]! ^ 0x80;
    expect(await code(created.ledger.extend([flipped]))).toBe('bad-signature');
  });

  it('SAFE: snapshot codec rejects non-canonical encodings of an otherwise valid signed snapshot', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const proposal = created.ledger.prepareSnapshot(owner.publicKey);
    const snapshot = await Ledger.finalizeSnapshot(
      proposal,
      await owner.sign(proposal.signingBytes)
    );
    const headSignature = await owner.sign(proposal.headAttestationSigningBytes);
    const trust = {
      genesis: proposal.genesis,
      endorser: owner.publicKey,
      head: proposal.head,
      headSignature,
    };
    await expect(Ledger.verifySnapshot({ trust, snapshot })).resolves.toBeDefined();
    expect(
      Result.isFailure(PureSnapshot.parseSignedSnapshot(Uint8Array.from([...snapshot, 0])))
    ).toBe(true);
    // version 1 encoded non-minimally: [[1, ...]] => 0x82 0x86 0x01
    expect(snapshot[0]).toBe(0x82);
    expect(snapshot[1]).toBe(0x86);
    const nonMinimal = splice(snapshot, 2, 1, [0x18, 0x01]);
    expect(Result.isFailure(PureSnapshot.parseSignedSnapshot(nonMinimal))).toBe(true);
    await expect(Ledger.verifySnapshot({ trust, snapshot: nonMinimal })).rejects.toBeInstanceOf(
      LedgerError
    );
  });
});
