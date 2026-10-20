import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendLedgerHistory } from '../src/lib/e2ee-ledger-history';
import {
  compareVerificationCode,
  groupHash,
  ledgerVerificationCode,
  parseVerificationCode,
} from '../src/lib/e2ee-ledger-verification';

// Frozen synthetic ledger v1 vector signed by fixed test keys.
const vector = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../e2ee-core/test/ledger-v1-vector.json'), 'utf8')
) as { anchor: string; records: { hex: string }[] };
const head = 'e7fe1ef3dfaa4e1001fd1a4df3a1af79f6c5d6cbc72b11502372b6030b813668';
const history = appendLedgerHistory(
  null,
  {
    workspaceId: 'w',
    genesisHash: vector.anchor,
    checkpoint: { headHash: head, length: 9 },
    startIndex: 0,
    nextCursor: null,
    recordsHex: vector.records.slice(0, 9).map((record) => record.hex),
  },
  { workspaceId: 'w', genesisHash: vector.anchor, localPin: vector.anchor }
);
const sixth = history.records[5]!.hash;
const code = ledgerVerificationCode(history);

describe('ledger verification code', () => {
  it('is the core comparison digest at the verified head and round-trips through its QR', () => {
    expect(code.version).toBe(9);
    expect(code.headHash).toBe(head);
    expect(code.stateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(code.stateDigest).not.toBe(head);
    expect(code.payload).toBe(`lody-ledger:1:9:${head}:${code.stateDigest}`);
    expect(parseVerificationCode(code.payload)).toEqual({
      version: 9,
      headHash: head,
      stateDigest: code.stateDigest,
    });
  });

  it('reads a pasted code however it was spaced, with the version from its header', () => {
    const grouped = groupHash(code.stateDigest).join(' ');
    expect(parseVerificationCode(grouped.toUpperCase())).toEqual({ stateDigest: code.stateDigest });
    expect(parseVerificationCode(`账本核验码（版本 1234）\n${grouped}`)).toEqual({
      version: 1234,
      stateDigest: code.stateDigest,
    });
    expect(parseVerificationCode(`Ledger code (version 9)\n${grouped}`)).toEqual({
      version: 9,
      stateDigest: code.stateDigest,
    });
    expect(parseVerificationCode('e7fe 1ef3')).toBeNull();
  });

  it('matches only the same digest at the same version', () => {
    expect(compareVerificationCode(history, { stateDigest: code.stateDigest })).toEqual({
      kind: 'match',
      version: 9,
    });
    expect(compareVerificationCode(history, { version: 9, stateDigest: 'ab'.repeat(32) })).toEqual({
      kind: 'mismatch',
    });
    // The right head with a different state is still a mismatch.
    expect(
      compareVerificationCode(history, { version: 9, headHash: head, stateDigest: 'ab'.repeat(32) })
    ).toEqual({ kind: 'mismatch' });
    expect(compareVerificationCode(history, { stateDigest: 'ab'.repeat(32) })).toEqual({
      kind: 'unknown',
    });
  });

  it('tells an older or newer ledger apart from a forked one', () => {
    const other = 'ab'.repeat(32);
    expect(
      compareVerificationCode(history, { version: 6, headHash: sixth, stateDigest: other })
    ).toEqual({ kind: 'theirs-older', version: 6, prefixConfirmed: true });
    expect(compareVerificationCode(history, { version: 6, stateDigest: other })).toEqual({
      kind: 'theirs-older',
      version: 6,
      prefixConfirmed: false,
    });
    expect(
      compareVerificationCode(history, { version: 5, headHash: sixth, stateDigest: other })
    ).toEqual({ kind: 'mismatch' });
    expect(compareVerificationCode(history, { version: 12, stateDigest: other })).toEqual({
      kind: 'theirs-newer',
      version: 12,
    });
  });
});
