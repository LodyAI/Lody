import { openSqliteStore, makeSqliteLedgerPin } from './store';
import { isAbsolute } from 'node:path';
import { Data, Effect, Layer, Result } from 'effect';
import { BackendError } from '../../services/errors';
import { KeyMailbox } from '../../services/keys';
import * as Bytes from '../../internal/foundation/bytes';
import { keyId } from '../../internal/foundation/identifiers';
import { bytesEqual } from '../../internal/foundation/cbor';
import { type LedgerView } from '../../internal/ledger';
import { authenticateEpochEnvelope } from '../../internal/keys/envelope';
import {
  envelopeRouting,
  mailboxDigest,
  authenticateInstallationReport,
  checkLocalPublication,
  type MailboxSlot,
  isHash,
} from '../../internal/keys/reports';
/** Failure of the reference mailbox host. `unauthorized` covers every refused request (wrong principal, ineligible device, bad envelope); `replay` a reused id with different bytes or a full per-sender slot. */
export class MailboxError extends Data.TaggedError('MailboxError')<{
  readonly code:
    | 'storage'
    | 'corrupt'
    | 'closed'
    | 'unauthorized'
    | 'rollback'
    | 'invalid-page'
    | 'replay';
}> {}
const APP = 0x4c454d32; // Separate indexed schema; never opens the old whole-JSON mailbox store.
const sql = <A>(work: () => A) =>
  Effect.try({
    try: work,
    catch: (error) =>
      error instanceof MailboxError ? error : new MailboxError({ code: 'storage' }),
  });
const raw = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
/** Delivery state of one slot as the reference host computes it (see `KeyMailboxStatus`). */
export type MailboxStatus =
  | 'NeedsEnvelope'
  | 'EnvelopeStored'
  | 'InstallationReported'
  | 'Ineligible'
  | 'Obsolete';
/** A slot with its current delivery status and repair revision, as the reference host reports it. */
export interface MailboxTarget extends MailboxSlot {
  readonly status: MailboxStatus;
  readonly revision: number;
}
const pageStart = (cursor: string | null, limit: number) => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== null && !/^\d{1,9}$/.test(cursor))
  )
    return Result.fail(new MailboxError({ code: 'invalid-page' }));
  const start = cursor === null ? 0 : Number(cursor);
  return Result.succeed(start);
};
const envelopePageStart = (cursor: string | null, limit: number) => {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== null && !/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(cursor))
  )
    return Result.fail(new MailboxError({ code: 'invalid-page' }));
  return Result.succeed(cursor === null ? ['', ''] : cursor.split(':'));
};
const page = <A>(items: readonly A[], cursor: string | null, limit: number) => {
  const parsed = pageStart(cursor, limit);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const start = parsed.success;
  if (start > items.length) return Result.fail(new MailboxError({ code: 'invalid-page' }));
  return Result.succeed({
    items: items.slice(start, start + limit),
    next: start + limit < items.length ? String(start + limit) : null,
  });
};
/**
 * Reference mailbox *backend* in one SQLite file: the rules a production
 * mailbox must enforce (see `@lody/e2ee-core/host`), runnable in-process for
 * tests, the Lab and self-hosted experiments. Not a client adapter: production
 * clients reach a remote mailbox through their own {@link KeyMailbox} adapter.
 *
 * `bind(principal)` returns the operations for one *authenticated* device; the
 * caller derives the principal from an authenticated session, never from
 * request bodies.
 *
 * @category Reference hosts
 */
