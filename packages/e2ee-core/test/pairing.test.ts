import { encode } from '@ipld/dag-cbor';
import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import vector from './pairing-vector.json';
import {
  PAIRING_MAX_WORKSPACES,
  PAIRING_REQUEST_MAX_LIFETIME_MS,
  checkPairingRequestLifetime,
  decodePairingApproval,
  decodePairingRequest,
  derivePairingKeys,
  disposePairingKeys,
  encodePairingApproval,
  encodePairingRequest,
  encodePairingSecret,
  formatPairingString,
  pairingApprovalTag,
  pairingQrPayload,
  pairingRequestDigest,
  pairingRequestTag,
  parsePairingString,
  verifyPairingApprovalTag,
  verifyPairingRequestTag,
  type PairingApproval,
  type PairingRequest,
} from '../src/protocol';

// Synthetic fixed vector produced by test/generate-pairing-vector.py, an
// independent standard-library implementation of the approved format.
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
const fill = (byte: number, size = 32) => new Uint8Array(size).fill(byte);
const secret = bytes(vector.secret);
const ok = Result.getOrThrow;
const failure = <A, E>(result: Result.Result<A, E>) => {
  if (Result.isSuccess(result)) throw new Error('expected failure');
  return result.failure;
};
const request = (lookupId: Uint8Array): PairingRequest => ({
  account: 'synthetic-account',
  lookupId,
  direction: 'requester-shows',
  deviceName: 'Synthetic laptop',
  expiresAt: 1_800_000_600_000,
  rows: [
    {
      genesis: fill(0x11),
      signingPublicKey: fill(0x12),
      encryptionPublicKey: fill(0x13),
      possessionProof: fill(0x14, 64),
      credentialHash: fill(0x15),
    },
    {
      genesis: fill(0x22),
      signingPublicKey: fill(0x23),
      encryptionPublicKey: fill(0x24),
      possessionProof: fill(0x25, 64),
      credentialHash: fill(0x26),
    },
  ],
});
const approval = (requestDigest: Uint8Array): PairingApproval => ({
  requestDigest,
  approverSigningPublicKey: fill(0x33),
  rows: [
    { genesis: fill(0x22), admissionRecordHash: fill(0x27), invitationDigest: fill(0x28) },
    { genesis: fill(0x11), admissionRecordHash: fill(0x16), invitationDigest: fill(0x17) },
  ],
});

describe('pairing string', () => {
  it('encodes the secret as 28 Crockford characters with check digits, grouped and as a QR URL', () => {
    const encoded = ok(encodePairingSecret(secret));
    expect(encoded).toBe(vector.string);
    expect(encoded).toHaveLength(28);
    expect(formatPairingString(encoded)).toBe(encoded.match(/.{4}/g)!.join('-'));
    expect(pairingQrPayload(encoded)).toBe(`lody://pair/${encoded}`);
    expect(Result.isFailure(encodePairingSecret(fill(1, 15)))).toBe(true);
  });

  it('parses grouped, lowercased, spaced, look-alike and URL forms to the same secret', () => {
    const lookAlike = vector.string.replaceAll('0', 'O').replaceAll('1', 'I');
    for (const input of [
      vector.string,
      formatPairingString(vector.string),
      ` ${formatPairingString(vector.string).toLowerCase()} `,
      formatPairingString(vector.string).replaceAll('-', ' '),
      lookAlike,
      vector.string.replaceAll('1', 'l'),
      pairingQrPayload(vector.string),
      `LODY://PAIR/${formatPairingString(vector.string)}`,
    ])
      expect(hex(ok(parsePairingString(input)))).toBe(vector.secret);
  });

  it('names a wrong length, a stray character, a typo and an unknown version before any network use', () => {
    expect(failure(parsePairingString(''))).toMatchObject({ code: 'length' });
    expect(failure(parsePairingString(vector.string.slice(0, 27)))).toMatchObject({
      code: 'length',
    });
    expect(failure(parsePairingString(`${vector.string}0`))).toMatchObject({ code: 'length' });
    expect(failure(parsePairingString(`U${vector.string.slice(1)}`))).toMatchObject({
      code: 'character',
    });
    // Every single-character substitution is either rejected or decodes elsewhere.
    let detected = 0;
    for (let index = 0; index < 28; index++) {
      const replacement = vector.string[index] === 'A' ? 'B' : 'A';
      const typo = vector.string.slice(0, index) + replacement + vector.string.slice(index + 1);
      const parsed = parsePairingString(typo);
      if (Result.isFailure(parsed)) {
        expect(['checksum', 'version']).toContain(parsed.failure.code);
        detected++;
      }
    }
    expect(detected).toBe(28);
    // Version bits live in the first character's top two bits.
    const versioned = 'G' + vector.string.slice(1);
    expect(failure(parsePairingString(versioned))).toMatchObject({ code: 'version' });
  });
});

