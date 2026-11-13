import { openSqliteStore } from '@lody/e2ee-core/internal';
import { Data, Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { type LedgerCheckpoint } from '@lody/e2ee-core';
import { decodeRecord, extendLedger, hashRecordBytes } from '@lody/e2ee-core/protocol';
import {
  makeStreamsLedgerLog,
  type LedgerSubmissionStream,
} from '@lody/e2ee-core/adapters/loro-streams';
import { authorizeLabStream } from './gateway';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { makeLabOperations } from './operation-scope';

export class LabControlGatewayError extends Data.TaggedError('LabControlGatewayError')<{
  readonly code:
    | 'unauthorized'
    | 'invalid-record'
    | 'join-expired'
    | 'transport'
    | 'closed'
    | 'self-service-rate-limited'
    | 'quota-storage';
  readonly retryAt?: number;
}> {}
/** Host consumer only. Authentication and independently selected durable checkpoints
 * belong to the host, not request JSON/offsets. Core audits the entire signed history,
 * verifies the candidate and pins SDK CAS to the verified transport tail. Caller
 * headers have no upstream forwarding path. No duplicate submission journal or signer. */
export function makeLabControlGateway(input: {
  readonly quotaPath: string;
  readonly genesis: Bytes.GenesisHash;
  readonly stream: LedgerSubmissionStream;
  readonly checkpoint: () => Effect.Effect<LedgerCheckpoint, unknown>;
  /** Persist the host's newly observed signed suffix before replying. A failed
   * confirmation leaves the caller's original P09 operation recoverable. */
  readonly afterAppend?: () => Effect.Effect<void, unknown>;
  readonly now: () => number;
  readonly budget: Parameters<typeof makeStreamsLedgerLog>[0]['budget'];
}) {
  return Effect.gen(function* () {
    const anchor = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
    const checkpoint = input.checkpoint,
      afterAppend = input.afterAppend,
      now = input.now,
      budget = { ...input.budget };
    const quota = yield* openSqliteStore({
      path: input.quotaPath,
      mode: 'create-or-open',
      applicationId: 0x4c455751,
      version: 1,
      error: () => new LabControlGatewayError({ code: 'quota-storage' }),
      initialize: (db) =>
        db.exec(`CREATE TABLE ledger_write_quota (
        record TEXT PRIMARY KEY, member TEXT NOT NULL, issued_at INTEGER NOT NULL
      ) STRICT; CREATE INDEX ledger_write_member_time ON ledger_write_quota(member, issued_at);`),
    });
    const reserve = (view: import('@lody/e2ee-core').LedgerView, record: Uint8Array) =>
      Effect.try({
        try: () =>
          quota
            .transaction(() => {
              const decoded = Result.getOrThrow(decodeRecord(record));
              if (decoded.body.type !== 'ordinary')
                throw new LabControlGatewayError({ code: 'invalid-record' });
              const operation = decoded.body.operation;
              if (operation.type !== 'admitDevice' && operation.type !== 'revokeDevice') return;
              const member = view
                .inspectState()
                .devices.get(Buffer.from(decoded.body.signer.toBytes()).toString('hex'));
              if (!member) throw new LabControlGatewayError({ code: 'unauthorized' });
              const id = Buffer.from(hashRecordBytes(record).toBytes()).toString('hex');
              if (quota.prepare('SELECT 1 FROM ledger_write_quota WHERE record = ?').get(id))
                return;
              let time = now();
              if (!Number.isSafeInteger(time) || time < 0)
                throw new LabControlGatewayError({ code: 'quota-storage' });
              const membership =
                Buffer.from(anchor.toBytes()).toString('hex') +
                ':' +
                Buffer.from(member.membershipId.toBytes()).toString('hex');
              const latest = quota
                .prepare(
                  'SELECT MAX(issued_at) AS issued_at FROM ledger_write_quota WHERE member = ?'
                )
                .get(membership) as { issued_at: number | null };
              time = Math.max(time, latest.issued_at ?? time);
              const times = quota
                .prepare(
                  'SELECT issued_at FROM ledger_write_quota WHERE member = ? AND issued_at > ? ORDER BY issued_at'
                )
                .all(membership, time - 86400000) as { issued_at: number }[];
              const hourly = times.filter((row) => row.issued_at > time - 3600000);
              const retryAt = Math.max(
                hourly.length >= 10 ? hourly[hourly.length - 10]!.issued_at + 3600000 : 0,
                times.length >= 30 ? times[times.length - 30]!.issued_at + 86400000 : 0
              );
              if (retryAt)
                throw new LabControlGatewayError({ code: 'self-service-rate-limited', retryAt });
              quota
                .prepare('DELETE FROM ledger_write_quota WHERE member = ? AND issued_at <= ?')
                .run(membership, time - 86400000);
              quota
                .prepare('INSERT INTO ledger_write_quota VALUES (?, ?, ?)')
                .run(id, membership, time);
              const saved = quota
                .prepare('SELECT member, issued_at FROM ledger_write_quota WHERE record = ?')
                .get(id) as { member: string; issued_at: number } | undefined;
              if (saved?.member !== membership || saved.issued_at !== time)
                throw new LabControlGatewayError({ code: 'quota-storage' });
            })
            .immediate(),
        catch: (error) =>
          error instanceof LabControlGatewayError
            ? error
            : new LabControlGatewayError({ code: 'quota-storage' }),
      });
    const operations = yield* makeLabOperations();
    const guard = () =>
      operations.signal.aborted
        ? Effect.fail(new LabControlGatewayError({ code: 'closed' }))
        : Effect.void;
    const read = input.stream.read.bind(input.stream),
      append = input.stream.appendCas.bind(input.stream);
    return Object.freeze({
      append: (request: {
        readonly authenticatedCredential: Parameters<
          typeof authorizeLabStream
        >[0]['authenticatedCredential'];
        readonly requestGenesis: Bytes.GenesisHash;
        readonly record: Uint8Array;
      }) =>
        operations.run(
          Effect.gen(function* () {
            const captured = yield* Effect.try({
              try: () => ({
                device: request.authenticatedCredential.device.toBytes(),
                bound:
                  request.authenticatedCredential.genesis === null
                    ? null
                    : request.authenticatedCredential.genesis.toBytes(),
                requestGenesis: request.requestGenesis.toBytes(),
                framed: frameLedgerRecord(request.record),
              }),
              catch: () => new LabControlGatewayError({ code: 'invalid-record' }),
            });
            const device = yield* Effect.fromResult(Bytes.signingPublicKey(captured.device));
            const bound =
              captured.bound === null
                ? null
                : yield* Effect.fromResult(Bytes.genesisHash(captured.bound));
            const requestGenesis = yield* Effect.fromResult(
              Bytes.genesisHash(captured.requestGenesis)
            );
            const framed = yield* Effect.fromResult(captured.framed);
            const record = framed.subarray(4);
            let outcome: Awaited<ReturnType<LedgerSubmissionStream['appendCas']>> | undefined;
            const remote = yield* makeStreamsLedgerLog({
              genesis: anchor,
              checkpoint,
              budget,
              stream: {
                read: (readRequest) =>
                  read({
                    ...readRequest,
                    signal: AbortSignal.any([readRequest.signal, operations.signal]),
                  }),
                appendCas: async (value) => {
                  if (operations.signal.aborted)
                    throw new LabControlGatewayError({ code: 'closed' });
                  outcome = await append(value);
                  return outcome;
                },
              },
            });
            const history = yield* remote.read(anchor);
            yield* Effect.fromResult(
              authorizeLabStream({
                view: history.view,
                authenticatedCredential: { device, genesis: bound },
                requestGenesis,
                stream: 'control',
                method: 'POST',
                sub: 'append-cas',
                controlRecord: record,
              })
            );
            const decoded = yield* Effect.fromResult(decodeRecord(record));
            if (decoded.body.type !== 'ordinary' || !decoded.body.signer.equals(device))
              return yield* new LabControlGatewayError({ code: 'unauthorized' });
            const operation = decoded.body.operation;
            if (operation.type === 'admitMember' && operation.request.expiresAt !== null) {
              const time = now();
              if (!Number.isSafeInteger(time) || time < 0 || time >= operation.request.expiresAt)
                return yield* new LabControlGatewayError({ code: 'join-expired' });
            }
            // Verify the complete candidate before charging; reservations survive unknown CAS
            // results and exact-original retries never spend the quota twice.
            yield* Effect.fromResult(
              extendLedger(history.view, [record], {
                head: hashRecordBytes(record),
                length: history.view.length + 1,
              })
            );
            yield* reserve(history.view, record);
            const attempted = yield* Effect.result(
              remote.appendCas(anchor, history.checkpoint, record)
            );
            if (afterAppend) yield* afterAppend();
            yield* Effect.fromResult(attempted);
            yield* guard();
            const result = outcome;
            if (!result?.ok || result.result.kind !== 'ok')
              return yield* new LabControlGatewayError({ code: 'transport' });
            return { nextOffset: result.result.value.nextOffset };
          })
        ),
    });
  });
}
