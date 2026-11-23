import { readFileSync } from 'node:fs';
import { Effect, Result } from 'effect';
import { StreamsClient } from '@loro-dev/streams-client';
import { Bytes } from '@lody/e2ee-core';
import { makeLabLedgerClient } from '../src/platform/ledger-client';
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const expected = {
  head: Result.getOrThrow(Bytes.recordHash(bytes(input.head))),
  length: input.length,
};
const output = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* makeLabLedgerClient({
        path: input.path,
        mode: 'open',
        genesis: Result.getOrThrow(Bytes.genesisHash(bytes(input.anchor))),
        genesisRecord: bytes(input.genesis),
        expected,
        budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
        stream: new StreamsClient({ url: input.url, retry: { maxAttempts: 1 } }),
      });
      const result = yield* Effect.result(client.read(expected));
      const current = yield* client.current();
      if (
        !Result.isFailure(result) ||
        !current.view.head.equals(expected.head) ||
        current.offset !== input.offset
      )
        throw new Error('child did not retain the independently selected history and cursor');
      return { offset: current.offset, length: current.view.length, rejected: true };
    })
  )
);
process.stdout.write(JSON.stringify(output));