describe('pairing keys and tags', () => {
  it('derives domain-separated lookup, request and approval keys', () => {
    const keys = ok(derivePairingKeys(secret));
    expect(hex(keys.lookupId)).toBe(vector.lookupId);
    expect(hex(keys.requestKey)).toBe(vector.requestKey);
    expect(hex(keys.approvalKey)).toBe(vector.approvalKey);
    expect(new Set([hex(keys.requestKey), hex(keys.approvalKey)]).size).toBe(2);
    disposePairingKeys(keys);
    expect(keys.requestKey.every((byte) => byte === 0)).toBe(true);
    expect(keys.approvalKey.every((byte) => byte === 0)).toBe(true);
    expect(Result.isFailure(derivePairingKeys(fill(1, 17)))).toBe(true);
  });

  it('pins the canonical request bytes, digest and tag, independently of row order', () => {
    const keys = ok(derivePairingKeys(secret));
    const original = request(keys.lookupId);
    expect(hex(ok(encodePairingRequest(original)))).toBe(vector.requestBytes);
    const reordered = { ...original, rows: [...original.rows].reverse() };
    expect(hex(ok(encodePairingRequest(reordered)))).toBe(vector.requestBytes);
    expect(hex(ok(pairingRequestDigest(original)))).toBe(vector.requestDigest);
    const tag = ok(pairingRequestTag(keys, original));
    expect(hex(tag)).toBe(vector.requestTag);
    expect(Result.isSuccess(verifyPairingRequestTag(keys, original, tag))).toBe(true);
  });

  it('rejects any change to keys, rows, name, expiry, direction or account as tampering', () => {
    const keys = ok(derivePairingKeys(secret));
    const original = request(keys.lookupId);
    const tag = ok(pairingRequestTag(keys, original));
    const [first, second] = original.rows;
    for (const changed of [
      { ...original, rows: [{ ...first!, signingPublicKey: fill(0x99) }, second!] },
      { ...original, rows: [first!, { ...second!, encryptionPublicKey: fill(0x99) }] },
      { ...original, rows: [first!] },
      { ...original, deviceName: 'Attacker laptop' },
      { ...original, expiresAt: original.expiresAt + 1 },
      { ...original, direction: 'approver-shows' as const },
      { ...original, account: 'another-account' },
      { ...original, lookupId: fill(0x01, 16) },
    ])
      expect(failure(verifyPairingRequestTag(keys, changed, tag))).toMatchObject({
        code: 'authentication',
      });
    // A tag under another secret never verifies.
    const other = ok(derivePairingKeys(fill(0x55, 16)));
    expect(failure(verifyPairingRequestTag(other, original, tag))).toMatchObject({
      code: 'authentication',
    });
  });

  it('caps a request and an approval at the relay workspace limit', () => {
    expect(PAIRING_MAX_WORKSPACES).toBe(64);
    const keys = ok(derivePairingKeys(secret));
    const row = (index: number) => ({
      genesis: new Uint8Array(32)
        .fill(0)
        .map((_, at) => (at === 0 ? index >> 8 : at === 1 ? index & 255 : 7)),
      signingPublicKey: fill(0x12),
      encryptionPublicKey: fill(0x13),
      possessionProof: fill(0x14, 64),
      credentialHash: fill(0x15),
    });
    const rows = (count: number) => Array.from({ length: count }, (_, index) => row(index));
    const atLimit = { ...request(keys.lookupId), rows: rows(PAIRING_MAX_WORKSPACES) };
    expect(Result.isSuccess(encodePairingRequest(atLimit))).toBe(true);
    expect(
      failure(encodePairingRequest({ ...atLimit, rows: rows(PAIRING_MAX_WORKSPACES + 1) }))
    ).toMatchObject({ code: 'invalid-input' });
    const approvalRows = (count: number) =>
      rows(count).map((item) => ({
        genesis: item.genesis,
        admissionRecordHash: fill(0x16),
        invitationDigest: fill(0x17),
      }));
    const base = approval(fill(0x01));
    expect(
      Result.isSuccess(
        encodePairingApproval({ ...base, rows: approvalRows(PAIRING_MAX_WORKSPACES) })
      )
    ).toBe(true);
    expect(
      failure(encodePairingApproval({ ...base, rows: approvalRows(PAIRING_MAX_WORKSPACES + 1) }))
    ).toMatchObject({ code: 'invalid-input' });
  });

  it('refuses malformed requests before computing a tag', () => {
    const keys = ok(derivePairingKeys(secret));
    const original = request(keys.lookupId);
    const [first] = original.rows;
    for (const malformed of [
      { ...original, rows: [] },
      { ...original, rows: [first!, { ...first! }] },
      { ...original, rows: [{ ...first!, genesis: fill(1, 31) }] },
      { ...original, lookupId: fill(1, 15) },
      { ...original, deviceName: '' },
      { ...original, account: '' },
      { ...original, expiresAt: -1 },
      { ...original, expiresAt: 1.5 },
    ])
      expect(failure(pairingRequestTag(keys, malformed))).toMatchObject({ code: 'invalid-input' });
  });

  it('pins the approval tag, binds the approver and is never accepted as a request tag', () => {
    const keys = ok(derivePairingKeys(secret));
    const digest = ok(pairingRequestDigest(request(keys.lookupId)));
    const original = approval(digest);
    expect(hex(ok(encodePairingApproval(original)))).toBe(vector.approvalBytes);
    const tag = ok(pairingApprovalTag(keys, original));
    expect(hex(tag)).toBe(vector.approvalTag);
    expect(Result.isSuccess(verifyPairingApprovalTag(keys, original, tag))).toBe(true);
    for (const changed of [
      { ...original, approverSigningPublicKey: fill(0x34) },
      { ...original, requestDigest: fill(0x35) },
      { ...original, rows: original.rows.slice(0, 1) },
    ])
      expect(failure(verifyPairingApprovalTag(keys, changed, tag))).toMatchObject({
        code: 'authentication',
      });
    // Reflection: the request tag never verifies as an approval and vice versa.
    const requestTag = ok(pairingRequestTag(keys, request(keys.lookupId)));
    expect(failure(verifyPairingApprovalTag(keys, original, requestTag))).toMatchObject({
      code: 'authentication',
    });
    expect(failure(verifyPairingRequestTag(keys, request(keys.lookupId), tag))).toMatchObject({
      code: 'authentication',
    });
  });

  it('accepts only a still-open request whose expiry is at most ten minutes away', () => {
    const now = 1_800_000_000_000;
    const at = (expiresAt: number) =>
      checkPairingRequestLifetime({ ...request(fill(1, 16)), expiresAt }, now);
    expect(Result.isSuccess(at(now + PAIRING_REQUEST_MAX_LIFETIME_MS))).toBe(true);
    expect(Result.isSuccess(at(now + 1))).toBe(true);
    expect(failure(at(now))).toMatchObject({ code: 'expired' });
    expect(failure(at(now - 1))).toMatchObject({ code: 'expired' });
    // A lifetime longer than allowed (plus the clock-skew allowance) is refused.
    expect(failure(at(now + PAIRING_REQUEST_MAX_LIFETIME_MS + 60_001))).toMatchObject({
      code: 'invalid-input',
    });
  });
});

