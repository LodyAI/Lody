import { Point, hashes, verify as nobleVerify, verifyAsync } from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { Ledger } from '../src/ledger';
import { hashRecord, verifySignature } from '../src/ledger/crypto';
import { decodeRecord, signingBytesForBody } from '../src/ledger/schema';
import { buildChain, countSignatures } from './chain';

async function timed<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  const value = await fn();
  process.stderr.write(`${label}: ${(performance.now() - start).toFixed(1)}ms\n`);
  return value;
}

async function main() {
  const count = Number.parseInt(process.argv[2] ?? '400', 10);
  process.stderr.write(`building ${count}\n`);
  const { created, records, ledger } = await timed('build', () => buildChain(count));
  process.stderr.write(
    `sigs=${countSignatures(records)} bytes=${records.reduce((sum, record) => sum + record.byteLength, 0)} epoch=${ledger.state.epoch.number}\n`
  );

  await timed('verify-current-1', () => Ledger.verify({ anchor: created.anchor, records }));
  await timed('verify-current-2', () => Ledger.verify({ anchor: created.anchor, records }));

  const decoded = await timed('decode-all', () => records.map(decodeRecord));
  await timed('hash-all-async', async () => {
    for (const record of records) await hashRecord(record);
  });
  await timed('hash-all-sha256-sync', () => {
    const domain = new TextEncoder().encode('lody-e2ee/rec/v1\0');
    for (const record of records) {
      const tagged = new Uint8Array(domain.length + record.byteLength);
      tagged.set(domain);
      tagged.set(record, domain.length);
      sha256(tagged);
    }
  });

  await timed('sig-current-verifySignature', async () => {
    for (const rec of decoded) {
      if (
        !verifySignature(rec.body.fields.signer, signingBytesForBody(rec.bodyBytes), rec.signature)
      ) {
        throw new Error('bad-current');
      }
    }
  });

  hashes.sha512 = sha512;
  await timed('sig-noble-sync-no-extra-checks', () => {
    for (const rec of decoded) {
      if (
        !nobleVerify(rec.signature, signingBytesForBody(rec.bodyBytes), rec.body.fields.signer, {
          zip215: false,
        })
      ) {
        throw new Error('bad-sync');
      }
    }
  });

  const pointCache = new Map<string, Point>();
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
  const validA = (bytes: Uint8Array): Point => {
    const id = hex(bytes);
    const cached = pointCache.get(id);
    if (cached) return cached;
    const point = Point.fromBytes(bytes, false);
    if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('bad-A');
    pointCache.set(id, point);
    return point;
  };

  await timed('sig-sync+cachedA+R-torsion', () => {
    for (const rec of decoded) {
      validA(rec.body.fields.signer);
      if (!Point.fromBytes(rec.signature.subarray(0, 32), false).isTorsionFree())
        throw new Error('bad-R');
      if (
        !nobleVerify(rec.signature, signingBytesForBody(rec.bodyBytes), rec.body.fields.signer, {
          zip215: false,
        })
      ) {
        throw new Error('bad-cached');
      }
    }
  });

  await timed('sig-sync+cachedA-no-R-torsion', () => {
    for (const rec of decoded) {
      validA(rec.body.fields.signer);
      if (
        !nobleVerify(rec.signature, signingBytesForBody(rec.bodyBytes), rec.body.fields.signer, {
          zip215: false,
        })
      ) {
        throw new Error('bad-no-R');
      }
    }
  });

  const sample = decoded[1]!;
  const msg = signingBytesForBody(sample.bodyBytes);
  await timed('1000x isTorsionFree(R)', () => {
    const r = sample.signature.subarray(0, 32);
    for (let i = 0; i < 1000; i++) Point.fromBytes(r, false).isTorsionFree();
  });
  await timed('1000x nobleVerify sync', () => {
    for (let i = 0; i < 1000; i++) {
      nobleVerify(sample.signature, msg, sample.body.fields.signer, { zip215: false });
    }
  });
  await timed('1000x verifyAsync', async () => {
    for (let i = 0; i < 1000; i++) {
      await verifyAsync(sample.signature, msg, sample.body.fields.signer, { zip215: false });
    }
  });
}

await main();