export const makeSqliteKeyMailbox = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
  readonly genesis: Bytes.GenesisHash;
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
}) {
  const { path, mode } = input;
  if (typeof path !== 'string' || !isAbsolute(path) || (mode !== 'create' && mode !== 'open'))
    return yield* new MailboxError({ code: 'storage' });
  const anchor = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes())),
    org = keyId(anchor.toBytes());
  const db = yield* openSqliteStore({
    path,
    mode,
    applicationId: APP,
    version: 1,
    initialize(connection) {
      connection.exec(`
    CREATE TABLE mailbox_meta (id INTEGER PRIMARY KEY CHECK(id=1), genesis TEXT NOT NULL, head BLOB, count INTEGER);
    CREATE TABLE mailbox_slots(epoch INTEGER NOT NULL,recipient TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,reported_revision INTEGER,PRIMARY KEY(epoch,recipient));
    CREATE TABLE mailbox_envelopes(epoch INTEGER NOT NULL,recipient TEXT NOT NULL,sender TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,frame BLOB NOT NULL CHECK(length(frame) BETWEEN 1 AND 512),PRIMARY KEY(epoch,recipient,sender,digest),UNIQUE(epoch,sender,id));
    CREATE TABLE mailbox_reports(epoch INTEGER NOT NULL,recipient TEXT NOT NULL,digest TEXT NOT NULL,report BLOB NOT NULL CHECK(length(report) BETWEEN 1 AND 512),PRIMARY KEY(epoch,recipient,digest));
    CREATE TABLE mailbox_rejected(epoch INTEGER NOT NULL,recipient TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(epoch,recipient,digest));
    CREATE TABLE mailbox_repairs(epoch INTEGER NOT NULL,recipient TEXT NOT NULL,id TEXT NOT NULL,rejected TEXT,PRIMARY KEY(epoch,recipient,id));

   `);
      connection.prepare('INSERT INTO mailbox_meta(id,genesis) VALUES(1,?)').run(org);
    },
    validate(connection) {
      const meta = connection.prepare('SELECT genesis FROM mailbox_meta WHERE id=1').get() as
        | { genesis?: unknown; recipient?: unknown; sender?: unknown }
        | undefined;
      if (meta?.genesis !== org) throw new MailboxError({ code: 'corrupt' });
    },
    error: (code) => new MailboxError({ code }),
  });
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    })
  );
  const guard = () => {
    if (closed) throw new MailboxError({ code: 'closed' });
  };

  const observePin = makeSqliteLedgerPin({
    db,
    table: 'mailbox_meta',
    genesis: org,
    error: (code) => new MailboxError({ code }),
  });
  const current = () =>
    Effect.gen(function* () {
      yield* sql(guard);
      const view = yield* input.ledger();
      yield* sql(() => {
        guard();
        observePin(view);
      });
      return view;
    });
  const slot = (epoch: number, recipient: string) => {
    db.prepare(
      'INSERT INTO mailbox_slots(epoch,recipient) VALUES(?,?) ON CONFLICT(epoch,recipient) DO NOTHING'
    ).run(epoch, recipient);
    const row = db
      .prepare('SELECT revision,reported_revision FROM mailbox_slots WHERE epoch=? AND recipient=?')
      .get(epoch, recipient) as { revision: unknown; reported_revision: unknown };
    if (
      typeof row.revision !== 'number' ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      (row.reported_revision !== null &&
        (typeof row.reported_revision !== 'number' ||
          !Number.isSafeInteger(row.reported_revision) ||
          row.reported_revision < 0))
    )
      throw new MailboxError({ code: 'corrupt' });
    return row as { revision: number; reported_revision: number | null };
  };
  const status = (view: LedgerView, target: MailboxSlot): MailboxTarget => {
    guard();
    const state = view.inspectState();
    if (target.genesis !== org || !state.devices.has(target.recipient))
      return { ...target, status: 'Ineligible', revision: 0 };
    if (target.epoch !== state.epoch.number) return { ...target, status: 'Obsolete', revision: 0 };
    const row = slot(target.epoch, target.recipient);
    const report = db
      .prepare('SELECT 1 FROM mailbox_reports WHERE epoch=? AND recipient=? LIMIT 1')
      .get(target.epoch, target.recipient);
    if (report && row.reported_revision === row.revision)
      return { ...target, status: 'InstallationReported', revision: row.revision };
    const envelope = db
      .prepare(
        'SELECT 1 FROM mailbox_envelopes e WHERE epoch=? AND recipient=? AND NOT EXISTS(SELECT 1 FROM mailbox_rejected r WHERE r.epoch=e.epoch AND r.recipient=e.recipient AND r.digest=e.digest) LIMIT 1'
      )
      .get(target.epoch, target.recipient);
    return {
      ...target,
      status: envelope ? 'EnvelopeStored' : 'NeedsEnvelope',
      revision: row.revision,
    };
  };
  return Object.freeze({
    bind(principal: Bytes.SigningPublicKey) {
      return Result.map(Bytes.signingPublicKey(principal.toBytes()), (device) => {
        const self = keyId(device.toBytes());
        const session = () =>
          Effect.gen(function* () {
            const view = yield* current();
            if (!view.inspectState().devices.has(self))
              return yield* new MailboxError({ code: 'unauthorized' });
            return view;
          });
        return Object.freeze({
          put: (id: string, inputFrame: Uint8Array) =>
            Effect.suspend(() =>
              Effect.gen(function* () {
                if (
                  !/^[0-9a-f]{32}$/.test(id) ||
                  !(inputFrame instanceof Uint8Array) ||
                  inputFrame.length > 512
                )
                  return yield* new MailboxError({ code: 'unauthorized' });
                const frame = new Uint8Array(inputFrame),
                  routing = yield* Effect.fromResult(envelopeRouting(frame));
                if (routing.sender !== self || routing.genesis !== org)
                  return yield* new MailboxError({ code: 'unauthorized' });
                const context = {
                  genesis: anchor,
                  epoch: yield* Effect.fromResult(Bytes.epochNumber(routing.epoch)),
                  sender: device,
                  recipient: yield* Effect.fromResult(
                    Bytes.signingPublicKey(raw(routing.recipient))
                  ),
                };
                const before = yield* session();
                yield* Effect.fromResult(authenticateEpochEnvelope(before, context, frame));
                const latest = yield* session();
                yield* Effect.fromResult(authenticateEpochEnvelope(latest, context, frame));
                yield* sql(() => {
                  guard();
                  db.transaction(() => {
                    slot(routing.epoch, routing.recipient);
                    const prior = db
                      .prepare(
                        'SELECT digest FROM mailbox_envelopes WHERE epoch=? AND sender=? AND id=?'
                      )
                      .get(routing.epoch, self, id) as { digest: unknown } | undefined;
                    const digest = mailboxDigest(frame);
                    if (prior && prior.digest !== digest)
                      throw new MailboxError({ code: 'replay' });
                    const existing = db
                      .prepare(
                        'SELECT frame FROM mailbox_envelopes WHERE epoch=? AND recipient=? AND sender=? AND digest=?'
                      )
                      .get(routing.epoch, routing.recipient, self, digest) as
                      | { frame: Uint8Array }
                      | undefined;
                    if (!existing) {
                      const { count } = db
                        .prepare(
                          'SELECT count(*) AS count FROM mailbox_envelopes e WHERE epoch=? AND recipient=? AND sender=? AND NOT EXISTS(SELECT 1 FROM mailbox_rejected r WHERE r.epoch=e.epoch AND r.recipient=e.recipient AND r.digest=e.digest)'
                        )
                        .get(routing.epoch, routing.recipient, self) as { count: number };
                      if (count >= 16) throw new MailboxError({ code: 'replay' });
                      db.prepare(
                        'INSERT INTO mailbox_envelopes(epoch,recipient,sender,id,digest,frame) VALUES(?,?,?,?,?,?) ON CONFLICT(epoch,recipient,sender,digest) DO NOTHING'
                      ).run(routing.epoch, routing.recipient, self, id, digest, frame);
                    }
                    const stored = db
                      .prepare(
                        'SELECT frame FROM mailbox_envelopes WHERE epoch=? AND recipient=? AND sender=? AND digest=?'
                      )
                      .get(routing.epoch, routing.recipient, self, digest) as
                      | { frame: unknown }
                      | undefined;
                    if (!(stored?.frame instanceof Uint8Array) || !bytesEqual(stored.frame, frame))
                      throw new MailboxError({ code: 'corrupt' });
                  }).immediate();
                });
                return undefined;
              })
            ),
          read: (id: string) =>
            Effect.gen(function* () {
              const view = yield* session();
              if (!/^[0-9a-f]{32}$/.test(id))
                return yield* new MailboxError({ code: 'unauthorized' });
              return yield* sql(() => {
                guard();
                const row = db
                  .prepare(
                    'SELECT CASE WHEN length(frame)<=512 THEN frame ELSE NULL END AS frame FROM mailbox_envelopes WHERE epoch=? AND sender=? AND id=?'
                  )
                  .get(view.inspectState().epoch.number, self, id) as
                  | { frame: unknown }
                  | undefined;
                if (!row) return null;
                if (!(row.frame instanceof Uint8Array) || row.frame.length < 1)
                  throw new MailboxError({ code: 'corrupt' });
                return new Uint8Array(row.frame);
              });
            }),
          fetch: (epoch: number, cursor: string | null, limit: number) =>
            Effect.gen(function* () {
              const start = yield* Effect.fromResult(envelopePageStart(cursor, limit));
              const view = yield* session();
              if (epoch !== view.inspectState().epoch.number)
                return yield* new MailboxError({ code: 'unauthorized' });
              return yield* sql(() =>
                db
                  .transaction(() => {
                    guard();
                    const rows = db
                      .prepare(
                        'SELECT sender,digest,CASE WHEN length(frame)<=512 THEN frame ELSE NULL END AS frame FROM mailbox_envelopes e WHERE epoch=? AND recipient=? AND NOT EXISTS(SELECT 1 FROM mailbox_rejected r WHERE r.epoch=e.epoch AND r.recipient=e.recipient AND r.digest=e.digest) AND (sender,digest)>(?,?) ORDER BY sender,digest LIMIT ?'
                      )
                      .all(epoch, self, start[0], start[1], limit) as {
                      sender: unknown;
                      digest: unknown;
                      frame: unknown;
                    }[];
                    const parsed = rows.map((row) => {
                      if (
                        !isHash(row.sender) ||
                        !isHash(row.digest) ||
                        !(row.frame instanceof Uint8Array) ||
                        row.frame.length < 1
                      )
                        throw new MailboxError({ code: 'corrupt' });
                      return { sender: row.sender, frame: new Uint8Array(row.frame) };
                    });
                    // Seek only a scalar existence bit; never load/copy a lookahead ciphertext.
                    const last = rows.at(-1);
                    const more =
                      last &&
                      db
                        .prepare(
                          'SELECT 1 FROM mailbox_envelopes e WHERE epoch=? AND recipient=? AND (sender,digest)>(?,?) AND NOT EXISTS(SELECT 1 FROM mailbox_rejected r WHERE r.epoch=e.epoch AND r.recipient=e.recipient AND r.digest=e.digest) LIMIT 1'
                        )
                        .get(epoch, self, last.sender, last.digest);
                    return { items: parsed, next: more ? `${last.sender}:${last.digest}` : null };
                  })
                  .deferred()
              );
            }),
          status: (inputTarget: MailboxSlot) =>
            Effect.gen(function* () {
              const target = { ...inputTarget };
              const view = yield* session();
              return yield* sql(() => status(view, target));
            }),
          list: (
            kind: 'needsEnvelope' | 'awaitingInstallationReport',
            cursor: string | null,
            limit: number
          ) =>
            Effect.gen(function* () {
              yield* Effect.fromResult(pageStart(cursor, limit));
              if (kind !== 'needsEnvelope' && kind !== 'awaitingInstallationReport')
                return yield* new MailboxError({ code: 'invalid-page' });
              const view = yield* session();
              return yield* sql(() => {
                const state = view.inspectState();
                const targets = [...state.devices.keys()]
                  .sort()
                  .map((recipient) =>
                    status(view, { genesis: org, epoch: state.epoch.number, recipient })
                  )
                  .filter((row) =>
                    kind === 'needsEnvelope'
                      ? row.status === 'NeedsEnvelope'
                      : row.status === 'EnvelopeStored'
                  );
                return Result.getOrThrow(page(targets, cursor, limit));
              });
            }),
          report: (inputReport: Uint8Array, publication?: Uint8Array) =>
            Effect.suspend(() =>
              Effect.gen(function* () {
                if (!(inputReport instanceof Uint8Array) || inputReport.length > 512)
                  return yield* new MailboxError({ code: 'unauthorized' });
                if (
                  publication !== undefined &&
                  (!(publication instanceof Uint8Array) || publication.length > 8192)
                )
                  return yield* new MailboxError({ code: 'unauthorized' });
                const record = publication === undefined ? undefined : new Uint8Array(publication);
                const report = new Uint8Array(inputReport);
                const before = yield* session();
                const context = yield* Effect.fromResult(
                  authenticateInstallationReport({
                    view: before,
                    genesis: anchor,
                    authenticatedRecipient: device,
                    report,
                  })
                );
                if (context.source._tag === 'LocalPublication') {
                  if (!record) return yield* new MailboxError({ code: 'unauthorized' });
                  yield* Effect.fromResult(checkLocalPublication(before, context, record));
                }
                const latest = yield* session();
                yield* Effect.fromResult(
                  authenticateInstallationReport({
                    view: latest,
                    genesis: anchor,
                    authenticatedRecipient: device,
                    report,
                  })
                );
                yield* sql(() => {
                  guard();
                  db.transaction(() => {
                    const row = slot(context.epoch, self);
                    if (row.revision !== context.revision)
                      throw new MailboxError({ code: 'unauthorized' });
                    if (context.source._tag === 'Envelope') {
                      const stored = db
                        .prepare(
                          'SELECT 1 FROM mailbox_envelopes e WHERE epoch=? AND recipient=? AND sender=? AND digest=? AND NOT EXISTS(SELECT 1 FROM mailbox_rejected r WHERE r.epoch=e.epoch AND r.recipient=e.recipient AND r.digest=e.digest)'
                        )
                        .get(
                          context.epoch,
                          self,
                          context.source.sender,
                          context.source.frameDigest
                        );
                      if (!stored) throw new MailboxError({ code: 'unauthorized' });
                    }
                    db.prepare(
                      'INSERT INTO mailbox_reports(epoch,recipient,digest,report) VALUES(?,?,?,?) ON CONFLICT(epoch,recipient,digest) DO NOTHING'
                    ).run(context.epoch, self, mailboxDigest(report), report);
                    db.prepare(
                      'UPDATE mailbox_slots SET reported_revision=? WHERE epoch=? AND recipient=?'
                    ).run(context.revision, context.epoch, self);
                  }).immediate();
                });
                return undefined;
              })
            ),
          repair: (inputTarget: MailboxSlot, requestId: string, rejectedDigest?: string) =>
            Effect.gen(function* () {
              const target = { ...inputTarget };
              const view = yield* session();
              if (
                target.genesis !== org ||
                target.epoch !== view.inspectState().epoch.number ||
                target.recipient !== self ||
                typeof requestId !== 'string' ||
                requestId.length < 1 ||
                requestId.length > 256 ||
                (rejectedDigest !== undefined && !isHash(rejectedDigest))
              )
                return yield* new MailboxError({ code: 'unauthorized' });
              yield* sql(() => {
                guard();
                db.transaction(() => {
                  const row = slot(target.epoch, self);
                  const prior = db
                    .prepare(
                      'SELECT rejected FROM mailbox_repairs WHERE epoch=? AND recipient=? AND id=?'
                    )
                    .get(target.epoch, self, requestId) as { rejected: unknown } | undefined;
                  if (prior) {
                    if (prior.rejected !== (rejectedDigest ?? null))
                      throw new MailboxError({ code: 'replay' });
                    return;
                  }
                  if (row.revision >= Number.MAX_SAFE_INTEGER)
                    throw new MailboxError({ code: 'corrupt' });
                  if (rejectedDigest) {
                    if (
                      !db
                        .prepare(
                          'SELECT 1 FROM mailbox_envelopes WHERE epoch=? AND recipient=? AND digest=?'
                        )
                        .get(target.epoch, self, rejectedDigest)
                    )
                      throw new MailboxError({ code: 'unauthorized' });
                    db.prepare(
                      'INSERT INTO mailbox_rejected(epoch,recipient,digest) VALUES(?,?,?) ON CONFLICT DO NOTHING'
                    ).run(target.epoch, self, rejectedDigest);
                  }
                  db.prepare(
                    'INSERT INTO mailbox_repairs(epoch,recipient,id,rejected) VALUES(?,?,?,?)'
                  ).run(target.epoch, self, requestId, rejectedDigest ?? null);
                  db.prepare(
                    'UPDATE mailbox_slots SET revision=revision+1,reported_revision=NULL WHERE epoch=? AND recipient=?'
                  ).run(target.epoch, self);
                }).immediate();
              });
              return undefined;
            }),
        });
      });
    },
  });
});

