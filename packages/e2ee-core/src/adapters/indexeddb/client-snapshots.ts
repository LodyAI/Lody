import { Effect, Layer, Schema } from 'effect';
import { DeviceIdentity } from '../../services/workspace';
import {
  SnapshotPublicationJournal,
  SnapshotPublicationError,
  snapshotPublicationDigest,
  type SnapshotPublicationRow,
  type SnapshotPublicationOriginal,
} from '../../services/snapshot-publication';
import { MAX_CONTENT_BYTES } from '../../internal/foundation/content-format';
import { LocalStoreError } from '../../services/errors';
import {
  openClientDatabase,
  bindingRaw,
  bindingId,
  BindingSchema,
  sameScope,
  sameBinding,
  boundedBytes,
  safeInt,
  decode,
  writeRow,
} from './client-database';
import { failure, type Transaction } from './database';
import type { IndexedDbClientKeyStoreOptions } from './client-key-stores';

/** A single resource/model snapshot journal bound to one local incarnation. */
export interface IndexedDbSnapshotPublicationOptions extends IndexedDbClientKeyStoreOptions {
  /** Independently trusted resource id, never read from an incoming frame. */
  readonly resource: string;
  /** Exact native content model. */
  readonly model: 'loro' | 'flock';
  /** Retained-body budget; receipts remain retained after their ciphertext is superseded. */
  readonly budget?: { readonly maxSnapshots: number; readonly maxBytes: number };
}
const validOffset = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 1024 &&
  v !== 'now' &&
  v !== '-1' &&
  v.trim() === v &&
  !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const S = Schema;
const Meta = S.Struct({
  version: S.Literal(1),
  binding: BindingSchema,
  resource: S.String,
  model: S.Literals(['loro', 'flock']),
  current: S.NullOr(S.String),
  pending: S.NullOr(S.String),
  count: S.Int,
  bytes: S.Int,
});
const Row = S.Struct({
  offset: S.String,
  signer: S.String,
  digest: S.String,
  body: S.NullOr(S.Uint8Array),
  issuedAt: S.Int,
  expiresAt: S.Int,
  phase: S.Literals(['Pending', 'Accepted']),
});
const sameOriginal = (a: SnapshotPublicationRow, b: SnapshotPublicationRow) =>
  a.offset === b.offset && a.signer === b.signer && a.digest === b.digest;
const mapError = (e: unknown) =>
  e instanceof SnapshotPublicationError
    ? e
    : new SnapshotPublicationError({
        code:
          e instanceof LocalStoreError
            ? e.store === 'SnapshotPublication/busy'
              ? 'busy'
              : e.reason === 'missing'
                ? 'storage'
                : e.reason
            : 'storage',
      });
