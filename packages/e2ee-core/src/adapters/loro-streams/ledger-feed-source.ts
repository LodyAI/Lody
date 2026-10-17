import { Effect, Layer } from 'effect';
import { LedgerFeedSource } from '../../services/ledger';
import {
  LedgerFeedError,
  validLedgerOffset,
  type LedgerReadPage,
} from '../../internal/ledger/feed-page';
/** Structural shape of released streams-client 0.9 read. No vendored SDK or HTTP authority. */
export interface LedgerStreamReader {
  readonly read: (input: { readonly offset: string; readonly signal: AbortSignal }) => Promise<
    | {
        readonly ok: true;
        readonly result: {
          readonly requestOffset: string;
          readonly nextOffset: string;
          readonly upToDate: boolean;
          readonly payload: { readonly contentType: string; readonly body: Uint8Array };
        };
      }
    | { readonly ok: false; readonly result: unknown }
  >;
}
const fail = (code: LedgerFeedError['code']) => new LedgerFeedError({ code });
/**
 * Bounded reader of a ledger control stream's original u32be-framed records.
 * Not a trust or freshness source: pages are verified by `LedgerFeed`. The
 * enclosing Scope cancels and awaits every in-flight read before the borrowed
 * SDK client may be destroyed.
 *
 * @category Loro Streams adapters
 */
export const makeLedgerStreamReader = Effect.fnUntraced(function* (stream: LedgerStreamReader) {
  const read = stream.read.bind(stream);
  let closed = false;
  const pending = new Map<AbortController, Promise<void>>();
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      for (const controller of pending.keys()) controller.abort();
      yield* Effect.promise(() => Promise.all([...pending.values()]).then(() => undefined));
    })
  );
  const fetch = (offset: string) =>
    Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.tryPromise({
          try: async () => {
            if (closed) throw fail('closed');
            // Register before entering the borrowed read function, including synchronous throw.
            let finish!: () => void;
            const settled = new Promise<void>((resolve) => {
              finish = resolve;
            });
            pending.set(controller, settled);
            try {
              const output = await read({ offset, signal: controller.signal });
              if (closed || controller.signal.aborted) throw fail('closed');
              if (!output.ok)
                throw new LedgerFeedError({ code: 'transport', cause: output.result });
              const row = output.result;
              if (
                row.requestOffset !== offset ||
                !validLedgerOffset(row.nextOffset) ||
                typeof row.upToDate !== 'boolean'
              )
                throw fail('offset-mismatch');
              if (
                row.payload.contentType !== 'application/octet-stream' ||
                !(row.payload.body instanceof Uint8Array)
              )
                throw fail('invalid-frame');
              if (row.payload.body.length > 16 * 1024 * 1024) throw fail('read-too-large');
              return {
                requestOffset: row.requestOffset,
                nextOffset: row.nextOffset,
                upToDate: row.upToDate,
                body: new Uint8Array(row.payload.body),
              };
            } finally {
              finish();
              pending.delete(controller);
            }
          },
          catch: (error) =>
            error instanceof LedgerFeedError
              ? error
              : new LedgerFeedError({ code: 'transport', cause: error }),
        }),
      (controller) =>
        Effect.gen(function* () {
          controller.abort();
          const settled = pending.get(controller);
          if (settled) yield* Effect.promise(() => settled);
        })
    );
  return Object.freeze({
    readAfter: (offset: string): Effect.Effect<LedgerReadPage, LedgerFeedError> =>
      Effect.gen(function* () {
        if (closed) return yield* fail('closed');
        if (!validLedgerOffset(offset)) return yield* fail('invalid-offset');
        const start = offset;
        let position = offset,
          tail = new Uint8Array(0),
          total = 0;
        const records: Uint8Array[] = [],
          visited = new Set([offset]);
        for (let pages = 0; pages < 4096; pages++) {
          const page = yield* fetch(position);
          if (page.body.length === 0 && page.nextOffset !== position)
            return yield* fail('invalid-offset');
          if (page.body.length > 0 && visited.has(page.nextOffset))
            return yield* fail('invalid-offset');
          visited.add(page.nextOffset);
          total += page.body.length;
          if (total > 16 * 1024 * 1024) return yield* fail('read-too-large');
          if (page.body.length > 0 && page.nextOffset === position)
            return yield* fail('invalid-offset');
          if (!page.upToDate && page.nextOffset === position) return yield* fail('invalid-offset');
          const body = new Uint8Array(tail.length + page.body.length);
          body.set(tail);
          body.set(page.body, tail.length);
          let index = 0;
          while (index + 4 <= body.length) {
            const length = new DataView(body.buffer, body.byteOffset + index, 4).getUint32(
              0,
              false
            );
            if (length === 0 || length > 8192) return yield* fail('invalid-frame');
            if (index + 4 + length > body.length) break;
            if (records.length === 4096) return yield* fail('read-too-large');
            records.push(body.slice(index + 4, index + 4 + length));
            index += 4 + length;
          }
          tail = body.slice(index);
          position = page.nextOffset;
          if (tail.length === 0)
            return {
              requestOffset: start,
              nextOffset: position,
              records,
              upToDate: page.upToDate,
            };
          if (page.upToDate) return yield* fail('incomplete-frame');
        }
        return yield* fail('read-too-large');
      }),
  });
});

/**
 * {@link LedgerFeedSource} over a ledger control stream.
 *
 * @category Loro Streams adapters
 */
export const streamsLedgerFeedSource = (stream: LedgerStreamReader) =>
  Layer.effect(
    LedgerFeedSource,
    Effect.map(makeLedgerStreamReader(stream), (reader) => LedgerFeedSource.of(reader))
  );
