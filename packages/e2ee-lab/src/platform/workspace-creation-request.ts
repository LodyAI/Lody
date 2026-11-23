import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Effect, Result, Schema, Semaphore } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { decodeRecord, hashRecordBytes, verifyLedgerEffect } from '@lody/e2ee-core/protocol';
import { validLedgerOffset } from '@lody/e2ee-core/protocol';
import { makeLabOperations } from './operation-scope';
import { LabWorkspaceCreationError, type LabWorkspaceCreationReceipt } from './workspace-creation';
const APP = 0x4c455752;
const fail = (code: LabWorkspaceCreationError['code']) => new LabWorkspaceCreationError({ code });
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const Receipt = Schema.Struct({
  genesisHex: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  headHex: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(4096)),
  offset: Schema.String,
});
/** Local durable original before remote create. Reopening borrows a fresh
 * authenticated client; it never signs a replacement genesis or selects trust
 * from a server receipt. Explicit ACK retains both original and outcome history.
 * The borrowed send capability must abort/await native work before its own close.
 */
export const makeLabWorkspaceCreationRequest = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
  readonly genesisRecord: Uint8Array;
  readonly send: (original: Uint8Array) => Effect.Effect<LabWorkspaceCreationReceipt, unknown>;
}) {
  const { path, mode } = input;
  const send = input.send;
  if (
    !isAbsolute(path) ||
    (mode !== 'create' && mode !== 'open') ||
    !(input.genesisRecord instanceof Uint8Array) ||
    !input.genesisRecord.length ||
    input.genesisRecord.length > 8192
  )
    return yield* fail('invalid-input');
  const original = new Uint8Array(input.genesisRecord);
  const parsed = yield* Effect.fromResult(decodeRecord(original));
  if (parsed.body.type !== 'genesis') return yield* fail('invalid-input');
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(hashRecordBytes(original).toBytes()));
  yield* verifyLedgerEffect({
    anchor: genesis,
    records: [original],
    checkpoint: { head: hashRecordBytes(original), length: 1 },
  });
  const genesisHex = Buffer.from(genesis.toBytes()).toString('hex');
  const sql = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (error) => (error instanceof LabWorkspaceCreationError ? error : fail('storage')),
    });
  const db = yield* openSqliteStore({
    path,
    mode,
    applicationId: APP,
    version: 1,
    error: fail,
    initialize: (connection) => {
      connection
        .transaction(() => {
          connection.exec(
            `CREATE TABLE creation_request(id INTEGER PRIMARY KEY CHECK(id=1),original BLOB NOT NULL,receipt TEXT,consumed INTEGER NOT NULL CHECK(consumed IN (0,1))) STRICT;`
          );
          if (
            connection.prepare('INSERT INTO creation_request VALUES(1,?,NULL,0)').run(original)
              .changes !== 1
          )
            throw fail('storage');
        })
        .immediate();
    },
  });
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    })
  );
  const operations = yield* makeLabOperations();
  const guard = () => {
    if (closed || operations.signal.aborted) throw fail('closed');
  };
  const validateReceipt = (value: unknown) => {
    const receipt = Result.getOrThrow(Schema.decodeUnknownResult(Receipt)(value));
    if (
      receipt.genesisHex !== genesisHex ||
      !validLedgerOffset(receipt.offset) ||
      receipt.offset === '-1'
    )
      throw fail('invalid-input');
    return Object.freeze(receipt);
  };

  const read = () => {
    guard();
    const row = db
      .prepare(
        'SELECT CASE WHEN length(original) BETWEEN 1 AND 8192 THEN original ELSE NULL END AS original,CASE WHEN receipt IS NULL OR length(receipt)<=2048 THEN receipt ELSE 0 END AS receipt,consumed FROM creation_request WHERE id=1'
      )
      .get() as { original: unknown; receipt: unknown; consumed: unknown } | undefined;
    if (
      !row ||
      !(row.original instanceof Uint8Array) ||
      !same(row.original, original) ||
      (row.consumed !== 0 && row.consumed !== 1) ||
      (row.receipt !== null && typeof row.receipt !== 'string') ||
      (row.receipt === null && row.consumed === 1)
    )
      throw fail('corrupt');
    try {
      return {
        original: new Uint8Array(row.original),
        receipt: row.receipt === null ? undefined : validateReceipt(JSON.parse(row.receipt)),
        consumed: row.consumed === 1,
      };
    } catch {
      throw fail('corrupt');
    }
  };
  yield* sql(read);
  const serial = yield* Semaphore.make(1);
  return Object.freeze({
    genesis,
    result: () =>
      sql(() => {
        const row = read();
        return row.receipt ? row : undefined;
      }),
    resume: () =>
      operations.run(
        serial.withPermit(
          Effect.gen(function* () {
            const before = yield* sql(read);
            if (before.receipt) return before;
            // Give the transport a copy; neither retained original nor later retry aliases it.
            const receipt = yield* send(new Uint8Array(original)).pipe(
              Effect.mapError(() => fail('transport'))
            );
            const captured = yield* sql(() => validateReceipt(receipt));
            const text = JSON.stringify(captured);
            return yield* sql(() =>
              db
                .transaction(() => {
                  const prior = read();
                  if (prior.receipt || prior.consumed) throw fail('corrupt');
                  if (
                    db.prepare('UPDATE creation_request SET receipt=? WHERE id=1').run(text)
                      .changes !== 1
                  )
                    throw fail('storage');
                  const final = read();
                  if (!final.receipt || JSON.stringify(final.receipt) !== text || final.consumed)
                    throw fail('storage');
                  return final;
                })
                .immediate()
            );
          })
        )
      ),
    acknowledge: (result: {
      readonly original: Uint8Array;
      readonly receipt: LabWorkspaceCreationReceipt | undefined;
    }) =>
      serial.withPermit(
        sql(() => {
          const expectedOriginal = new Uint8Array(result.original);
          const expected = result.receipt ? validateReceipt(result.receipt) : undefined;
          if (!same(expectedOriginal, original) || !expected) throw fail('invalid-input');
          return db
            .transaction(() => {
              const prior = read();
              if (!prior.receipt || JSON.stringify(prior.receipt) !== JSON.stringify(expected))
                throw fail('invalid-input');
              if (
                !prior.consumed &&
                db.prepare('UPDATE creation_request SET consumed=1 WHERE id=1').run().changes !== 1
              )
                throw fail('storage');
              const final = read();
              if (
                !final.consumed ||
                !final.receipt ||
                JSON.stringify(final.receipt) !== JSON.stringify(expected)
              )
                throw fail('storage');
              return final;
            })
            .immediate();
        })
      ),
  });
});
