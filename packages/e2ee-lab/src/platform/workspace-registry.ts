import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Data, Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { decodeRecord, hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import type { LabCredential } from './credentials';

const APP = 0x4c455731;
export class LabWorkspaceError extends Data.TaggedError('LabWorkspaceError')<{
  readonly code: 'invalid-input' | 'unauthorized' | 'storage' | 'corrupt' | 'closed';
}> {}
const fail = (code: LabWorkspaceError['code']) => new LabWorkspaceError({ code });
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
/** Synthetic host genesis registration only. A saved genesis is NOT a current
 * trusted endpoint, stream publication or key custody proof. Every read replays
 * the original public codec/signature. No copied verifier or mutable ledger view.
 * Host passes a credential returned by its actual bearer authentication owner. */
export function makeLabWorkspaceRegistry(input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
}) {
  return Effect.gen(function* () {
    const { path, mode } = input;
    const sql = <A>(work: () => A) =>
      Effect.try({
        try: work,
        catch: (error) => (error instanceof LabWorkspaceError ? error : fail('storage')),
      });
    if (!isAbsolute(path) || (mode !== 'create' && mode !== 'open'))
      return yield* fail('invalid-input');
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
              `CREATE TABLE workspaces(genesis_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,record BLOB NOT NULL CHECK(length(record)>0 AND length(record)<=8192)) STRICT;`
            );
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
    const guard = () => {
      if (closed) throw fail('closed');
    };

    const parseGenesis = (value: Uint8Array) => {
      if (!(value instanceof Uint8Array) || !value.length || value.length > 8192)
        throw fail('invalid-input');
      const record = new Uint8Array(value);
      const decoded = Result.getOrThrow(decodeRecord(record));
      if (decoded.body.type !== 'genesis') throw fail('invalid-input');
      const anchor = Result.getOrThrow(Bytes.genesisHash(hashRecordBytes(record).toBytes()));
      Result.getOrThrow(
        verifyLedger({
          anchor,
          records: [record],
          checkpoint: { head: hashRecordBytes(record), length: 1 },
        })
      );
      return { anchor, owner: decoded.body.signer, record };
    };
    const read = (anchor: Bytes.GenesisHash) => {
      const key = hex(anchor.toBytes());
      const row = db.prepare('SELECT * FROM workspaces WHERE genesis_hash=?').get(key) as
        | { genesis_hash: unknown; owner: unknown; record: unknown }
        | undefined;
      if (!row) return undefined;
      try {
        if (
          row.genesis_hash !== key ||
          typeof row.owner !== 'string' ||
          !(row.record instanceof Uint8Array)
        )
          throw fail('corrupt');
        const saved = parseGenesis(row.record);
        if (!saved.anchor.equals(anchor) || hex(saved.owner.toBytes()) !== row.owner)
          throw fail('corrupt');
        return saved;
      } catch {
        throw fail('corrupt');
      }
    };
    return Object.freeze({
      register: (credential: LabCredential, bytes: Uint8Array) =>
        sql(() => {
          guard();
          let captured: ReturnType<typeof parseGenesis>;
          try {
            captured = parseGenesis(bytes);
          } catch {
            throw fail('invalid-input');
          }
          if (
            !captured.owner.equals(credential.device) ||
            (credential.genesis !== null && !credential.genesis.equals(captured.anchor))
          )
            throw fail('unauthorized');
          const key = hex(captured.anchor.toBytes()),
            owner = hex(captured.owner.toBytes());
          db.transaction(() => {
            // Validate any surviving row before retry; never silently replace corruption.
            const prior = read(captured.anchor);
            if (prior && !Buffer.from(prior.record).equals(Buffer.from(captured.record)))
              throw fail('corrupt');
            db.prepare(
              'INSERT OR IGNORE INTO workspaces(genesis_hash,owner,record) VALUES(?,?,?)'
            ).run(key, owner, Buffer.from(captured.record));
            const saved = read(captured.anchor);
            if (!saved || !Buffer.from(saved.record).equals(Buffer.from(captured.record)))
              throw fail('storage');
          }).immediate();
          return { genesisHex: key, ownerDeviceHex: owner };
        }),
      get: (anchor: Bytes.GenesisHash) =>
        sql(() => {
          guard();
          return read(anchor);
        }),
    });
  });
}
