import { Cause, Context, Data, Deferred, Effect, Exit, Layer, Queue } from 'effect';
import type { LocalLoroDataPlaneServerConnection } from '../local-loro-data-plane-server';
import type { LocalLoroDataPlaneServerMessage } from '../local-loro-data-plane';

/** A real host turn, not just a fiber yield. Injected once by the application. */
export class LocalLoroWriterTurn extends Context.Service<
  LocalLoroWriterTurn,
  {
    readonly next: Effect.Effect<void>;
  }
>()('@lody/shared/LocalLoroWriterTurn') {}

export class LocalLoroWriterReleaseFailed extends Data.TaggedError('LocalLoroWriterReleaseFailed')<{
  readonly fullCause: Cause.Cause<unknown>;
  readonly retry: Effect.Effect<void, LocalLoroWriterReleaseFailed>;
}> {}

export type LocalLoroWriterOwner = {
  active: boolean;
  running: Deferred.Deferred<void> | null;
  receipt: Deferred.Deferred<void, LocalLoroWriterReleaseFailed> | null;
  failure: Cause.Cause<unknown> | null;
};
export const makeLocalLoroWriterOwner = (): LocalLoroWriterOwner => ({
  active: true,
  running: null,
  receipt: null,
  failure: null,
});

export type LocalLoroWriterTask = {
  readonly owner: LocalLoroWriterOwner;
  readonly key?: string;
  readonly roomKey?: string;
  readonly build: Effect.Effect<LocalLoroDataPlaneServerMessage[], unknown>;
  readonly valid: () => boolean;
  readonly onCause: (cause: Cause.Cause<unknown>) => void;
};

type Writer = {
  connection: LocalLoroDataPlaneServerConnection;
  lanes: Map<LocalLoroWriterOwner, Lane>;
  parked: Lane[];
  blocked: boolean;
  closed: boolean;
  release: LocalLoroWriterOwner;
  unsubscribe: (() => void) | null;
};
// Preserve each workspace's frame order while sharing physical socket flow
// control. All task kinds use this one lane, including presence and monitor.
type Lane = {
  writer: Writer;
  owner: LocalLoroWriterOwner;
  queue: LocalLoroWriterTask[];
  keys: Set<string>;
  frames: LocalLoroDataPlaneServerMessage[];
  task: LocalLoroWriterTask | null;
  ready: boolean;
};

export type LocalLoroWriterApi = {
  /** Synchronous admission only; the owned fiber executes all work. */
  readonly offer: (
    connection: LocalLoroDataPlaneServerConnection,
    task: LocalLoroWriterTask
  ) => void;
  readonly dropRoom: (owner: LocalLoroWriterOwner, roomKey: string) => void;
  readonly revoke: (owner: LocalLoroWriterOwner) => void;
  readonly closeOwner: (
    owner: LocalLoroWriterOwner
  ) => Effect.Effect<void, LocalLoroWriterReleaseFailed>;
  readonly disconnect: (connectionId: string) => Effect.Effect<void, LocalLoroWriterReleaseFailed>;
  readonly close: Effect.Effect<void, LocalLoroWriterReleaseFailed>;
};
export class LocalLoroWriter extends Context.Service<LocalLoroWriter, LocalLoroWriterApi>()(
  '@lody/shared/LocalLoroWriter'
) {}