describe('pairing decoding', () => {
  it('decodes the pinned request and approval bytes back to the same values', () => {
    const keys = ok(derivePairingKeys(secret));
    const decoded = ok(decodePairingRequest(bytes(vector.requestBytes)));
    expect(hex(ok(encodePairingRequest(decoded)))).toBe(vector.requestBytes);
    expect(decoded).toMatchObject({
      account: 'synthetic-account',
      direction: 'requester-shows',
      deviceName: 'Synthetic laptop',
      expiresAt: 1_800_000_600_000,
    });
    expect(hex(decoded.lookupId)).toBe(vector.lookupId);
    expect(decoded.rows.map((row) => hex(row.genesis))).toEqual([hex(fill(0x11)), hex(fill(0x22))]);
    expect(Result.isSuccess(verifyPairingRequestTag(keys, decoded, bytes(vector.requestTag)))).toBe(
      true
    );
    const approvalDecoded = ok(decodePairingApproval(bytes(vector.approvalBytes)));
    expect(hex(ok(encodePairingApproval(approvalDecoded)))).toBe(vector.approvalBytes);
    expect(hex(approvalDecoded.requestDigest)).toBe(vector.requestDigest);
  });

  it('refuses non-canonical, foreign, oversized and malformed bytes', () => {
    const decoded = ok(decodePairingRequest(bytes(vector.requestBytes)));
    const tuple = (rows: unknown[]) => [
      'lody-e2ee/pair-request/v1',
      decoded.account,
      decoded.lookupId,
      decoded.direction,
      decoded.deviceName,
      decoded.expiresAt,
      rows,
    ];
    const asRows = decoded.rows.map((row) => [
      row.genesis,
      row.signingPublicKey,
      row.encryptionPublicKey,
      row.possessionProof,
      row.credentialHash,
    ]);
    for (const malformed of [
      new Uint8Array(),
      bytes('ff'),
      // Rows out of order are not the canonical encoding.
      encode(tuple([...asRows].reverse())),
      encode(tuple([asRows[0], asRows[0]])),
      encode(['lody-e2ee/pair-approval/v1', ...tuple(asRows).slice(1)]),
      encode(tuple(asRows).slice(0, 6)),
      encode({ request: tuple(asRows) }),
      new Uint8Array(256 * 1024 + 1),
    ])
      expect(failure(decodePairingRequest(malformed))).toMatchObject({ code: 'invalid-input' });
    // An approval is never accepted as a request, nor the reverse.
    expect(failure(decodePairingRequest(bytes(vector.approvalBytes)))).toMatchObject({
      code: 'invalid-input',
    });
    expect(failure(decodePairingApproval(bytes(vector.requestBytes)))).toMatchObject({
      code: 'invalid-input',
    });
  });
});
