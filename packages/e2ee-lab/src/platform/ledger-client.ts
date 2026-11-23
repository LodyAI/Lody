import { Effect, Semaphore } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import type { LedgerCheckpoint } from '@lody/e2ee-core';
import { LedgerFeedError } from '@lody/e2ee-core';
import {
  makeLedgerStreamReader,
  type LedgerStreamReader,
} from '@lody/e2ee-core/adapters/loro-streams';
import { makeSqliteLedgerFeed } from '@lody/e2ee-core/internal';
import { type SnapshotFeedOrigin } from '@lody/e2ee-core';
import { makeSqliteSnapshotLedgerFeed } from '@lody/e2ee-core/internal';

type FullHistoryInput = Parameters<typeof makeSqliteLedgerFeed>[0];
type LabLedgerClientInput = { readonly stream: LedgerStreamReader } & (
  | (FullHistoryInput & { readonly snapshot?: undefined })
  | (Omit<FullHistoryInput, 'genesisRecord'> & { readonly snapshot: SnapshotFeedOrigin })
);

/** A scoped Lab client of public modules. Transport is borrowed; checkpoint
 * authority is supplied independently for each read. No private core or runtime. */
export function makeLabLedgerClient(input: LabLedgerClientInput) {
  return Effect.gen(function* () {
    const feed = yield* input.snapshot
      ? makeSqliteSnapshotLedgerFeed(input)
      : makeSqliteLedgerFeed(input);
    const sourceRead = input.stream.read.bind(input.stream);
    let pageCalls = 0;
    const reader = yield* makeLedgerStreamReader({
      read: (request) =>
        ++pageCalls > 4096
          ? Promise.reject(new LedgerFeedError({ code: 'read-too-large' }))
          : sourceRead(request),
    });
    const serial = yield* Semaphore.make(1);
    return Object.freeze({
      current: feed.current,
      read: (expected: LedgerCheckpoint) =>
        Effect.gen(function* () {
          // Capture before waiting for another read; caller mutation cannot change
          // the selected endpoint while the borrowed SDK operation is outstanding.
          const checkpoint = {
            head: yield* Effect.fromResult(Bytes.recordHash(expected.head.toBytes())),
            length: expected.length,
          };
          return yield* serial.withPermit(
            Effect.gen(function* () {
              const before = yield* feed.current();
              pageCalls = 0;
              let offset = before.offset,
                bytes = 0;
              const records: Uint8Array[] = [],
                visited = new Set([offset]);
              for (let pages = 0; pages < 4096; pages++) {
                const page = yield* reader.readAfter(offset);
                if (page.records.length > 0 && visited.has(page.nextOffset))
                  return yield* new LedgerFeedError({ code: 'invalid-offset' });
                if (records.length + page.records.length > 4096)
                  return yield* new LedgerFeedError({ code: 'read-too-large' });
                for (const record of page.records) {
                  bytes += record.length;
                  if (bytes > 16 * 1024 * 1024)
                    return yield* new LedgerFeedError({ code: 'read-too-large' });
                  records.push(record);
                }
                if (page.upToDate)
                  return yield* feed.accept(
                    {
                      requestOffset: before.offset,
                      nextOffset: page.nextOffset,
                      records,
                      upToDate: true,
                    },
                    checkpoint
                  );
                if (page.nextOffset === offset)
                  return yield* new LedgerFeedError({ code: 'invalid-offset' });
                visited.add(page.nextOffset);
                offset = page.nextOffset;
              }
              return yield* new LedgerFeedError({ code: 'read-too-large' });
            })
          );
        }),
    });
  });
}