/** Atomic snapshot Pending/current/receipt persistence; opaque offsets never imply order, signature validity or native acceptance. */
export const indexedDbSnapshotPublication = (input: IndexedDbSnapshotPublicationOptions) => {
  const options = {
    ...input,
    binding: { ...input.binding },
    budget: input.budget ? { ...input.budget } : undefined,
  };
  return Layer.effect(
    SnapshotPublicationJournal,
    Effect.gen(function* () {
      const identity = yield* DeviceIdentity,
        b = yield* Effect.try({
          try: () => bindingRaw(options.binding),
          catch: () => new SnapshotPublicationError({ code: 'invalid-input' }),
        });
      const maxSnapshots = options.budget?.maxSnapshots ?? 10000,
        maxBytes = options.budget?.maxBytes ?? 64 * 1024 * 1024;
      if (
        !identity.signer.publicKey.equals(options.binding.device) ||
        typeof options.resource !== 'string' ||
        !options.resource.length ||
        options.resource.length > 1024 ||
        !/^[!-~]+$/.test(options.resource) ||
        !['loro', 'flock'].includes(options.model) ||
        !safeInt(maxSnapshots, 1, 100000) ||
        !safeInt(maxBytes, 1, 64 * 1024 * 1024)
      )
        return yield* new SnapshotPublicationError({ code: 'invalid-input' });
      const db = yield* openClientDatabase({
        databaseName: options.databaseName,
        mode: options.mode,
        accountId: b.accountId,
        workspaceId: b.workspaceId,
      }).pipe(Effect.mapError(mapError));
      if (!sameScope(b, db.bound))
        return yield* new SnapshotPublicationError({ code: 'invalid-input' });
      const owner = bindingId(b),
        metaKey = ['meta', owner, options.resource, options.model],
        rowKey = (offset: string) => ['row', owner, options.resource, options.model, offset];
      const meta = (v: unknown) =>
        decode('SnapshotPublication', () => {
          const r = S.decodeUnknownSync(Meta, { onExcessProperty: 'error' })(v);
          if (
            !sameBinding(r.binding, b) ||
            r.resource !== options.resource ||
            r.model !== options.model ||
            !safeInt(r.count, 0, maxSnapshots) ||
            !safeInt(r.bytes, 0, maxBytes) ||
            (r.current !== null && !validOffset(r.current)) ||
            (r.pending !== null && !validOffset(r.pending))
          )
            throw failure('SnapshotPublication', 'corrupt');
          return r;
        });
      const row = (v: unknown): SnapshotPublicationRow =>
        decode('SnapshotPublication', () => {
          const r = S.decodeUnknownSync(Row, { onExcessProperty: 'error' })(v);
          if (
            !validOffset(r.offset) ||
            !/^[0-9a-f]{64}$/.test(r.signer) ||
            !/^[0-9a-f]{64}$/.test(r.digest) ||
            !safeInt(r.issuedAt) ||
            !safeInt(r.expiresAt, r.issuedAt + 1) ||
            (r.phase === 'Pending' && r.body === null) ||
            (r.body !== null &&
              (!boundedBytes(r.body, MAX_CONTENT_BYTES) ||
                snapshotPublicationDigest(r.body) !== r.digest))
          )
            throw failure('SnapshotPublication', 'corrupt');
          return structuredClone(r) as SnapshotPublicationRow;
        });
      const read = (
        tx: Transaction,
        offset: string,
        done: (r: SnapshotPublicationRow | null) => void
      ) =>
        tx.request(tx.store('snapshots').get(rowKey(offset)), (v) => {
          const r = v === undefined ? null : row(v);
          if (r && r.offset !== offset) throw failure('SnapshotPublication', 'corrupt');
          done(r);
        });
      const metadata = (tx: Transaction, done: (m: ReturnType<typeof meta>) => void) =>
        tx.request(tx.store('snapshots').get(metaKey), (v) => done(meta(v)));
      const run = <A>(
        mode: IDBTransactionMode,
        work: (tx: Transaction, done: (value: A) => void) => void
      ) => db.run('SnapshotPublication', ['snapshots'], mode, work).pipe(Effect.mapError(mapError));
      const inspect = (
        tx: Transaction,
        m: ReturnType<typeof meta>,
        done: (
          current: SnapshotPublicationRow | null,
          pending: SnapshotPublicationRow | null
        ) => void
      ) => {
        const pending = (current: SnapshotPublicationRow | null) => {
          const finish = (p: SnapshotPublicationRow | null) => {
            if (
              (p && (p.phase !== 'Pending' || p.body === null)) ||
              m.count !== (current ? 1 : 0) + (p ? 1 : 0) ||
              m.bytes !== (current?.body?.length ?? 0) + (p?.body?.length ?? 0)
            )
              throw failure('SnapshotPublication', 'corrupt');
            done(current, p);
          };
          if (m.pending === null) finish(null);
          else
            read(tx, m.pending, (p) => {
              if (!p) throw failure('SnapshotPublication', 'corrupt');
              finish(p);
            });
        };
        if (m.current === null) pending(null);
        else
          read(tx, m.current, (r) => {
            if (!r || r.phase !== 'Accepted' || r.body === null)
              throw failure('SnapshotPublication', 'corrupt');
            pending(r);
          });
      };
      yield* run<void>('readwrite', (tx, done) =>
        tx.request(tx.store('snapshots').get(metaKey), (v) => {
          if (v !== undefined) {
            const m = meta(v);
            inspect(tx, m, () => done(undefined));
            return;
          }
          if (options.mode === 'open-existing') throw failure('SnapshotPublication', 'missing');
          tx.request(
            tx
              .store('snapshots')
              .count(
                IDBKeyRange.bound(
                  ['row', owner, options.resource, options.model],
                  ['row', owner, options.resource, options.model, []]
                )
              ),
            (count) => {
              if (count !== 0) throw failure('SnapshotPublication', 'corrupt');
              writeRow(
                tx,
                'snapshots',
                metaKey,
                {
                  version: 1 as const,
                  binding: b,
                  resource: options.resource,
                  model: options.model,
                  current: null,
                  pending: null,
                  count: 0,
                  bytes: 0,
                },
                meta,
                () => done(undefined)
              );
            }
          );
        })
      );
      const capture = (inputRow: SnapshotPublicationOriginal) =>
        Effect.try({
          try: () => {
            if (!boundedBytes(inputRow.body, MAX_CONTENT_BYTES))
              throw failure('SnapshotPublication', 'corrupt');
            const body = new Uint8Array(inputRow.body),
              r = {
                ...inputRow,
                body,
                digest: snapshotPublicationDigest(body),
                phase: 'Pending' as const,
              };
            return row(r);
          },
          catch: () => new SnapshotPublicationError({ code: 'invalid-input' }),
        });
      return SnapshotPublicationJournal.of({
        lookup: (offset) =>
          !validOffset(offset)
            ? Effect.fail(new SnapshotPublicationError({ code: 'invalid-input' }))
            : run('readonly', (tx, done) => metadata(tx, () => read(tx, offset, done))),
        pending: () =>
          run('readonly', (tx, done) => metadata(tx, (m) => inspect(tx, m, (_c, p) => done(p)))),
        current: () =>
          run('readonly', (tx, done) =>
            metadata(tx, (m) =>
              inspect(tx, m, (c) =>
                done(c as (SnapshotPublicationRow & { body: Uint8Array }) | null)
              )
            )
          ),
        reserve: (original) =>
          Effect.flatMap(capture(original), (n) =>
            run('readwrite', (tx, done) =>
              metadata(tx, (m) =>
                read(tx, n.offset, (prior) => {
                  if (prior) {
                    if (!sameOriginal(prior, n)) throw failure('SnapshotPublication', 'conflict');
                    done(prior);
                    return;
                  }
                  inspect(tx, m, () => {
                    if (m.pending !== null) throw failure('SnapshotPublication/busy', 'conflict');
                    if (m.count >= maxSnapshots || m.bytes + n.body!.length > maxBytes)
                      throw failure('SnapshotPublication', 'capacity');
                    const next = {
                      ...m,
                      pending: n.offset,
                      count: m.count + 1,
                      bytes: m.bytes + n.body!.length,
                    };
                    writeRow(tx, 'snapshots', rowKey(n.offset), n, row, (saved) =>
                      writeRow(tx, 'snapshots', metaKey, next, meta, () => done(saved))
                    );
                  });
                })
              )
            )
          ),
        accept: (expected) =>
          Effect.flatMap(
            Effect.try({
              try: () => row(structuredClone(expected)),
              catch: () => new SnapshotPublicationError({ code: 'invalid-input' }),
            }),
            (n) =>
              run<void>('readwrite', (tx, done) =>
                metadata(tx, (m) =>
                  read(tx, n.offset, (prior) => {
                    if (
                      !prior ||
                      !sameOriginal(prior, n) ||
                      prior.issuedAt !== n.issuedAt ||
                      prior.expiresAt !== n.expiresAt
                    )
                      throw failure('SnapshotPublication', 'conflict');
                    if (prior.phase === 'Accepted') {
                      done(undefined);
                      return;
                    }
                    if (n.phase !== 'Pending' || m.pending !== prior.offset || prior.body === null)
                      throw failure('SnapshotPublication', 'conflict');
                    inspect(tx, m, (current) => {
                      const accepted = { ...prior, phase: 'Accepted' as const },
                        next = {
                          ...m,
                          current: prior.offset,
                          pending: null,
                          count: 1,
                          bytes: prior.body!.length,
                        };
                      const commit = () =>
                        writeRow(tx, 'snapshots', rowKey(prior.offset), accepted, row, () =>
                          writeRow(tx, 'snapshots', metaKey, next, meta, () => done(undefined))
                        );
                      if (current)
                        writeRow<SnapshotPublicationRow>(
                          tx,
                          'snapshots',
                          rowKey(current.offset),
                          { ...current, phase: 'Accepted', body: null },
                          row,
                          commit
                        );
                      else commit();
                    });
                  })
                )
              )
          ),
      });
    })
  );
};
