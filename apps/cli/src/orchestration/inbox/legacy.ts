import { Effect, Exit, Layer, ManagedRuntime } from 'effect';
import { executionMembersLayer } from '../platform/execution-members';
import { makeInboxQueries } from '../platform/inbox-queries';
import { inboxRepositoryLayer, recoveryRepositoryLayer } from '../platform/inbox-repository';
import { makeInboxCloseOwner } from './close-owner';
import { makeExecutionOwner, type ExecutionResource } from './execution-owner';
import type { InboxBatch, InboxInput, InboxRelease, InboxScope } from './model';
import { InboxExecution, InboxRepository, OperationInbox } from './service';
import type { InboxSqlite } from './sqlite';

export type OperationInboxLegacy = ReturnType<typeof operationInboxLegacy>;
/** One host-lease bridge. Consumers: coordinator; dispatch, Stop, prompt and release hooks. */
export const operationInboxLegacy = (options: {
  workspaceId: string;
  owner: string;
  sql: InboxSqlite;
  ownsConnection?: boolean;
  ready(batch: InboxBatch): boolean;
  admit(batch: InboxBatch): boolean;
  launch(batch: InboxBatch): Promise<void>;
  report(cause: unknown): void;
  quiesce?(): void;
  openRecoveryRepository?(): { sql: InboxSqlite; close(): void };
}) => {
  const queries = makeInboxQueries(options.sql);
  const dependencies = Layer.merge(
    Layer.merge(
      inboxRepositoryLayer(options.sql, options.ownsConnection !== false),
      executionMembersLayer(options.sql)
    ),
    Layer.succeed(InboxExecution, {
      ready: options.ready,
      quiesce: options.quiesce,
      admit: options.admit,
      launch: (batch) =>
        Effect.tryPromise({ try: () => options.launch(batch), catch: (cause) => cause }),
      report: (cause) => Effect.sync(() => options.report(cause)),
    })
  );
  const runtime = ManagedRuntime.make(
    OperationInbox.layer(options.workspaceId, options.owner).pipe(Layer.provideMerge(dependencies))
  );
  const service = runtime.runPromise(OperationInbox);
  void service.catch(options.report);
  let shutdown: Promise<void> | undefined;
  let recoveredClose: Promise<void> | undefined;
  const closeOwner = Effect.runSync(
    makeInboxCloseOwner({
      dispose: runtime.disposeEffect,
      recover: Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* Effect.tryPromise({ try: () => service, catch: (cause) => cause });
          const repository = yield* InboxRepository;
          yield* inbox.recoverSettlements(repository.settle, repository.release, repository.pause);
        }).pipe(
          Effect.provide(
            recoveryRepositoryLayer(() => {
              const store = options.openRecoveryRepository?.();
              if (!store) throw new Error('Inbox recovery repository is unavailable');
              return store;
            })
          )
        )
      ),
    })
  );
  const runClose = (program: Effect.Effect<void, unknown>, message: string) =>
    Effect.runPromiseExit(program).then((exit) => {
      if (Exit.isFailure(exit)) throw new Error(message, { cause: exit.cause });
    });
  return {
    activeExecution: (w: string, s: string) => Effect.runSync(queries.activeExecution(w, s)),
    preferredHumanInput: (w: string, s: string) =>
      Effect.runSync(queries.preferredHumanInput(w, s)),
    inputCancellationReason: (w: string, s: string, id: string) =>
      Effect.runSync(queries.inputCancellationReason(w, s, id)),
    inputEnded: (w: string, s: string, id: string) => Effect.runSync(queries.inputEnded(w, s, id)),
    inputCanceled: (w: string, s: string, id: string) =>
      Effect.runSync(queries.inputCanceled(w, s, id)),
    inputKind: (s: InboxScope, id: string) => Effect.runSync(queries.inputKind(s, id)),
    pauseTarget: (w: string, s: string, id: string) =>
      Effect.runSync(queries.pauseTarget(w, s, id)),
    abandonInput: (w: string, s: string, id: string, unlessActive?: boolean) =>
      runtime.runPromise(
        Effect.flatMap(OperationInbox, (inbox) => inbox.abandon(w, s, id, unlessActive))
      ),
    openExecution: async (input: InboxInput, id: string, batch?: InboxBatch) => {
      const owner = await runtime.runPromise(makeExecutionOwner(input, id, batch));
      return {
        get input() {
          return owner.input;
        },
        get batch() {
          return owner.batch;
        },
        id,
        get failure() {
          return owner.failure;
        },
        members: () => runtime.runPromise(owner.members),
        adopt: (next: InboxInput, update: () => void) =>
          runtime.runPromise(owner.adopt(next, update)),
        register: (resource: ExecutionResource) => runtime.runSync(owner.register(resource)),
        track: (raw: Promise<void>) =>
          runtime.runSync(
            owner.track(Effect.tryPromise({ try: () => raw, catch: (cause) => cause }))
          ),
        steer: <A>(start: () => A) => runtime.runPromise(owner.steer(start)),
        submit: <A>(start: () => A) => runtime.runPromise(owner.submit(start)),
        finish: (outcome: InboxRelease['outcome'], cause?: unknown) =>
          runtime.runPromise(owner.finish(outcome, cause)),
        withdraw: () => runtime.runPromise(owner.withdraw),
        recover: (prepare: () => Promise<void>, beforeRelease: () => Promise<void>) =>
          runtime.runPromise(
            owner
              .recover(
                Effect.tryPromise({ try: prepare, catch: (cause) => cause }),
                Effect.tryPromise({ try: beforeRelease, catch: (cause) => cause })
              )
              .pipe(Effect.timeout('5 seconds'))
          ),
      };
    },
    quiesce: () => runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.quiesce)),
    cancelExecution: (scope: InboxScope, id: string, reason?: 'user_stop') =>
      runtime.runPromise(
        Effect.flatMap(OperationInbox, (i) => i.cancelExecution(scope, id, reason))
      ),
    wake: () => runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.wake)),
    accept: (input: InboxInput) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.accept(input))),
    pause: (scope: InboxScope, id: string, ids?: readonly string[], cancelId?: string) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.pause(scope, id, ids, cancelId))),
    release: (event: InboxRelease) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.release(event))),
    settleUnknown: (batch: InboxBatch) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.settle(batch, 'unknown'))),
    recoverClose: () => {
      if (recoveredClose) return recoveredClose;
      const attempt = runClose(closeOwner.recover, 'Inbox Scope recovery failed');
      recoveredClose = attempt;
      void attempt.catch(() => {
        if (recoveredClose === attempt) recoveredClose = undefined;
      });
      return attempt;
    },
    close: () =>
      recoveredClose ?? (shutdown ??= runClose(closeOwner.close, 'Inbox Scope release failed')),
  };
};
