import { Deferred, Effect, Exit, Schedule, Stream, type Fiber } from 'effect';
import {
  RepoReleaseFailed,
  type Repo,
  type RepoError,
  type RoomLease,
  type RoomTarget,
} from 'loro-repo/effect';
import { getWorkspaceFlockDocId, type WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';

/** Reader acquisition/recovery has daemon ownership, independent of request waits. */
const catalogReader = (
  repo: Repo,
  workspaceId: WorkspaceId,
  logger: Logger,
  target: RoomTarget,
  onRoom: (room: RoomLease) => Effect.Effect<void> = () => Effect.void
) => {
  const holdRoom = Effect.scoped(
    Effect.gen(function* () {
      const room = yield* repo.acquireRoom(target);
      yield* onRoom(room);
      yield* Effect.never;
    })
  ).pipe(
    Effect.tapCause((cause) =>
      // Raw adapter Causes stay on the fiber/native owner, never in diagnostics.
      Effect.sync(() =>
        logger.debug(
          `[${workspaceId}] Catalog reader failed: ${cause.reasons
            .map((reason) => (reason._tag === 'Fail' ? reason.error._tag : reason._tag))
            .join(', ')}`
        )
      ).pipe(Effect.catchCause(() => Effect.void))
    ),
    // Retry the whole Cause only when native ownership makes same-key reentry
    // safe. Native acquireRoom retries retained RepoReleaseFailed receipts before
    // replacing them; an arbitrary cleanup defect must still stop replacement.
    Effect.exit,
    Effect.flatMap((exit) => (Exit.isFailure(exit) ? Effect.fail(exit.cause) : Effect.void)),
    Effect.retry({
      while: (cause) =>
        cause.reasons.every((reason) =>
          reason._tag === 'Fail'
            ? reason.error._tag === 'RepoIOError' ||
              reason.error._tag === 'RepoResourceBusy' ||
              reason.error instanceof RepoReleaseFailed
            : reason._tag === 'Die' && reason.defect instanceof RepoReleaseFailed
        ),
      schedule: Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('30 seconds')]),
    }),
    Effect.catch((cause) => Effect.failCause(cause))
  );
  return holdRoom;
};

export const startWorkspaceCatalogSync = Effect.fnUntraced(function* (
  repo: Repo,
  workspaceId: WorkspaceId,
  logger: Logger,
  flockDocId = getWorkspaceFlockDocId(workspaceId)
) {
  return yield* Effect.forkScoped(
    catalogReader(repo, workspaceId, logger, { kind: 'flock', id: flockDocId })
  );
});

export interface WorkspaceCatalogSync {
  hold: (flockDocId: string) => Effect.Effect<void>;
  /** Undefined selects metadata. A timed-out waiter never cancels the daemon reader. */
  ready: (flockDocId: string | undefined, timeoutMs: number) => Effect.Effect<boolean>;
}

export const makeWorkspaceCatalogSync = Effect.fnUntraced(function* (
  repo: Repo,
  workspaceId: WorkspaceId,
  logger: Logger
) {
  const scope = yield* Effect.scope;
  type Entry = {
    fiber?: Fiber.Fiber<void, RepoError>;
    room?: RoomLease;
    acquired: Deferred.Deferred<void>;
    baseline: boolean;
  };
  // Full terminal Causes remain on the fiber; native Repo retains failed releases.
  const held = new Map<string | undefined, Entry>();
  const ensure = (id: string | undefined) =>
    Effect.suspend(() => {
      const prior = held.get(id);
      if (prior) return Effect.succeed(prior);
      const entry: Entry = { acquired: Deferred.makeUnsafe<void>(), baseline: false };
      held.set(id, entry);
      const target: RoomTarget = id === undefined ? { kind: 'meta' } : { kind: 'flock', id };
      return Effect.forkIn(
        catalogReader(repo, workspaceId, logger, target, (room) =>
          Effect.sync(() => {
            entry.room = room;
            Deferred.doneUnsafe(entry.acquired, Exit.void);
          })
        ),
        scope
      ).pipe(
        Effect.map((fiber) => {
          entry.fiber = fiber;
          return entry;
        })
      );
    });
  const hold = (id: string) => ensure(id).pipe(Effect.asVoid);
  const ready = Effect.fnUntraced(function* (id: string | undefined, timeoutMs: number) {
    const entry = yield* ensure(id);
    if (entry.baseline) return true;
    if (entry.room) {
      const authority = yield* entry.room.authority;
      if (authority.baseline) {
        entry.baseline = true;
        return true;
      }
    }
    if (timeoutMs <= 0) return false;
    const wait = Effect.gen(function* () {
      yield* Deferred.await(entry.acquired);
      const room = entry.room;
      if (!room) return false;
      const authority = yield* room.authority;
      if (!authority.baseline) {
        if (!authority.servers.length) yield* Effect.never;
        yield* Stream.mergeAll(
          authority.servers.map(({ id: transportId }) => room.state(transportId)),
          { concurrency: 'unbounded' }
        ).pipe(
          Stream.filter((state) => state.baseline),
          Stream.take(1),
          Stream.runDrain
        );
      }
      entry.baseline = true;
      return true;
    });
    return yield* wait.pipe(
      Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(false) })
    );
  });
  yield* ensure(undefined);
  yield* hold(getWorkspaceFlockDocId(workspaceId));
  return { hold, ready } satisfies WorkspaceCatalogSync;
});
