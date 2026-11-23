import { Effect, Result } from 'effect';
import { makeSqliteMailboxRepair } from './harness';
import { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { envelopeFixture } from './fixture';
const f = envelopeFixture(),
  dir = process.argv[2]!;
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeSqliteKeyMailbox({
        path: dir + '/mailbox.sqlite',
        mode: 'open',
        genesis: f.context.genesis,
        ledger: f.ledger,
      });
      const remote = Result.getOrThrow(host.bind(f.phone.publicKey));
      const queue = yield* makeSqliteMailboxRepair({
        path: dir + '/repair.sqlite',
        mode: 'open',
        genesis: f.context.genesis,
        recipient: f.phone.publicKey,
        ledger: f.ledger,
        remote,
      });
      const batch = yield* queue.flush();
      const status = yield* remote.status({
        genesis: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
        epoch: 0,
        recipient: Buffer.from(f.phone.raw).toString('hex'),
      });
      return {
        pid: process.pid,
        batch,
        revision: status.revision,
        results: yield* queue.results(),
      };
    })
  )
);
console.log(JSON.stringify(result));
