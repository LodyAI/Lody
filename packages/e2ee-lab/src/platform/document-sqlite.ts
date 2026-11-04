import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Data, Effect, Result } from 'effect';
import type { RemoteCursor, RemoteCursorStore, JsonObject } from '@loro-dev/streams-crdt';

export class LabDocumentError extends Data.TaggedError('LabDocumentError')<{
  readonly code: 'closed' | 'invalid-input' | 'sqlite' | 'corrupt' | 'missing-staged-document';
}> {}
const failure = (code: LabDocumentError['code']) => new LabDocumentError({ code });
const MAX_DOCUMENT = 64 * 1024 * 1024;
const MAX_CURSOR = 64 * 1024;
const MAX_PENDING_WRITES = 256;
export interface LabSealedWrite {
  readonly plaintextDigest: string;
  readonly context: string;
  readonly aad: Uint8Array;
  readonly header: Uint8Array;
  readonly sealed: Uint8Array;
}
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
/** Synthetic Lab state only, never production database migration or key/recovery-vault storage.
 * Every document owns a separate file. SDK save atomically persists actual staged CRDT state
 * and its exact cursor, with in-transaction readback before success. No legacy JSON import. */
export function makeLabDocumentStore<TVersion extends JsonObject = JsonObject>(input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
  readonly genesis: string;
  readonly resource: string;
  readonly model: 'loro' | 'flock';
  readonly streamUrl: string;
}) {
  return Effect.gen(function* () {
    const { path, mode, genesis, resource, model, streamUrl } = input;
    if (
      !isAbsolute(path) ||
      !/^[0-9a-f]{64}$/.test(genesis) ||
      !resource ||
      resource.length > 256 ||
      (model !== 'loro' && model !== 'flock') ||
      !streamUrl ||
      streamUrl.length > 4096 ||
      (mode !== 'create' && mode !== 'open')
    )
      return yield* failure('invalid-input');
    const db = yield* openSqliteStore({
      path,
      mode,
      applicationId: 0x4c45444f,
      version: 2,
      error: (code) => failure(code === 'corrupt' ? 'corrupt' : 'sqlite'),
      initialize: (connection) => {
        connection.exec(
          'CREATE TABLE lab_document_owner(id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL,genesis TEXT NOT NULL,resource TEXT NOT NULL,model TEXT NOT NULL,url TEXT NOT NULL); CREATE TABLE lab_document_state(id INTEGER PRIMARY KEY CHECK(id=1),document BLOB NOT NULL,cursor TEXT); CREATE TABLE lab_document_writes(digest TEXT NOT NULL,context TEXT NOT NULL,aad BLOB NOT NULL,header BLOB NOT NULL,sealed BLOB NOT NULL,PRIMARY KEY(digest,context,aad)) STRICT;'
        );
        connection
          .prepare('INSERT INTO lab_document_owner VALUES(1,2,?,?,?,?)')
          .run(genesis, resource, model, streamUrl);
      },
      validate: (connection) => {
        const row = connection
          .prepare('SELECT format,genesis,resource,model,url FROM lab_document_owner WHERE id=1')
          .get() as Record<string, unknown> | undefined;
        if (
          !row ||
          row.format !== 2 ||
          row.genesis !== genesis ||
          row.resource !== resource ||
          row.model !== model ||
          row.url !== streamUrl
        )
          throw failure('corrupt');
      },
    });
    let closed = false;
    let staged: Uint8Array | undefined;
    const protect = <A>(work: () => A) =>
      Result.try({
        try: () => {
          if (closed) throw failure('closed');
          return work();
        },
        catch: (cause) => (cause instanceof LabDocumentError ? cause : failure('sqlite')),
      });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        staged?.fill(0);
        staged = undefined;
      })
    );
    const state = () => {
      const row = db
        .prepare(
          `SELECT CASE WHEN length(document) BETWEEN 1 AND ${MAX_DOCUMENT} THEN document ELSE NULL END AS document, CASE WHEN cursor IS NULL OR length(cursor)<=${MAX_CURSOR} THEN cursor ELSE 'invalid' END AS cursor FROM lab_document_state WHERE id=1`
        )
        .get() as { document: unknown; cursor: unknown } | undefined;
      if (!row) return undefined;
      if (
        !(row.document instanceof Uint8Array) ||
        (row.cursor !== null && typeof row.cursor !== 'string')
      )
        throw failure('corrupt');
      return { document: new Uint8Array(row.document), cursor: row.cursor as string | null };
    };
    const cursor = (text: string): RemoteCursor<TVersion> => {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object') throw failure('corrupt');
      const c = value as RemoteCursor<TVersion>;
      if (
        c.streamUrl !== streamUrl ||
        typeof c.nextOffset !== 'string' ||
        !c.nextOffset ||
        c.nextOffset.length > 1024 ||
        c.nextOffset === 'now' ||
        !Number.isSafeInteger(c.updatedAtMs) ||
        c.updatedAtMs < 0 ||
        !c.serverLowerBoundVersion ||
        typeof c.serverLowerBoundVersion !== 'object' ||
        Array.isArray(c.serverLowerBoundVersion)
      )
        throw failure('corrupt');
      return c;
    };
    const write = (document: Uint8Array, value: string | null) =>
      db.transaction(() => {
        db.prepare(
          'INSERT INTO lab_document_state(id,document,cursor) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,cursor=excluded.cursor'
        ).run(document, value);
        const after = state();
        if (!after || !same(after.document, document) || after.cursor !== value)
          throw failure('corrupt');
      })();
    const own = (bytes: Uint8Array) => {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_DOCUMENT)
        throw failure('invalid-input');
      return new Uint8Array(bytes);
    };
    const cursorText = () => {
      const row = db.prepare('SELECT cursor FROM lab_document_state WHERE id=1').get() as
        | { cursor: unknown }
        | undefined;
      if (!row || row.cursor === null) return null;
      if (typeof row.cursor !== 'string' || row.cursor.length > MAX_CURSOR)
        throw failure('corrupt');
      return row.cursor;
    };
    const ownSealedWrite = (
      value: LabSealedWrite,
      code: 'invalid-input' | 'corrupt'
    ): LabSealedWrite => {
      if (
        !value ||
        !/^[0-9a-f]{64}$/.test(value.plaintextDigest) ||
        typeof value.context !== 'string' ||
        !value.context.length ||
        value.context.length > 8192 ||
        !(value.aad instanceof Uint8Array) ||
        value.aad.length > MAX_CURSOR ||
        !(value.header instanceof Uint8Array) ||
        !value.header.length ||
        value.header.length > 512 ||
        !(value.sealed instanceof Uint8Array) ||
        !value.sealed.length ||
        value.sealed.length > MAX_DOCUMENT
      )
        throw failure(code);
      return Object.freeze({
        plaintextDigest: value.plaintextDigest,
        context: value.context,
        aad: new Uint8Array(value.aad),
        header: new Uint8Array(value.header),
        sealed: new Uint8Array(value.sealed),
      });
    };
    const sealedWrites = Object.freeze({
      load: (): Result.Result<readonly LabSealedWrite[], LabDocumentError> =>
        protect(() => {
          const rows = db
            .prepare(
              'SELECT digest AS plaintextDigest,context,aad,header,sealed FROM lab_document_writes ORDER BY rowid LIMIT ?'
            )
            .all(MAX_PENDING_WRITES + 1) as LabSealedWrite[];
          if (rows.length > MAX_PENDING_WRITES) throw failure('corrupt');
          return Object.freeze(rows.map((row) => ownSealedWrite(row, 'corrupt')));
        }),
      save: (source: LabSealedWrite): Result.Result<void, LabDocumentError> =>
        protect(() => {
          const row = ownSealedWrite(source, 'invalid-input');
          db.transaction(() => {
            const existing = db
              .prepare('SELECT 1 FROM lab_document_writes WHERE digest=? AND context=? AND aad=?')
              .get(row.plaintextDigest, row.context, row.aad);
            if (!existing) {
              const used = db
                .prepare(
                  'SELECT count(*) AS n,coalesce(sum(length(aad)+length(header)+length(sealed)),0) AS bytes FROM lab_document_writes'
                )
                .get() as { n: number; bytes: number };
              if (
                used.n >= MAX_PENDING_WRITES ||
                used.bytes + row.aad.length + row.header.length + row.sealed.length > MAX_DOCUMENT
              )
                throw failure('invalid-input');
            }
            db.prepare(
              'INSERT INTO lab_document_writes(digest,context,aad,header,sealed) VALUES(?,?,?,?,?) ON CONFLICT(digest,context,aad) DO NOTHING'
            ).run(row.plaintextDigest, row.context, row.aad, row.header, row.sealed);
            const retained = db
              .prepare(
                'SELECT header,sealed FROM lab_document_writes WHERE digest=? AND context=? AND aad=?'
              )
              .get(row.plaintextDigest, row.context, row.aad) as
              | { header: Uint8Array; sealed: Uint8Array }
              | undefined;
            if (
              !retained ||
              !same(retained.header, row.header) ||
              !same(retained.sealed, row.sealed)
            )
              throw failure('corrupt');
          }).immediate();
        }),
      clear: (): Result.Result<void, LabDocumentError> =>
        protect(() => {
          db.transaction(() => {
            db.prepare('DELETE FROM lab_document_writes').run();
          }).immediate();
        }),
    });
    const cursorStore = Object.freeze({
      async load(url) {
        return Result.getOrThrow(
          protect(() => {
            if (url !== streamUrl) throw failure('invalid-input');
            const text = cursorText();
            return text ? cursor(text) : null;
          })
        );
      },
      async save(value) {
        Result.getOrThrow(
          protect(() => {
            if (!staged) throw failure('missing-staged-document');
            const text = JSON.stringify(value);
            if (text.length > MAX_CURSOR) throw failure('invalid-input');
            cursor(text);
            write(staged, text);
            staged.fill(0);
            staged = undefined;
          })
        );
      },
    } satisfies RemoteCursorStore<TVersion>);
    return Object.freeze({
      cursorStore,
      sealedWrites,
      discardStaged: () =>
        Effect.sync(() => {
          staged?.fill(0);
          staged = undefined;
        }),
      restore: () =>
        Effect.suspend(() => Effect.fromResult(protect(() => state()?.document ?? null))),
      persistLocal: (bytes: Uint8Array) =>
        Effect.suspend(() =>
          Effect.fromResult(
            protect(() => {
              const owned = own(bytes);
              try {
                write(owned, cursorText());
              } finally {
                owned.fill(0);
              }
            })
          )
        ),
      /** SDK pre-save callback boundary; owned actual snapshot, not an injected persistence assertion. */
      stage: (bytes: Uint8Array) =>
        protect(() => {
          const next = own(bytes);
          staged?.fill(0);
          staged = next;
        }),
      inspectCursor: () =>
        Effect.suspend(() =>
          Effect.fromResult(
            protect(() => {
              const text = cursorText();
              return text ? cursor(text) : null;
            })
          )
        ),
    });
  });
}