/** One process/application FIFO pacer and one flow-control owner per socket. */
export const makeLocalLoroWriter = Effect.gen(function* () {
  const turn = yield* LocalLoroWriterTurn;
  const ready = yield* Queue.make<Lane>();
  const writers = new Map<string, Writer>();
  const applicationOwner = makeLocalLoroWriterOwner();
  let stopping = false;

  const runnable = (lane: Lane) =>
    lane.owner.active &&
    !lane.writer.closed &&
    !lane.writer.blocked &&
    (lane.frames.length > 0 || lane.queue.length > 0);
  const request = (lane: Lane) => {
    if (
      stopping ||
      lane.ready ||
      !lane.owner.active ||
      lane.writer.closed ||
      (lane.frames.length === 0 && lane.queue.length === 0)
    )
      return;
    lane.ready = true;
    Queue.offerUnsafe(ready, lane);
  };
  const revoke = (owner: LocalLoroWriterOwner) => {
    owner.active = false;
    for (const writer of writers.values()) {
      const lane = writer.lanes.get(owner);
      if (!lane) continue;
      lane.queue.length = 0;
      lane.frames.length = 0;
      lane.keys.clear();
    }
  };
  const attemptRelease = Effect.fnUntraced(function* (
    owner: LocalLoroWriterOwner,
    body: Effect.Effect<void, unknown>
  ): Effect.fn.Return<void, LocalLoroWriterReleaseFailed> {
    if (owner.receipt) return yield* Deferred.await(owner.receipt);
    const receipt = Deferred.makeUnsafe<void, LocalLoroWriterReleaseFailed>();
    owner.receipt = receipt;
    const result = yield* body.pipe(Effect.exit);
    const exit = Exit.isFailure(result)
      ? Exit.fail(
          new LocalLoroWriterReleaseFailed({
            fullCause: owner.failure ?? result.cause,
            retry: attemptRelease(owner, body),
          })
        )
      : Exit.void;
    owner.failure = Exit.isFailure(result) ? (owner.failure ?? result.cause) : null;
    Deferred.doneUnsafe(receipt, exit);
    owner.receipt = null;
    return yield* exit;
  }, Effect.uninterruptible);
  // Bound the observer, not the raw SDK producer. Recovery reuses its latch.
  // interruptible is intentional: this also bounds a Scope finalizer's wait.
  const waitRunning = (owner: LocalLoroWriterOwner) =>
    Effect.suspend(() =>
      Effect.interruptible(owner.running ? Deferred.await(owner.running) : Effect.void).pipe(
        Effect.timeout('5 seconds')
      )
    );

  const pump = Effect.fnUntraced(function* (lane: Lane) {
    if (!runnable(lane)) return;
    const writer = lane.writer;
    if (lane.frames.length === 0) {
      const task = lane.queue.shift();
      if (!task) return;
      if (task.key) lane.keys.delete(task.key);
      if (!task.valid()) return;
      lane.task = task;
      const done = Deferred.makeUnsafe<void>();
      task.owner.running = done;
      writer.release.running = done;
      yield* task.build.pipe(
        Effect.exit,
        Effect.flatMap((result) =>
          Effect.sync(() => {
            if (Exit.isFailure(result)) task.onCause(result.cause);
            else if (!writer.closed && task.owner.active && task.valid())
              lane.frames = result.value;
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            task.owner.running = null;
            writer.release.running = null;
            Deferred.doneUnsafe(done, Effect.void);
          })
        )
      );
    }
    const task = lane.task;
    if (!task || !task.owner.active || !task.valid() || writer.closed) {
      lane.frames.length = 0;
      return;
    }
    const frame = lane.frames.shift();
    if (!frame) return;
    // Write and latch backpressure together, with no async gap.
    const sent = yield* Effect.sync(() => writer.connection.send(frame)).pipe(Effect.exit);
    if (Exit.isFailure(sent)) task.onCause(sent.cause);
    else if (sent.value === false && writer.unsubscribe) writer.blocked = true;
  });
  const worker = yield* Effect.gen(function* () {
    for (;;) {
      if (stopping) return;
      const lane = yield* Queue.take(ready);
      if (lane.writer.blocked && !lane.writer.closed) {
        lane.writer.parked.push(lane);
        continue;
      }
      yield* turn.next;
      lane.ready = false;
      yield* pump(lane);
      // FIFO rotation also applies to remaining chunks on the same socket.
      request(lane);
    }
  }).pipe(Effect.forkDetach);
  // Explicit owner: automatic Scope joining would defeat the observer bound
  // when a raw SDK Promise is non-cooperative. Keep the producer after expiry.
  applicationOwner.running = Deferred.makeUnsafe<void>();
  worker.addObserver(() => {
    if (applicationOwner.running) Deferred.doneUnsafe(applicationOwner.running, Effect.void);
    applicationOwner.running = null;
  });

  const disconnect: LocalLoroWriterApi['disconnect'] = (id) =>
    Effect.suspend(() => {
      const writer = writers.get(id);
      if (!writer) return Effect.void;
      return attemptRelease(
        writer.release,
        Effect.gen(function* () {
          writer.closed = true;
          writer.parked.length = 0;
          for (const lane of writer.lanes.values()) {
            lane.queue.length = 0;
            lane.frames.length = 0;
            lane.keys.clear();
          }
          yield* Effect.sync(() => {
            writer.unsubscribe?.();
            writer.unsubscribe = null;
          });
          yield* waitRunning(writer.release);
          if (writers.get(id) === writer) writers.delete(id);
        })
      );
    });
  const closeOwner: LocalLoroWriterApi['closeOwner'] = (owner) =>
    attemptRelease(
      owner,
      Effect.gen(function* () {
        revoke(owner);
        yield* waitRunning(owner);
        for (const writer of writers.values()) {
          writer.lanes.delete(owner);
          if (writer.lanes.size === 0) yield* disconnect(writer.connection.id);
        }
      })
    );
  const close = attemptRelease(
    applicationOwner,
    Effect.gen(function* () {
      stopping = true;
      worker.interruptUnsafe();
      const exits = yield* Effect.forEach([...writers.keys()], (id) =>
        disconnect(id).pipe(Effect.exit)
      );
      const joined = yield* waitRunning(applicationOwner).pipe(Effect.exit);
      let failure: Cause.Cause<unknown> = Exit.isFailure(joined) ? joined.cause : Cause.empty;
      for (const exit of exits)
        if (Exit.isFailure(exit)) failure = Cause.combine(failure, exit.cause);
      if (failure.reasons.length > 0) return yield* Effect.failCause(failure);
      return yield* Queue.shutdown(ready).pipe(Effect.asVoid);
    })
  );
  yield* Effect.addFinalizer(() =>
    close.pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(
          Cause.fromReasons<never>(
            cause.reasons.map((reason) =>
              Cause.isFailReason(reason)
                ? Cause.makeDieReason(reason.error).annotate(Context.makeUnsafe(reason.annotations))
                : reason
            )
          )
        )
      )
    )
  );

  return LocalLoroWriter.of({
    offer: (connection, task) => {
      if (stopping || !task.owner.active) return;
      let writer = writers.get(connection.id);
      if (writer?.closed) throw new Error('local_loro_writer_release_pending');
      if (writer && writer.connection !== connection)
        throw new Error('local_loro_writer_connection_conflict');
      if (!writer) {
        writer = {
          connection,
          lanes: new Map(),
          parked: [],
          blocked: false,
          closed: false,
          release: makeLocalLoroWriterOwner(),
          unsubscribe: null,
        };
        const acquired = writer;
        writer.unsubscribe =
          connection.onDrain?.(() => {
            acquired.blocked = false;
            for (const lane of acquired.parked.splice(0)) Queue.offerUnsafe(ready, lane);
            for (const lane of acquired.lanes.values()) request(lane);
          }) ?? null;
        writers.set(connection.id, writer);
      }
      let lane = writer.lanes.get(task.owner);
      if (!lane) {
        lane = {
          writer,
          owner: task.owner,
          queue: [],
          keys: new Set(),
          frames: [],
          task: null,
          ready: false,
        };
        writer.lanes.set(task.owner, lane);
      }
      if (task.key) {
        if (lane.keys.has(task.key)) return;
        lane.keys.add(task.key);
      }
      lane.queue.push(task);
      request(lane);
    },
    dropRoom: (owner, roomKey) => {
      for (const writer of writers.values()) {
        const lane = writer.lanes.get(owner);
        if (!lane) continue;
        lane.queue = lane.queue.filter((task) => {
          if (task.roomKey !== roomKey) return true;
          if (task.key) lane.keys.delete(task.key);
          return false;
        });
        if (lane.task?.roomKey === roomKey) lane.frames.length = 0;
      }
    },
    revoke,
    closeOwner,
    disconnect,
    close,
  });
});
export const LocalLoroWriterLive = Layer.effect(LocalLoroWriter, makeLocalLoroWriter);
