import { openSqliteConnection } from '@lody/e2ee-core/internal';
import { Effect } from 'effect';
import type { LabActionObservation } from './action-executor';
import type { JudgeVerdict } from '../pure/judge';
/** Harness observations of native record positions. Request offsets are opaque:
 * compare them to backend-emitted tokens, then compare actual stored positions.
 * This is a scoped Lab measurement, never client authority or cursor repair. */
export const measureLabCursors = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly genesis: string;
  readonly observations: readonly LabActionObservation[];
}) {
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => openSqliteConnection(input.path, { readonly: true, fileMustExist: true }),
      catch: (cause) => cause,
    }),
    (db) =>
      Effect.sync((): JudgeVerdict => {
        const previous = new Map<string, number>();
        let measured = 0;
        for (const observation of input.observations) {
          const action = observation.action;
          if (action.kind !== 'call' || action.operation !== 'observe' || !observation.reply.ok)
            continue;
          const value = observation.reply.value as
            | { cursor?: { streamUrl?: unknown; nextOffset?: unknown } | null }
            | undefined;
          if (value?.cursor === null) continue;
          const cursor = value?.cursor;
          if (
            !cursor ||
            typeof cursor.streamUrl !== 'string' ||
            typeof cursor.nextOffset !== 'string' ||
            !action.document
          )
            return 'harness-error';
          const url = new URL(cursor.streamUrl);
          if (url.pathname !== `/ds/${input.genesis}/${action.document}`) return 'violation';
          const stream = db
            .prepare('SELECT id,next_offset FROM streams WHERE bucket_id=? AND stream_id=?')
            .get(input.genesis, action.document) as { id: number; next_offset: number } | undefined;
          if (!stream) return 'harness-error';
          const row =
            cursor.nextOffset === '-1'
              ? { position: 0 }
              : (db
                  .prepare(`
          SELECT 0 AS position WHERE printf('%020d',0)=?
          UNION SELECT start_offset AS position FROM entries WHERE stream_id_fk=? AND printf('%020d',start_offset)=?
          UNION SELECT end_offset AS position FROM entries WHERE stream_id_fk=? AND printf('%020d',end_offset)=? LIMIT 1
        `)
                  .get(
                    cursor.nextOffset,
                    stream.id,
                    cursor.nextOffset,
                    stream.id,
                    cursor.nextOffset
                  ) as { position: number } | undefined);
          if (!row || row.position > stream.next_offset) return 'violation';
          const key = `${action.actor}/${action.document}`;
          if (row.position < (previous.get(key) ?? 0)) return 'violation';
          previous.set(key, row.position);
          measured++;
        }
        return measured ? 'pass' : 'unavailable';
      }),
    (db) => Effect.sync(() => db.close())
  );
});
