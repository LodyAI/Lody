import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import * as Bytes from '../../src/internal/foundation/bytes';
import { bytesEqual } from '../../src/internal/foundation/cbor';
import { ContentError } from '../../src/internal/foundation/errors';
import { decodeRecord, hashRecordBytes, verifyLedger } from '../../src/internal/ledger';
import { SubmissionJournal, LedgerLog, LedgerLogError } from '../../src/services';
import { sqliteSubmissionJournal } from '../../src/adapters/node-sqlite/submission-journal';
import { ownEpochStagedGroup, type EpochStagedGroup } from '../../src/internal/keys/staging';
import { makeSqliteEpochRotation } from './harness';
import { makeSqliteProtectedEpochKeys } from './harness';
import { synthetic } from './protection-fixture';
const Config = Schema.Struct({
  genesis: Schema.String,
  publisher: Schema.String,
  files: Schema.Struct({
    candidate: Schema.String,
    keys: Schema.String,
    journal: Schema.String,
    history: Schema.String,
  }),
  initial: Schema.Array(Schema.String),
  candidate: Schema.String,
});
const config = Schema.decodeUnknownSync(Config)(JSON.parse(readFileSync(process.argv[2]!, 'utf8')));
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex')),
  ok = Result.getOrThrow;
const anchor = ok(Bytes.genesisHash(bytes(config.genesis))),
  publisher = ok(Bytes.signingPublicKey(bytes(config.publisher))),
  initial = config.initial.map(bytes),
  candidate = bytes(config.candidate);
const expected = [...initial, candidate];
const load = () => {
  const records = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
    JSON.parse(readFileSync(config.files.history, 'utf8'))
  ).map(bytes);
  if (
    (records.length !== initial.length && records.length !== expected.length) ||
    records.some((record, index) => !bytesEqual(record, expected[index]!))
  )
    throw new Error('unexpected-test-history');
  const checkpoint = {
    head: hashRecordBytes(records[records.length - 1]!),
    length: records.length,
  };
  return { records, checkpoint, view: ok(verifyLedger({ anchor, records, checkpoint })) };
};
let signed = 0;
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const native = synthetic(),
        ledger = () => Effect.sync(() => load().view);
      const installed = yield* makeSqliteProtectedEpochKeys({
        path: config.files.keys,
        mode: 'open',
        genesis: anchor,
        recipient: publisher,
        ledger,
        protector: native.protector,
      });
      const context = yield* Layer.build(sqliteSubmissionJournal({ path: config.files.journal })),
        journal = Context.get(context, SubmissionJournal);
      const remote = LedgerLog.of({
        read: () =>
          Effect.sync(() => {
            const value = load();
            return { records: value.records, checkpoint: value.checkpoint };
          }),
        appendCas: (_anchor, checkpoint, record) =>
          Effect.suspend(() => {
            const current = load();
            if (
              current.checkpoint.length !== checkpoint.length ||
              !current.checkpoint.head.equals(checkpoint.head) ||
              !bytesEqual(record, candidate)
            )
              return Effect.fail(new LedgerLogError());
            writeFileSync(
              config.files.history,
              JSON.stringify(
                [...current.records, record].map((value) => Buffer.from(value).toString('hex'))
              )
            );
            return Effect.void;
          }),
      });
      let staged: EpochStagedGroup | null = null;
      const rotation = yield* makeSqliteEpochRotation({
        path: config.files.candidate,
        mode: 'open',
        genesis: anchor,
        signer: {
          publicKey: publisher,
          sign: () =>
            Effect.suspend(() => {
              signed++;
              return Effect.fail(new ContentError({ code: 'sign-failed' }));
            }),
        },
        ledger,
        installed,
        protector: native.protector,
        staging: {
          stageGroup: (group) =>
            Effect.sync(() => {
              staged = ok(ownEpochStagedGroup(group));
            }),
          readGroup: () => Effect.sync(() => staged),
          deleteGroup: () =>
            Effect.sync(() => {
              staged = null;
            }),
        },
      }).pipe(
        Effect.provideService(SubmissionJournal, journal),
        Effect.provideService(LedgerLog, remote)
      );
      const result = yield* rotation.resume();
      if (!result) throw new Error('missing-candidate');
      yield* rotation.acknowledge(result);
      const parsed = ok(decodeRecord(result.record)),
        removed =
          parsed.body.type === 'ordinary' &&
          parsed.body.operation.type === 'removeMemberAndPublishEpoch'
            ? parsed.body.operation.membershipId
            : null;
      if (removed) {
        const state = load().view.inspectState();
        if (
          state.members.has(Buffer.from(removed.toBytes()).toString('hex')) ||
          [...state.devices.values()].some((device) => device.membershipId.equals(removed))
        )
          throw Error('removed member retained current eligibility');
      }
      const db = new Database(config.files.candidate);
      let consumed: unknown;
      try {
        consumed = (
          db.prepare('SELECT consumed FROM epoch_rotation_candidates').get() as {
            consumed: unknown;
          }
        ).consumed;
      } finally {
        db.close();
      }
      process.stdout.write(
        JSON.stringify({
          outcome: result.outcome,
          epoch: result.epoch,
          record: Buffer.from(result.record).toString('hex'),
          signed,
          consumed,
          removedMembershipId: removed ? Buffer.from(removed.toBytes()).toString('hex') : null,
        })
      );
    })
  )
);
