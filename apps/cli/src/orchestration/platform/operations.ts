import { Clock, Effect, Layer } from 'effect';
import { OperationRepository } from '../operation-repository';
import { LodyOperationStore } from '../operation-store';
import { OrchestrationStorageFailure } from '../storage-error';
import { OrchestrationDatabase } from './database';
import { inboxRepositoryLayer } from './inbox-repository';

export const operationRepositoryLayer = (store: LodyOperationStore) => {
  const io = <A>(f: () => A) =>
    Effect.try({ try: f, catch: (cause) => new OrchestrationStorageFailure(cause) });
  return Layer.succeed(OperationRepository, {
    accept: (i, o) => io(() => store.accept(i, o)),
    get: (s, id) => io(() => store.get(s, id)),
    inputCancellationReason: (w, s, id) => io(() => store.inbox.inputCancellationReason(w, s, id)),
    finish: (s, id, c) => io(() => store.finish(s, id, c)),
    updateItems: (s, id, items) => io(() => store.updateItems(s, id, items)),
    listActive: (w, m) => io(() => store.listActive(w, m)),
    listPendingProgress: (w, m) => io(() => store.listPendingProgress(w, m)),
    settleProgress: (s, id) =>
      io(() => {
        store.settleProgress(s, id);
      }),
    claimItemMaterialization: (s, id, n, t) =>
      io(() => store.claimItemMaterialization(s, id, n, t)),
    markItemInputDurable: (s, id, n, t) => io(() => store.markItemInputDurable(s, id, n, t)),
  });
};

/** Both repositories borrow one connection; only OrchestrationDatabase closes it. */
export const orchestrationRepositoriesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const connection = yield* OrchestrationDatabase;
    const clock = yield* Clock.Clock;
    const store = yield* Effect.try({
      try: () =>
        new LodyOperationStore(':memory:', () => clock.currentTimeMillisUnsafe(), { connection }),
      catch: (cause) => new OrchestrationStorageFailure(cause),
    });
    return Layer.merge(operationRepositoryLayer(store), inboxRepositoryLayer(store.inbox));
  })
);

export const ownedDatabaseLayer = (store: LodyOperationStore) =>
  Layer.effect(
    OrchestrationDatabase,
    Effect.acquireRelease(
      Effect.try({
        try: () => store.takeConnectionOwnership(),
        catch: (cause) => new OrchestrationStorageFailure(cause),
      }),
      (connection) => Effect.sync(() => connection.close())
    )
  );
