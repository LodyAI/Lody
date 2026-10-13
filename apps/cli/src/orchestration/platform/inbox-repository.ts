import { Effect, Layer } from 'effect';
import { InboxRepository } from '../inbox/service';
import type { InboxSqlite } from '../inbox/sqlite';
import { OrchestrationStorageFailure } from '../storage-error';
type Repository = InboxRepository['Service'];
export const inboxRepositoryLayer = (sql: InboxSqlite, ownedConnection = false) => {
  const io = <A>(f: () => A) =>
    Effect.try({ try: f, catch: (cause) => new OrchestrationStorageFailure(cause) });
  const repository: Repository = {
    abandon: (w, s, id) => io(() => sql.abandonInput(w, s, id)),
    deactivate: (w, o) => io(() => sql.deactivate(w, o)),
    cancelExecution: (scope, id) => io(() => sql.cancelExecution(scope, id)),
    adopt: (p, n, id) => io(() => sql.adoptExecution(p, n, id)),
    canSubmit: (s, id, o) => io(() => sql.canSubmit(s, id, o)),
    accept: (i) => io(() => sql.accept(i)),
    begin: (s, id, owner) => io(() => sql.begin(s, id, owner)),
    pause: (s, id, ids, cancelId) => io(() => sql.pause(s, id, ids, cancelId)),
    release: (e) => io(() => sql.release(e)),
    prepare: (i, o, id) => io(() => sql.prepare(i, o, id)),
    fence: (b, id) => io(() => sql.fence(b, id)),
    pending: (w) => io(() => sql.pending(w)),
    settle: (b, o, c) => io(() => sql.settle(b, o, c)),
  };
  return ownedConnection
    ? Layer.effect(
        InboxRepository,
        Effect.acquireRelease(Effect.succeed(repository), () =>
          io(() => sql.closeConnection()).pipe(Effect.orDie)
        )
      )
    : Layer.succeed(InboxRepository, repository);
};

export const recoveryRepositoryLayer = (open: () => { sql: InboxSqlite; close(): void }) =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.try({ try: open, catch: (cause) => new OrchestrationStorageFailure(cause) }),
      (store) => Effect.sync(() => store.close())
    ).pipe(Effect.map((store) => inboxRepositoryLayer(store.sql)))
  );
