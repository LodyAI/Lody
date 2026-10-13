import Database from 'better-sqlite3';
import { Effect, Layer, Schema } from 'effect';
import { recordHash, type GenesisHash } from '../bytes';
import { bytesEqual } from '../cbor';
import { keyId } from '../identifiers';
import {
  SubmissionError,
  SubmissionJournal,
  type JournalEntry,
  type Outcome,
  type SubmissionResult,
} from './index';
import type { LedgerCheckpoint } from '../ledger';

const APPLICATION_ID = 0x4c455031;
const Row = Schema.Struct({
  pending: Schema.NullOr(Schema.Uint8Array),
  result_record: Schema.NullOr(Schema.Uint8Array),
  outcome: Schema.NullOr(Schema.Literals(['Committed', 'Conflict'])),
  head: Schema.NullOr(Schema.Uint8Array),
  length: Schema.Int,
});
const corrupt = () => new SubmissionError({ code: 'corrupt-journal' });
const busy = () => new SubmissionError({ code: 'busy' });
const sqlEffect = <A>(body: () => A) =>
  Effect.try({
    try: body,
    catch: (error) =>
      error instanceof SubmissionError ? error : new SubmissionError({ code: 'storage' }),
  });
const sameCheckpoint = (a: LedgerCheckpoint | null, b: LedgerCheckpoint | null) =>
  a === null ? b === null : b !== null && a.length === b.length && a.head.equals(b.head);

/** Separate local database, owned by the consuming application Scope.
 * No arbitrary-state import or production composition is provided. */
export const sqliteSubmissionJournal = (path: string) =>
  Layer.effect(
    SubmissionJournal,
    Effect.gen(function* () {
      if (path === ':memory:' || path.length === 0)
        return yield* new SubmissionError({ code: 'storage' });
      const db = yield* Effect.acquireRelease(
        sqlEffect(() => new Database(path, { timeout: 1000 })),
        (handle) => sqlEffect(() => handle.close()).pipe(Effect.orDie)
      );
      yield* sqlEffect(() => {
        const appId = db.pragma('application_id', { simple: true });
        const version = db.pragma('user_version', { simple: true });
        if (
          appId !== APPLICATION_ID &&
          (appId !== 0 ||
            version !== 0 ||
            db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length > 0)
        )
          throw corrupt();
        if (appId === APPLICATION_ID && version !== 1) throw corrupt();
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        if (appId === 0)
          db.transaction(() => {
            db.exec(`CREATE TABLE submission_journal (
        anchor TEXT PRIMARY KEY,
        pending BLOB,
        result_record BLOB,
        outcome TEXT CHECK(outcome IN ('Committed','Conflict')),
        head BLOB,
        length INTEGER NOT NULL DEFAULT 0 CHECK(length >= 0),
        CHECK((pending IS NULL OR length(pending) BETWEEN 1 AND 8192)
          AND (result_record IS NULL OR length(result_record) BETWEEN 1 AND 8192)),
        CHECK((head IS NULL AND length = 0) OR (length(head) = 32 AND length > 0)),
        CHECK((result_record IS NULL AND outcome IS NULL)
          OR (pending IS NULL AND result_record IS NOT NULL AND outcome IS NOT NULL))
      ); PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;`);
          }).immediate();
      });
      const load = (anchor: GenesisHash): JournalEntry => {
        const raw = db
          .prepare(
            'SELECT pending, result_record, outcome, head, length FROM submission_journal WHERE anchor = ?'
          )
          .get(keyId(anchor.toBytes()));
        if (!raw) return { record: null, outcome: null, checkpoint: null };
        let row: typeof Row.Type;
        try {
          row = Schema.decodeUnknownSync(Row)(raw);
        } catch {
          throw corrupt();
        }
        if (
          !Number.isSafeInteger(row.length) ||
          row.length < 0 ||
          (row.pending && row.result_record) ||
          (row.result_record === null) !== (row.outcome === null) ||
          (row.head === null) !== (row.length === 0)
        )
          throw corrupt();
        const record = row.pending ?? row.result_record;
        if (record && (record.length < 1 || record.length > 8192)) throw corrupt();
        const head = row.head && recordHash(row.head);
        if (head && head._tag === 'Failure') throw corrupt();
        return {
          record: record && new Uint8Array(record),
          outcome: row.outcome,
          checkpoint:
            head && head._tag === 'Success' ? { head: head.success, length: row.length } : null,
        };
      };
      const transition = (
        anchor: GenesisHash,
        record: Uint8Array,
        before: LedgerCheckpoint | null,
        after: LedgerCheckpoint,
        outcome: Outcome | null
      ) =>
        db
          .transaction(() => {
            const current = load(anchor);
            if (
              !current.record ||
              !bytesEqual(current.record, record) ||
              !sameCheckpoint(current.checkpoint, before)
            )
              throw busy();
            if (current.outcome && current.outcome !== outcome) throw busy();
            if (
              after.length < (before?.length ?? 0) ||
              (before && after.length === before.length && !after.head.equals(before.head))
            )
              throw new SubmissionError({ code: 'rollback' });
            db.prepare(
              'UPDATE submission_journal SET pending = ?, result_record = ?, outcome = ?, head = ?, length = ? WHERE anchor = ?'
            ).run(
              outcome ? null : record,
              outcome ? record : null,
              outcome,
              after.head.toBytes(),
              after.length,
              keyId(anchor.toBytes())
            );
          })
          .immediate();
      return SubmissionJournal.of({
        load: (anchor) => sqlEffect(() => load(anchor)),
        prepare: (anchor, input) =>
          sqlEffect(() =>
            db
              .transaction(() => {
                if (!(input instanceof Uint8Array) || input.length < 1 || input.length > 8192)
                  throw corrupt();
                const record = new Uint8Array(input);
                const current = load(anchor);
                if (current.record) {
                  if (!bytesEqual(current.record, record)) throw busy();
                  return;
                }
                db.prepare(
                  'INSERT INTO submission_journal(anchor, pending) VALUES(?, ?) ON CONFLICT(anchor) DO UPDATE SET pending = excluded.pending'
                ).run(keyId(anchor.toBytes()), record);
              })
              .immediate()
          ),
        observe: (anchor, record, before, after) =>
          sqlEffect(() => transition(anchor, record, before, after, null)),
        finish: (anchor, record, outcome, before, after) =>
          sqlEffect(() => transition(anchor, record, before, after, outcome)),
        acknowledge: (anchor, result: SubmissionResult) =>
          sqlEffect(() =>
            db
              .transaction(() => {
                const current = load(anchor);
                if (
                  !current.record ||
                  !current.outcome ||
                  current.outcome !== result.outcome ||
                  !bytesEqual(current.record, result.record)
                )
                  throw busy();
                db.prepare(
                  'UPDATE submission_journal SET result_record = NULL, outcome = NULL WHERE anchor = ?'
                ).run(keyId(anchor.toBytes()));
              })
              .immediate()
          ),
      });
    })
  );
