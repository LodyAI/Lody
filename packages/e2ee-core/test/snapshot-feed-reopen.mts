import { readFileSync } from 'node:fs';
import { Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core/protocol';
import { makeSqliteSnapshotLedgerFeed } from './ledger/feed-fixture';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const ok = Result.getOrThrow;
const genesis = ok(Bytes.genesisHash(bytes(input.genesis)));
const output = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const feed = yield* makeSqliteSnapshotLedgerFeed({
        path: input.path,
        mode: 'open',
        genesis,
        snapshot: {
          bytes: bytes(input.snapshot),
          offset: input.originOffset,
          trust: {
            source: 'external-confirmation',
            genesis,
            head: ok(Bytes.recordHash(bytes(input.trust.head))),
            length: input.trust.length,
            endorser: ok(Bytes.signingPublicKey(bytes(input.trust.endorser))),
            membershipId: ok(Bytes.membershipId(bytes(input.trust.membershipId))),
            headSignature: ok(Bytes.signature(bytes(input.trust.headSignature))),
            role: 'owner',
            kind: 'personal',
          },
        },
        expected: { head: ok(Bytes.recordHash(bytes(input.head))), length: input.length },
        budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
      });
      const current = yield* feed.current();
      return {
        pid: process.pid,
        offset: current.offset,
        length: current.view.length,
        head: Buffer.from(current.view.head.toBytes()).toString('hex'),
        verification: current.view.verification,
      };
    })
  )
);
process.stdout.write(JSON.stringify(output));
