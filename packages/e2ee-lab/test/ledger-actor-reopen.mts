import { readFileSync } from 'node:fs';
import { Effect, Result } from 'effect';
import { StreamsClient } from '@loro-dev/streams-client';
import { Bytes, ContentError } from '@lody/e2ee-core';
import { makeLabLedgerActor } from '../src/platform/ledger-actor';
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const endpoint = {
  head: Result.getOrThrow(Bytes.recordHash(bytes(input.head))),
  length: input.length,
};
const output = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const actor = yield* makeLabLedgerActor({
        path: input.path,
        journalPath: input.journalPath,
        mode: 'open',
        genesis: Result.getOrThrow(Bytes.genesisHash(bytes(input.anchor))),
        genesisRecord: bytes(input.genesis),
        expected: { head: Result.getOrThrow(Bytes.recordHash(bytes(input.localHead))), length: 2 },
        budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
        stream: new StreamsClient({ url: input.url, retry: { maxAttempts: 1 } }),
        checkpoint: () => Effect.succeed(endpoint),
        signer: {
          publicKey: Result.getOrThrow(Bytes.signingPublicKey(bytes(input.publicKey))),
          sign: () => Effect.fail(new ContentError({ code: 'sign-failed' })),
        },
      });
      const result = yield* actor.resume();
      if (!result) throw new Error('missing retained result');
      const current = yield* actor.current();
      yield* actor.acknowledge(result);
      const empty = (yield* actor.resume()) === null;
      return {
        outcome: result.outcome,
        record: Buffer.from(result.record).toString('hex'),
        length: current.view.length,
        empty,
      };
    })
  )
);
process.stdout.write(JSON.stringify(output));
