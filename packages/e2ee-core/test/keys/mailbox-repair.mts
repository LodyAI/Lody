import { workerData, parentPort } from 'node:worker_threads';
import { Effect, Result } from 'effect';
import { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { envelopeFixture } from './fixture';
const state = new Int32Array(workerData.signal);
try {
  const f = envelopeFixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* makeSqliteKeyMailbox({
          path: workerData.file,
          mode: 'open',
          genesis: f.context.genesis,
          ledger: f.ledger,
        });
        const recipient = Result.getOrThrow(host.bind(f.phone.publicKey));
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              parentPort!.once('message', () => resolve());
              Atomics.store(state, 0, 1);
              Atomics.notify(state, 0);
            })
        );
        for (const [index, digest] of workerData.digests.entries())
          yield* recipient.repair(workerData.target, `parallel-repair-${index}`, digest);
      })
    )
  );
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1);
} catch (error) {
  console.error(error);
  Atomics.store(state, 0, -1);
  Atomics.notify(state, 0);
  Atomics.store(state, 1, -1);
  Atomics.notify(state, 1);
  process.exitCode = 1;
}
