import Database from 'better-sqlite3';
import { writeSync } from 'node:fs';
import { Effect, Result } from 'effect';
import { ContentError } from '../../src/internal/foundation/errors';
import { bytesEqual } from '../../src/internal/foundation/cbor';
import { authenticateEpochEnvelope } from '@lody/e2ee-core/protocol';
import { KeyMailbox } from '@lody/e2ee-core/services';
import { deliverEpochEnvelope, epochDeliveryId } from '@lody/e2ee-core/internal';
import { DeliveryRemote, deliveryMailbox } from './harness';
import { sqliteDeliveryOutbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { envelopeFixture } from './fixture';
const [mode, file, hostPath] = process.argv.slice(2);
if (!file || !hostPath || !['before-send', 'lost-response', 'resume'].includes(mode!))
  throw new Error('synthetic fixture arguments');
const f = envelopeFixture();
const host = new Database(hostPath);
host.pragma('journal_mode=WAL');
host.pragma('synchronous=FULL');
host.exec('CREATE TABLE IF NOT EXISTS envelopes(slot TEXT PRIMARY KEY,frame BLOB NOT NULL)');
const read = (slot: string) => {
  const row = host.prepare('SELECT frame FROM envelopes WHERE slot=?').get(slot) as
    | { frame: Uint8Array }
    | undefined;
  return row ? new Uint8Array(row.frame) : null;
};
const remote = DeliveryRemote.of({
  put: (slot, frame) =>
    Effect.gen(function* () {
      yield* Effect.fromResult(authenticateEpochEnvelope(f.view(), f.context, frame));
      if (slot !== Result.getOrThrow(epochDeliveryId(f.context)))
        return yield* new ContentError({ code: 'unauthorized' });
      if (mode === 'before-send') {
        writeSync(1, Buffer.from(frame).toString('hex'));
        process.exit(81);
      }
      const prior = read(slot);
      if (prior && !bytesEqual(prior, frame)) return yield* new ContentError({ code: 'conflict' });
      host
        .prepare('INSERT INTO envelopes(slot,frame) VALUES(?,?) ON CONFLICT(slot) DO NOTHING')
        .run(slot, frame);
      if (mode === 'lost-response') {
        writeSync(1, Buffer.from(frame).toString('hex'));
        process.exit(82);
      }
      return undefined;
    }),
  read: (slot) => Effect.sync(() => read(slot)),
});
try {
  const result = await Effect.runPromise(
    deliverEpochEnvelope({
      context: f.context,
      ledger: f.ledger,
      ...(mode === 'resume' ? {} : { prepare: { key: f.secret, signer: f.owner.signer } }),
    }).pipe(
      Effect.provideService(KeyMailbox, deliveryMailbox(remote)),
      Effect.provide(
        sqliteDeliveryOutbox({ path: file, mode: mode === 'resume' ? 'open' : 'create' })
      )
    )
  );
  if (result.outcome !== 'Stored') throw new Error('not observed');
  writeSync(1, Buffer.from(result.frame).toString('hex'));
} finally {
  host.close();
}
