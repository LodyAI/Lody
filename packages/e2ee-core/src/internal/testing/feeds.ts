/** UNSTABLE test and Lab helpers: a `LedgerFeed` over one SQLite file, with the per-file options fault harnesses use. */
import { Context, Effect, Layer } from 'effect';
import { LedgerFeed, type SnapshotFeedOrigin } from '../../index';
import { sqliteLedgerFeedStore } from '../../adapters/node-sqlite';
import { WorkspaceScope, type GenesisHash, type LedgerCheckpoint } from '../../services';

interface FeedFile {
  readonly path: string;
  readonly mode: 'create' | 'open';
  readonly genesis: GenesisHash;
  readonly expected: LedgerCheckpoint;
  readonly budget: { readonly maxRecords: number; readonly maxBytes: number };
}
const open = (input: FeedFile, origin: Parameters<typeof LedgerFeed.layer>[0]['origin']) =>
  Effect.map(
    Layer.build(
      LedgerFeed.layer({ origin, expected: input.expected, budget: input.budget }).pipe(
        Layer.provide(sqliteLedgerFeedStore({ path: input.path, mode: input.mode })),
        Layer.provide(Layer.succeed(WorkspaceScope, { genesis: input.genesis }))
      )
    ),
    (context) => Context.get(context, LedgerFeed)
  );

/** A genesis-origin `LedgerFeed` over one SQLite file, owned by the caller's Scope. */
export const makeSqliteLedgerFeed = (input: FeedFile & { readonly genesisRecord: Uint8Array }) =>
  open(input, { kind: 'genesis', record: input.genesisRecord });

/** A snapshot-origin `LedgerFeed` over one SQLite file, owned by the caller's Scope. */
export type SqliteSnapshotLedgerFeedInput = FeedFile & { readonly snapshot: SnapshotFeedOrigin };
export const makeSqliteSnapshotLedgerFeed = (input: SqliteSnapshotLedgerFeedInput) =>
  open(input, { kind: 'snapshot', snapshot: input.snapshot });
