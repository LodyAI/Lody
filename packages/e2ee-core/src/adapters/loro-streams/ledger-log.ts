import { Effect, Layer } from 'effect';
import * as Bytes from '../../internal/foundation/bytes';
import {
  decodeRecord,
  extendLedger,
  hashRecordBytes,
  requireLedgerContinuation,
  verifyLedgerEffect,
  type LedgerCheckpoint,
  type LedgerView,
} from '../../internal/ledger';
import { makeLedgerStreamReader, type LedgerStreamReader } from './ledger-feed-source';
import { frameLedgerRecord, validLedgerOffset } from '../../internal/ledger/feed-page';
import { LedgerLogError } from '../../services/errors';
import { LedgerLog } from '../../services/ledger';
import { WorkspaceScope } from '../../services/workspace';

/** Structural released streams-client 0.9 CAS shape. It has no per-call AbortSignal. */
export interface LedgerSubmissionStream extends LedgerStreamReader {
  readonly appendCas: (input: {
    readonly expectedOffset: string;
    readonly part: { readonly contentType: string; readonly body: Uint8Array };
  }) => Promise<
    | {
        readonly ok: true;
        readonly result:
          | { readonly kind: 'ok'; readonly value: { readonly nextOffset: string } }
          | {
              readonly kind: 'mismatch';
              readonly expectedOffset: string;
              readonly currentOffset: string;
            };
      }
    | { readonly ok: false; readonly result: unknown }
  >;
}
const fail = () => new LedgerLogError();
/** Options of {@link makeStreamsLedgerLog} and {@link streamsLedgerLog}. */
export interface StreamsLedgerLogOptions {
  /** The workspace's ledger control stream (released streams-client 0.9 shape). */
  readonly stream: LedgerSubmissionStream;
  /** The checkpoint the log is expected to reach, chosen independently of the stream (for
   * example from the application's verified feed). A stream that ends elsewhere fails. */
  readonly checkpoint: () => Effect.Effect<LedgerCheckpoint, unknown>;
  /** Upper bounds on a full read. */
  readonly budget: { readonly maxRecords: number; readonly maxBytes: number };
}

/**
 * {@link LedgerLog} over a Loro/Durable Streams control stream. Reads are full
 * audits from genesis; `appendCas` uses the stream's offset CAS at the exact
 * offset of the last verified read and never appends unconditionally. The
 * caller owns the SDK's URL, auth and timeouts. `read` additionally returns the
 * verified `view` for concrete consumers that want to reuse it.
 *
 * @category Loro Streams adapters
 */
