import { readFileSync } from 'node:fs';
import { Bytes } from '@lody/e2ee-core';
import { Effect, Result } from 'effect';
import { makeLabSnapshotCache } from '../src/platform/snapshot-cache';
// Independently supplied synthetic qualification fixture, not SQLite-selected trust.
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const ok = Result.getOrThrow;
const out = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const cache = yield* makeLabSnapshotCache({ path: input.path, mode: 'open' });
      const saved = yield* cache.get({
        source: 'external-confirmation',
        genesis: ok(Bytes.genesisHash(bytes(input.genesis))),
        head: ok(Bytes.recordHash(bytes(input.head))),
        length: input.length,
        endorser: ok(Bytes.signingPublicKey(bytes(input.endorser))),
        membershipId: ok(Bytes.membershipId(bytes(input.membership))),
        headSignature: ok(Bytes.signature(bytes(input.headSignature))),
        role: input.role,
        kind: input.kind,
        stateDigest: ok(Bytes.recordHash(bytes(input.digest))),
      });
      if (!saved) throw new Error('missing qualified snapshot');
      return {
        length: saved.view.length,
        head: Buffer.from(saved.view.head.toBytes()).toString('hex'),
        verification: saved.view.verification,
        snapshot: Buffer.from(saved.snapshot()).toString('hex'),
      };
    })
  )
);
process.stdout.write(JSON.stringify(out));
