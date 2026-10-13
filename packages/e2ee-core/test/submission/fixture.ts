import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import Database from 'better-sqlite3';
import { Effect, Result } from 'effect';
import * as Bytes from '../../src/bytes';
import { encodeCbor, bytesEqual, type CborValue } from '../../src/cbor';
import { hashRecordBytes, verifyLedger, type LedgerCheckpoint } from '../../src/ledger';
import { SubmissionRemote, SubmissionRemoteError } from '../../src/submission';
const ok = Result.getOrThrow;
export const filled = (n: number, length = 32) => new Uint8Array(length).fill(n);
export function keys(n: number) {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), filled(n)]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    pk: new Uint8Array(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)),
    sign: (message: Uint8Array) => new Uint8Array(sign(null, message, key)),
  };
}
export const owner = keys(1);
export function signed(body: readonly CborValue[], signer = owner) {
  const bytes = ok(encodeCbor(body));
  return ok(
    encodeCbor([body, signer.sign(Buffer.concat([Buffer.from('lody-e2ee/sig/v1\0'), bytes]))])
  );
}
export const genesis = signed([1, owner.pk, filled(10), filled(10, 16), filled(101), filled(20)]);
export const anchor = ok(Bytes.genesisHash(hashRecordBytes(genesis).toBytes()));
export const rotate = (parent = hashRecordBytes(genesis), n = 21) =>
  signed([parent.toBytes(), owner.pk, [7, 1, filled(n), filled(30, 72)]]);
export const checkpoint = (records: readonly Uint8Array[]): LedgerCheckpoint => ({
  head: hashRecordBytes(records[records.length - 1]!),
  length: records.length,
});

/** Synthetic local host only. Owns real SQLite CAS/history; no network or JWT. */
export function host(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(
    'CREATE TABLE IF NOT EXISTS records (position INTEGER PRIMARY KEY, record BLOB NOT NULL)'
  );
  if (
    db.prepare('SELECT COUNT(*) AS n FROM records').get() &&
    (db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n === 0
  )
    db.prepare('INSERT INTO records VALUES(0, ?)').run(genesis);
  const read = () =>
    (
      db.prepare('SELECT record FROM records ORDER BY position').all() as { record: Uint8Array }[]
    ).map((r) => new Uint8Array(r.record));
  const append = db.transaction((expected: LedgerCheckpoint, record: Uint8Array) => {
    const records = read();
    // Exact-body idempotency is independent of the submitted CAS position.
    if (records.some((r) => bytesEqual(r, record))) return;
    if (records.length !== expected.length || !checkpoint(records).head.equals(expected.head))
      return;
    const next = [...records, record];
    ok(verifyLedger({ anchor, records: next, checkpoint: checkpoint(next) }));
    db.prepare('INSERT INTO records VALUES(?, ?)').run(records.length, record);
  });
  return {
    db,
    read,
    append: (record: Uint8Array) => append.immediate(checkpoint(read()), record),
    service: SubmissionRemote.of({
      read: () =>
        Effect.sync(() => {
          const records = read();
          return { records, checkpoint: checkpoint(records) };
        }),
      appendCas: (_anchor, expected, record) =>
        Effect.try({
          try: () => append.immediate(expected, record),
          catch: () => new SubmissionRemoteError(),
        }),
    }),
  };
}