export function makeStreamsLedgerLog(
  input: StreamsLedgerLogOptions & { readonly genesis: Bytes.GenesisHash }
) {
  return Effect.gen(function* () {
    const anchor = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
    const checkpoint = input.checkpoint,
      append = input.stream.appendCas.bind(input.stream),
      budget = { ...input.budget };
    if (
      !Number.isSafeInteger(budget.maxRecords) ||
      budget.maxRecords < 1 ||
      budget.maxRecords > 1_000_000 ||
      !Number.isSafeInteger(budget.maxBytes) ||
      budget.maxBytes < 1 ||
      budget.maxBytes > 64 * 1024 * 1024
    )
      return yield* fail();
    const reader = yield* makeLedgerStreamReader(input.stream);
    let closed = false,
      mapping: { readonly view: LedgerView; readonly offset: string } | undefined;
    const pending = new Set<Promise<void>>();
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        yield* Effect.promise(() => Promise.all([...pending]).then(() => undefined));
        mapping = undefined;
      })
    );
    const guard = () => (closed ? Effect.fail(fail()) : Effect.void);
    const boundAnchor = (requested: Bytes.GenesisHash) =>
      Effect.gen(function* () {
        yield* guard();
        const copy = yield* Effect.fromResult(Bytes.genesisHash(requested.toBytes()));
        if (!anchor.equals(copy)) return yield* fail();
        return undefined;
      });
    // Concrete consumers may reuse this genuine view from the same full audit.
    // Generic LedgerLog readers still receive untrusted records/checkpoint.
    const read = (requested: Bytes.GenesisHash) =>
      Effect.gen(function* () {
        yield* boundAnchor(requested);
        const selected = yield* checkpoint();
        const expected = {
          head: yield* Effect.fromResult(Bytes.recordHash(selected.head.toBytes())),
          length: selected.length,
        };
        if (
          !Number.isSafeInteger(expected.length) ||
          expected.length < 1 ||
          expected.length > budget.maxRecords
        )
          return yield* fail();
        let offset = '-1',
          bytes = 0;
        const visited = new Set([offset]),
          records: Uint8Array[] = [];
        for (let pages = 0; pages < 4096; pages++) {
          yield* guard();
          const page = yield* reader.readAfter(offset);
          yield* guard();
          for (const row of page.records) {
            bytes += row.length;
            if (records.length >= budget.maxRecords || bytes > budget.maxBytes)
              return yield* fail();
            records.push(new Uint8Array(row));
          }
          if (
            (page.records.length === 0 && page.nextOffset !== offset) ||
            (page.records.length > 0 && visited.has(page.nextOffset)) ||
            (!page.upToDate && page.records.length === 0)
          )
            return yield* fail();
          offset = page.nextOffset;
          if (page.upToDate) {
            const view = yield* verifyLedgerEffect({ anchor, records, checkpoint: expected });
            if (mapping) yield* Effect.fromResult(requireLedgerContinuation(mapping.view, view));
            yield* guard();
            mapping = { view, offset };
            return { records, checkpoint: expected, view };
          }
          visited.add(offset);
        }
        return yield* fail();
      }).pipe(Effect.mapError(fail));
    const appendCas = (
      requested: Bytes.GenesisHash,
      expected: LedgerCheckpoint,
      source: Uint8Array
    ) =>
      Effect.gen(function* () {
        yield* boundAnchor(requested);
        const selected = mapping;
        if (
          !selected ||
          !selected.view.head.equals(expected.head) ||
          selected.view.length !== expected.length
        )
          return yield* fail();
        const record = yield* Effect.fromResult(decodeRecord(source));
        if (record.body.type !== 'ordinary') return yield* fail();
        yield* Effect.fromResult(
          extendLedger(selected.view, [record.recordBytes], {
            head: hashRecordBytes(record.recordBytes),
            length: expected.length + 1,
          })
        );
        const body = yield* Effect.fromResult(frameLedgerRecord(record.recordBytes));
        yield* guard();
        // SDK0.9 CAS cannot be aborted per call. Interruption and Scope close await
        // this exact raw request; neither a timeout nor a local close proves it stopped.
        yield* Effect.uninterruptible(
          Effect.tryPromise({
            try: async () => {
              if (closed) throw fail();
              let finish!: () => void;
              const settled = new Promise<void>((resolve) => {
                finish = resolve;
              });
              pending.add(settled);
              try {
                const response = await append({
                  expectedOffset: selected.offset,
                  part: { contentType: 'application/octet-stream', body },
                });
                if (closed || !response.ok) throw fail();
                const result = response.result;
                if (result.kind === 'mismatch') {
                  if (
                    result.expectedOffset !== selected.offset ||
                    !validLedgerOffset(result.currentOffset)
                  )
                    throw fail();
                  throw fail();
                }
                if (result.kind !== 'ok' || !validLedgerOffset(result.value.nextOffset))
                  throw fail();
                // P09 independently reads back and determines Committed/Conflict.
              } finally {
                finish();
                pending.delete(settled);
              }
            },
            catch: fail,
          })
        );
        return undefined;
      }).pipe(Effect.mapError(fail));
    return Object.freeze({ read, appendCas }) satisfies LedgerLog['Service'];
  }).pipe(Effect.mapError(fail));
}

/**
 * {@link makeStreamsLedgerLog} as a Layer bound to {@link WorkspaceScope}.
 *
 * @category Loro Streams adapters
 */
export const streamsLedgerLog = (options: StreamsLedgerLogOptions) =>
  Layer.effect(
    LedgerLog,
    Effect.gen(function* () {
      const { genesis } = yield* WorkspaceScope;
      return LedgerLog.of(yield* makeStreamsLedgerLog({ ...options, genesis }));
    })
  );
