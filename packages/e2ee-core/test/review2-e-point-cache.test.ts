// R2-E: a caller-owned cache must not let mixed-order keys bypass ledger decoding.
import { Effect, Result } from 'effect';
import { Point, utils } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  Ledger,
  SigningPointCache,
  encodeSignedRecord,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { decodeCbor, encodeCanonical } from '../src/ledger/cbor';
import { Bytes, verifyLedger } from '@lody/e2ee-core/effect';
import { signatureVerifierLayer } from '@lody/e2ee-core/effect/platform';
import { admitDeviceOp, append, ed25519, hex, random, signGenesis } from './ledger-fixtures';

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const le = (bytes: Uint8Array) => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
};
const le32 = (n: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

/** A real private key and two encodings of it: canonical A and A + T (T of order 2). */
function torsionPair() {
  const ext = utils.getExtendedPublicKey(random(32));
  const t = new Uint8Array(32).fill(0xff);
  t[0] = 0xec;
  t[31] = 0x7f; // y = p - 1, x = 0: the order-2 point
  const shifted = ext.point.add(Point.fromBytes(t, false));
  const signAs = (publicKey: Uint8Array) => async (message: Uint8Array) => {
    const r = le(sha512(cat(ext.prefix, message))) % L;
    const R = Point.BASE.multiply(r).toBytes();
    const k = le(sha512(cat(R, publicKey, message))) % L;
    return cat(R, le32((r + k * ext.scalar) % L));
  };
  const canonical = ext.pointBytes;
  const mixed = shifted.toBytes();
  return {
    canonical: { publicKey: canonical, enc: random(32), sign: signAs(canonical) },
    mixed: { publicKey: mixed, enc: random(32), sign: signAs(mixed) },
    mixedPoint: shifted,
  };
}

describe('R2-E export map: SigningPointCache poisoning', () => {
  it('rejects a revoked key encoded as A+T even with poisoned caller-owned point evidence', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const pair = torsionPair();
    // X25519 keys only need to be well-formed 32-byte values for the ledger.
    pair.canonical.enc = (await ed25519()).enc;
    pair.mixed.enc = (await ed25519()).enc;
    const records = [created.record];
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, pair.canonical, 'personal')
    );
    records.push(admitted.record);
    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: pair.canonical.publicKey,
    });
    records.push(revoked.record);
    expect(revoked.ledger.wasDeviceAdmitted(hex(pair.canonical.publicKey))).toBe(true);

    // No process-wide cache exists. Poison an explicitly supplied instance instead.
    const cache = new SigningPointCache();
    SigningPointCache.remember(cache, pair.mixed.publicKey, pair.mixedPoint);
    // Honest preparation rejects mixed keys, so construct the malicious wire body
    // from a valid proposal, with a real possession proof for the mixed encoding.
    const fresh = await ed25519();
    const proposal = revoked.ledger.prepare(
      await admitDeviceOp(created.anchor, created.membershipId, fresh, 'personal'),
      owner.publicKey
    );
    const body = decodeCbor(proposal.bodyBytes) as unknown[];
    const operation = body[2] as unknown[];
    const malicious = await admitDeviceOp(
      created.anchor,
      created.membershipId,
      pair.mixed,
      'personal'
    );
    operation[2] = pair.mixed.publicKey;
    operation[3] = pair.mixed.enc;
    operation[4] = malicious.possessionSignature;
    const bytes = encodeCanonical(body as never);
    records.push(encodeSignedRecord(bytes, await owner.sign(signingBytesForBody(bytes))));

    // The Effect verifier (own cache, strict points) rejects this history.
    const effect = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          return yield* verifyLedger({
            anchor: yield* Effect.fromResult(Bytes.genesisHash(created.anchor)),
            records,
          });
        })
      ).pipe(Effect.provide(signatureVerifierLayer))
    );
    expect(Result.isFailure(effect) && effect.failure.code).toBe('invalid-key');

    // Secure/spec behaviour: canonical prime-subgroup keys only, whatever the process cache holds.
    await expect(
      Ledger.verify({ anchor: created.anchor, records, pointCache: cache }).then((l) => l.length)
    ).rejects.toMatchObject({ code: 'invalid-key' });
  });
});
