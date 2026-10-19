import { TestClock } from 'effect/testing';
import { Cause, Clock, Effect, Exit, Scope, Stream, SubscriptionRef } from 'effect';
import { RepoIOError, type NativeTransportRoom, type RoomTarget } from 'loro-repo/effect';
import type { StreamsTransport } from 'loro-repo/effect/streams';
import type { TransportSubscription } from 'loro-repo';
import type {
  WorkspaceRepoLegacy,
  NativeWorkspaceTransport,
} from '../src/workspace-data/repo-legacy';

/** Exercise the published native transport with the real Repo's replica leases. */
export const nativeTransportHarness = (
  repo: WorkspaceRepoLegacy,
  specification: NativeWorkspaceTransport<StreamsTransport>
) => {
  const scope = Scope.makeUnsafe();
  let started: Promise<StreamsTransport> | undefined;
  const testClock = Effect.runPromise(
    TestClock.make().pipe(Effect.provideService(Scope.Scope, scope))
  );
  const rooms = new Map<string, Promise<NativeTransportRoom>>();
  const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
    testClock.then((clock) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(Clock.Clock, clock)
        )
      )
    );
  const start = () =>
    (started ??= run(
      Effect.gen(function* () {
        const value = yield* specification.make('test-streams');
        yield* value.connect;
        return value;
      })
    ));
  const getRoom = (target: RoomTarget) => {
    const key = JSON.stringify(target);
    let value = rooms.get(key);
    if (!value) {
      value = start().then((transport) =>
        run(
          Effect.gen(function* () {
            const replica =
              target.kind === 'doc'
                ? { kind: 'doc' as const, lease: yield* repo.native.acquireDoc(target.id) }
                : {
                    kind: target.kind,
                    lease: yield* target.kind === 'meta'
                      ? repo.native.acquireMetaReplica
                      : repo.native.acquireFlockDoc(target.id),
                  };
            return yield* transport.join(target, replica);
          })
        )
      );
      rooms.set(key, value);
    }
    return value;
  };
  const originalFailure = (value: unknown, depth = 0): unknown => {
    if (depth > 15 || typeof value !== 'object' || value === null) return value;
    if ('streamsCode' in value) return { ...value, message: `Streams ${value.streamsCode}` };
    if ('transport' in value) return value.transport;
    if ('fullCause' in value) return originalFailure(value.fullCause, depth + 1);
    if ('failure' in value) return originalFailure(value.failure, depth + 1);
    if ('effectCause' in value) return originalFailure(value.effectCause, depth + 1);
    if ('reasons' in value && Array.isArray(value.reasons)) {
      const reason: unknown = value.reasons[0];
      if (typeof reason === 'object' && reason !== null && 'error' in reason)
        return originalFailure(reason.error, depth + 1);
    }
    return value;
  };
  const sync = async (target: RoomTarget) => {
    try {
      const value = await getRoom(target);
      const result = await run(value.sync);
      return { ok: result === 'confirmed', error: undefined as unknown };
    } catch (error) {
      return { ok: false, error: originalFailure(error) };
    }
  };
  return {
    uploadSnapshot: (target: RoomTarget) =>
      start().then((value) => run(value.uploadSnapshot(target))),
    health: () => start().then((value) => run(value.health({ kind: 'doc', id: 'doc-a' }))),
    advance: async (ms: number) => {
      await testClock.then((clock) => Effect.runPromise(clock.adjust(ms)));
    },
    syncMeta: (_flock: unknown) => sync({ kind: 'meta' }),
    syncDoc: (id: string, _doc: unknown) => sync({ kind: 'doc', id }),
    syncFlockDoc: (id: string, _flock: unknown) => sync({ kind: 'flock', id }),
    joinDocRoom: (id: string, _doc: unknown): TransportSubscription => {
      const target: RoomTarget = { kind: 'doc', id };
      const ready = getRoom(target);
      const firstSyncedWithRemote = ready
        .then((room) => run(room.sync))
        .then((result) => {
          if (result !== 'confirmed') throw new RepoIOError('test transport offline', undefined);
        });
      let status: TransportSubscription['status'] = 'connecting';
      const listeners = new Set<(status: TransportSubscription['status']) => void>();
      const observe = ready.then((room) =>
        run(
          Stream.runForEach(
            room.state
              ? SubscriptionRef.changes(room.state).pipe(
                  Stream.map((state): TransportSubscription['status'] =>
                    state.connection === 'joined'
                      ? 'joined'
                      : state.connection === 'failed'
                        ? 'error'
                        : state.connection === 'offline' || state.connection === 'detached'
                          ? 'disconnected'
                          : state.baseline
                            ? 'reconnecting'
                            : 'connecting'
                  )
                )
              : SubscriptionRef.changes(room.status).pipe(
                  Stream.map((next): TransportSubscription['status'] =>
                    next === 'synced'
                      ? 'joined'
                      : next === 'failed'
                        ? 'error'
                        : next === 'offline'
                          ? 'disconnected'
                          : 'connecting'
                  )
                ),
            (next) =>
              Effect.sync(() => {
                status = next;
                for (const listener of listeners) listener(status);
              })
          ).pipe(Effect.forkIn(scope))
        )
      );
      void observe.catch(() => undefined);
      return {
        firstSyncedWithRemote,
        waitUntilSynced: () => ready.then((room) => run(room.sync)).then(() => undefined),
        rejoin: async () => {
          const value = await start();
          if (value.reconnect) await run(value.reconnect);
        },
        unsubscribe: () => {
          void ready.then((room) => run(room.close));
        },
        get status() {
          return status;
        },
        onStatusChange: (listener) => {
          listeners.add(listener);
          listener(status);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    },
    close: async () => {
      const exits = await Promise.all(
        [...rooms.values()].map(async (pending) => {
          const room = await pending.catch(() => undefined);
          return room ? Effect.runPromiseExit(room.close) : Exit.void;
        })
      );
      const acquired = started && (await started.catch(() => undefined));
      if (acquired) await run(acquired.disconnect);
      await run(Scope.close(scope, Exit.void));
      const failures = exits.filter(Exit.isFailure);
      if (failures.length)
        throw new Error(Cause.pretty(failures.map((exit) => exit.cause).reduce(Cause.combine)));
    },
  };
};