const backendError = (error: unknown) =>
  new BackendError({
    service: 'KeyMailbox',
    reason:
      error instanceof MailboxError
        ? error.code === 'unauthorized'
          ? 'unauthorized'
          : error.code === 'replay'
            ? 'conflict'
            : error.code === 'invalid-page'
              ? 'invalid-response'
              : 'unavailable'
        : 'unavailable',
    cause: error,
  });

/**
 * {@link KeyMailbox} for `principal` served directly by a reference host, as if
 * over an authenticated connection.
 *
 * @category Reference hosts
 */
export const referenceKeyMailbox = (
  host: Effect.Success<ReturnType<typeof makeSqliteKeyMailbox>>,
  principal: Bytes.SigningPublicKey
) =>
  Layer.effect(
    KeyMailbox,
    Effect.gen(function* () {
      const bound = yield* Effect.fromResult(host.bind(principal)).pipe(
        Effect.mapError(backendError)
      );
      return KeyMailbox.of({
        status: (slot) => bound.status(slot).pipe(Effect.mapError(backendError)),
        report: (report, publication) =>
          bound.report(report, publication).pipe(Effect.mapError(backendError)),
        fetch: (epoch, cursor, limit) =>
          bound.fetch(epoch, cursor, limit).pipe(Effect.mapError(backendError)),
        repair: (slot, id, rejected) =>
          bound.repair(slot, id, rejected).pipe(Effect.mapError(backendError)),
        put: (id, frame) => bound.put(id, frame).pipe(Effect.mapError(backendError)),
        read: (id) => bound.read(id).pipe(Effect.mapError(backendError)),
      });
    })
  );
