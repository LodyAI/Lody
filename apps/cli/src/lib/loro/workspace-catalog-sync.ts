import { Cause, Deferred, Effect, Exit, Fiber, Queue, Schedule, Stream } from 'effect';
import type { LoroRepo, RepoFlockDocLease, RepoRoomSubscription } from 'loro-repo';
import { getWorkspaceFlockDocId, type WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { STREAMS_TRANSPORT_ID } from './streams-room-binding';

const reportFailure = (logger: Logger, workspaceId: WorkspaceId) => {
  try {
    // SDK failures may contain credentials; keep raw failures out of diagnostics.
    logger.debug(`[${workspaceId}] Catalog reader acquisition/baseline/cleanup failed`);
  } catch {
    // Diagnostics cannot interrupt resource recovery.
  }
};

/** Genuine external SDK adapter. Promise Repo joins do not accept cancellation. */
const acquireCatalogRoom = Effect.fnUntraced(function* (
  repo: LoroRepo,
  id: string | undefined,
  workspaceId: WorkspaceId,
  logger: Logger
) {
  const pending = yield* Effect.acquireRelease(
    Effect.sync(() => {
      let closed = false;
      let replica: RepoFlockDocLease | undefined;
      let room: RepoRoomSubscription | undefined;
      const release = async () => {
        const releasingRoom = room;
        const releasingReplica = replica;
        room = undefined;
        replica = undefined;
        // A failing room release must not skip the independent replica lease.
        const results = await Promise.allSettled([
          Promise.resolve().then(() => releasingRoom?.unsubscribe()),
          Promise.resolve().then(() => releasingReplica?.release()),
        ]);
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (errors.length) throw new AggregateError(errors, 'Catalog reader release failed');
      };
      const promise = (async () => {
        if (id !== undefined) {
          replica = await repo.acquireFlockDoc(id);
          if (closed) {
            await release();
            return undefined;
          }
        }
        room = await (id === undefined ? repo.joinMetaRoom() : repo.joinFlockDocRoom(id));
        if (closed) {
          await release();
          return undefined;
        }
        return room;
      })().catch((error: unknown) => {
        if (closed) reportFailure(logger, workspaceId);
        throw error;
      });
      return {
        promise,
        close: () => {
          closed = true;
          // Do not await an unabortable acquisition. Its continuation still owns
          // and releases late results. The same Repo remains the terminal owner.
          return release();
        },
      };
    }),
    (resource) => Effect.promise(resource.close)
  );
  return yield* Effect.tryPromise({ try: () => pending.promise, catch: (cause) => cause });
});

/** Observe the stable Streams binding across detach/reattach without syncing it. */
const firstBaseline = (room: RepoRoomSubscription, workspaceId: WorkspaceId, logger: Logger) => {
  const binding = room.subscription(STREAMS_TRANSPORT_ID);
  return Stream.callback<void>(
    Effect.fnUntraced(function* (queue) {
      yield* Effect.acquireRelease(
        Effect.sync(() => binding.onStatusChange(() => Queue.offerUnsafe(queue, undefined))),
        (unsubscribe) => Effect.sync(unsubscribe)
      );
      yield* Queue.offer(queue, undefined);
    }),
    { bufferSize: 1, strategy: 'sliding' }
  ).pipe(
    Stream.mapEffect(() =>
      Effect.promise((signal) => binding.waitFor({ phase: 'caught-up', signal })).pipe(
        // A failed hydration/persistence barrier is a tagged result, not a rejection.
        // Retry only the barrier on this stable binding, retaining both reader leases.
        Effect.flatMap((result) =>
          result.status === 'error' ? Effect.fail(result.error) : Effect.succeed(result)
        ),
        Effect.tapError(() => Effect.sync(() => reportFailure(logger, workspaceId))),
        Effect.retry({
          schedule: Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('30 seconds')]),
        })
      )
    ),
    Stream.filter((result) => result.status === 'complete'),
    Stream.take(1),
    Stream.runDrain
  );
};

export interface WorkspaceCatalogSync {
  hold: (flockDocId: string) => Effect.Effect<void>;
  /** Undefined selects metadata. Timeout affects only this waiter. */
  ready: (flockDocId: string | undefined, timeoutMs: number) => Effect.Effect<boolean>;
}

export const makeWorkspaceCatalogSync = Effect.fnUntraced(function* (
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  logger: Logger,
  requireRemoteBaseline = true
) {
  const scope = yield* Effect.scope;
  type Entry = {
    baseline: boolean;
    ready: Deferred.Deferred<boolean>;
    fiber?: Fiber.Fiber<void, unknown>;
  };
  const held = new Map<string | undefined, Entry>();
  // Registered before reader fibers: Scope interrupts every sibling first, then
  // this receipt observes their actual exits. forkIn alone discards those exits.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const exits = yield* Effect.forEach(held.values(), (entry) =>
        entry.fiber ? Fiber.await(entry.fiber) : Effect.succeed(Exit.void)
      );
      const reasons = exits.flatMap((exit) =>
        Exit.isFailure(exit)
          ? exit.cause.reasons.filter((reason) => reason._tag !== 'Interrupt')
          : []
      );
      for (const entry of held.values()) yield* Deferred.succeed(entry.ready, false);
      if (reasons.length)
        yield* Effect.die(
          new Error('Catalog reader cleanup failed', {
            cause: Cause.fromReasons(reasons),
          })
        );
    })
  );
  const ensure = Effect.fnUntraced(function* (id: string | undefined) {
    const prior = held.get(id);
    if (prior) return prior;
    const entry: Entry = { baseline: false, ready: Deferred.makeUnsafe<boolean>() };
    held.set(id, entry);
    const reader = Effect.scoped(
      Effect.gen(function* () {
        const room = yield* acquireCatalogRoom(repo, id, workspaceId, logger);
        if (!room) return;
        if (requireRemoteBaseline) yield* firstBaseline(room, workspaceId, logger);
        entry.baseline = true;
        yield* Deferred.succeed(entry.ready, true);
        yield* Effect.never;
      })
    ).pipe(
      Effect.tapError(() => Effect.sync(() => reportFailure(logger, workspaceId))),
      // A rejected Promise join has released its room reference in Repo 0.23.2.
      // Release defects remain defects and never start a replacement reader.
      Effect.retry({
        schedule: Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('30 seconds')]),
      })
    );
    entry.fiber = yield* Effect.forkIn(reader, scope);
    return entry;
  });
  const hold = (id: string) => ensure(id).pipe(Effect.asVoid);
  const ready = Effect.fnUntraced(function* (id: string | undefined, timeoutMs: number) {
    const entry = yield* ensure(id);
    if (entry.baseline) return true;
    if (timeoutMs <= 0) return false;
    return yield* Deferred.await(entry.ready).pipe(
      Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(false) })
    );
  });
  yield* ensure(undefined);
  yield* hold(getWorkspaceFlockDocId(workspaceId));
  return { hold, ready } satisfies WorkspaceCatalogSync;
});
