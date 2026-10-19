import { Context, Deferred, Effect, Exit, Queue, Result, Scope } from 'effect';
import { makeLabOperations } from './operation-scope';
const PhaseParent = Context.Reference<string | undefined>('Lab/PhaseParent', {
  defaultValue: () => undefined,
});
import { LabCallbackRunner } from './run';
import {
  canPermitEvent,
  completeEvent,
  emptyScheduler,
  permitEvent,
  requestEvent,
  type LabEvent,
  type SchedulerState,
} from '../pure/scheduler';
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
import { eventIdentity, identityKey, type ScheduleChoice } from '../pure/schedule';

export interface ProtocolFrame {
  readonly eventId: string;
  readonly actor: string;
  readonly operation: string;
  readonly phase: string;
  readonly url: string;
  readonly requestHex: string;
  readonly responseStatus: number;
  readonly responseHex: string;
}

/** Scoped native Effect runtime; construct through makeLabRuntime. */
class LabRuntime {
  private readonly active = new Set<Promise<unknown>>();
  private disposing = false;
  private readonly disposed = Deferred.makeUnsafe<void>();
  private scheduler: SchedulerState;
  private readonly run = new LabCallbackRunner();
  private readonly notifications = new Set<Queue.Queue<void>>();
  private readonly abort = new AbortController();
  get state(): SchedulerState {
    return this.scheduler;
  }
  private set state(next: SchedulerState) {
    this.scheduler = next;
  }

  /** Subscription is scoped. Notifications wake the driver without granting a permit. */
  changes() {
    return Effect.acquireRelease(
      Effect.gen({ self: this }, function* () {
        const queue = yield* Queue.unbounded<void>();
        this.notifications.add(queue);
        return queue;
      }),
      (queue) =>
        Effect.sync(() => {
          this.notifications.delete(queue);
          Queue.shutdownUnsafe(queue);
        })
    );
  }
  private changed(): void {
    for (const queue of this.notifications) Queue.offerUnsafe(queue, undefined);
  }

  readonly frames: ProtocolFrame[] = [];
  private readonly waiters = new Map<string, Deferred.Deferred<void, Error>>();
  private readonly requestWaiters: Array<{
    count: number;
    ready: Deferred.Deferred<void, Error>;
  }> = [];
  get schedulingMode(): 'auto' | 'manual' {
    return this.mode;
  }
  private readonly mode: 'auto' | 'manual';
  private readonly fetchImpl: typeof globalThis.fetch;
  private closed = false;
  /** Every permit, in order. Replay uses this instead of an unbounded drain. */
  readonly permitLog: ScheduleChoice[] = [];
  private readonly identityCounts = new Map<string, number>();

  constructor(
    options: LabRuntimeOptions,
    private readonly operations: Effect.Success<ReturnType<typeof makeLabOperations>>,
    private readonly nativeScope: Scope.Closeable
  ) {
    this.mode = options.mode;
    this.fetchImpl = options.fetch;
    this.scheduler = emptyScheduler(options.time);
  }

  private retain<A>(work: () => Promise<A>): Promise<A> {
    if (this.closed) return Promise.reject(new Error('runtime-closed'));
    // Register before entering borrowed work, including synchronous throws.
    const raw = Promise.resolve().then(() => {
      if (this.closed) throw new Error('runtime-closed');
      return work();
    });
    const settled = raw.then(
      () => undefined,
      () => undefined
    );
    this.active.add(settled);
    void settled.then(() => this.active.delete(settled));
    return raw;
  }

  events(): readonly LabEvent[] {
    return this.state.events;
  }

  whenRequested(count: number) {
    return Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          if (this.closed) throw new Error('runtime-closed');
          const ready = Deferred.makeUnsafe<void, Error>();
          const waiter = { count, ready };
          if (this.requestedCount() >= count) Deferred.doneUnsafe(ready, Effect.void);
          else this.requestWaiters.push(waiter);
          return waiter;
        },
        catch: (error) => error,
      }),
      (waiter) => Deferred.await(waiter.ready),
      (waiter) =>
        Effect.sync(() => {
          const index = this.requestWaiters.indexOf(waiter);
          if (index >= 0) this.requestWaiters.splice(index, 1);
        })
    );
  }

  permit(eventId: string): void {
    const next = Result.getOrThrow(permitEvent(this.state, eventId));
    this.state = next.state;
    const identity = eventIdentity(next.event, this.state.events);
    const key = identityKey(identity);
    const occurrence = this.identityCounts.get(key) ?? 0;
    this.identityCounts.set(key, occurrence + 1);
    this.permitLog.push({
      kind: 'permit',
      identity,
      occurrence,
      eventId: next.event.eventId,
    });
    this.dispatch();
  }

  complete(eventId: string): void {
    this.state = Result.getOrThrow(completeEvent(this.state, eventId));
    this.dispatch();
    this.changed();
  }

  /** Reject every pending gate and request waiter. Idempotent teardown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('runtime-closed');
    const waiters = [...this.waiters.values()];
    this.waiters.clear();
    this.abort.abort(error);
    for (const waiter of waiters) Deferred.doneUnsafe(waiter, Effect.fail(error));
    for (const waiter of this.requestWaiters.splice(0))
      Deferred.doneUnsafe(waiter.ready, Effect.fail(error));
    this.changed();
  }

  /** Effect owner closes admission, interrupts phases, awaits raw SDK settlement,
   * then releases callback Context. All callers observe the same completion. */
  disposeEffect() {
    return Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        this.close();
        if (!this.disposing) {
          this.disposing = true;
          const result = yield* Effect.exit(
            Scope.close(this.nativeScope, Exit.void).pipe(
              Effect.ensuring(Effect.promise(() => Promise.allSettled([...this.active]))),
              Effect.ensuring(Effect.promise(() => this.run.close()))
            )
          );
          yield* Deferred.done(this.disposed, result);
        }
        return yield* Deferred.await(this.disposed);
      })
    );
  }
  gateEffect(actor: string, operation: string, phase: string) {
    return Effect.acquireUseRelease(
      Effect.gen({ self: this }, function* () {
        if (this.closed) return yield* Effect.fail(new Error('runtime-closed'));
        const parent = yield* PhaseParent;
        const requested = requestEvent(this.state, { actor, operation, phase, parent });
        this.state = requested.state;
        const eventId = requested.event.eventId;
        const ready = Deferred.makeUnsafe<void, Error>();
        this.waiters.set(eventId, ready);
        this.dispatch();
        // Registration must complete before a synchronous waiter can close us.
        this.flushRequestWaiters();
        this.changed();
        return { eventId, ready };
      }),
      ({ eventId, ready }) => Deferred.await(ready).pipe(Effect.as(eventId)),
      ({ eventId }) =>
        Effect.sync(() => {
          this.waiters.delete(eventId);
        })
    );
  }
  /** Actual Fetch callback boundary, not an alternate workflow. */
  private gate(actor: string, operation: string, phase: string): Promise<string> {
    return this.run.run(this.gateEffect(actor, operation, phase));
  }

  phaseEffect<A, E, R>(
    actor: string,
    operation: string,
    phase: string,
    work: Effect.Effect<A, E, R>
  ) {
    return this.operations.run(
      Effect.gen({ self: this }, function* () {
        const eventId = yield* this.gateEffect(actor, operation, phase);
        return yield* work.pipe(
          Effect.provideService(PhaseParent, eventId),
          Effect.tap(() =>
            Effect.suspend(() =>
              this.closed ? Effect.fail(new Error('runtime-closed')) : Effect.void
            )
          ),
          Effect.ensuring(Effect.sync(() => this.complete(eventId)))
        );
      })
    );
  }

  gatedFetch(actor: string): typeof globalThis.fetch {
    return (input, init) =>
      this.retain(async () => {
        const original = new Request(input, init);
        const request = new Request(original, {
          signal: AbortSignal.any([original.signal, this.abort.signal]),
        });
        const url = request.url;
        const method = request.method.toUpperCase();
        const labPath = url.includes('/ds/') || url.includes('/append-cas');
        const content = url.includes('/loro') || url.includes('/flock');
        const reading = method === 'GET' || method === 'HEAD';
        const operation = reading ? 'read' : content ? 'content' : 'submit';
        if (!labPath) {
          const response = await this.fetchImpl(request);
          if (this.closed) throw new Error('runtime-closed');
          return response;
        }
        const requestId = await this.gate(actor, operation, 'request-queued');
        const requestHex = toHex(new Uint8Array(await request.clone().arrayBuffer()));
        const frame = (status: number, responseHex: string): ProtocolFrame => ({
          eventId: requestId,
          actor,
          operation,
          phase: 'request-queued',
          url: stripSecrets(url),
          requestHex,
          responseStatus: status,
          responseHex,
        });
        let outcome: { response: Response } | { error: unknown };
        try {
          const response = await this.fetchImpl(request);
          if (this.closed) throw new Error('runtime-closed');
          this.frames.push(
            frame(response.status, toHex(new Uint8Array(await response.clone().arrayBuffer())))
          );
          outcome = { response };
        } catch (error) {
          if (!this.closed) this.frames.push(frame(0, ''));
          outcome = { error };
        }
        const current = this.state.events.find((event) => event.eventId === requestId);
        if (current?.status === 'permitted') this.complete(requestId);
        // Success and failure alike become a pending result that crosses its
        // own deliver boundary before reaching the caller.
        const deliverId = await this.gate(actor, operation, 'deliver');
        this.complete(deliverId);
        if ('error' in outcome) throw outcome.error;
        return outcome.response;
      });
  }

  private requestedCount(): number {
    return this.state.events.filter((event) => event.status === 'requested').length;
  }

  private flushRequestWaiters(): void {
    const count = this.requestedCount();
    const pending = this.requestWaiters.splice(0);
    for (const waiter of pending) {
      if (count >= waiter.count) Deferred.doneUnsafe(waiter.ready, Effect.void);
      else this.requestWaiters.push(waiter);
    }
  }

  private dispatch(): void {
    for (const event of this.state.events) {
      if (event.status !== 'permitted') continue;
      const waiter = this.waiters.get(event.eventId);
      if (waiter) {
        this.waiters.delete(event.eventId);
        Deferred.doneUnsafe(waiter, Effect.void);
      }
    }
    if (this.mode !== 'auto') return;
    const next = this.state.events.find(
      (event) => event.status === 'requested' && canPermitEvent(this.state, event.eventId)
    );
    if (!next) return;
    this.permit(next.eventId);
  }
}

function stripSecrets(url: string): string {
  return url.replace(/Bearer%20[0-9a-f]+/gi, 'Bearer').split('?')[0] ?? url;
}

export interface LabRuntimeOptions {
  readonly mode: 'auto' | 'manual';
  readonly time: number;
  readonly fetch: typeof globalThis.fetch;
}
/** Scope owns admission, abort, raw settlement and final resource closure. */
export const makeLabRuntime = Effect.fnUntraced(function* (options: LabRuntimeOptions) {
  const nativeScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void)
  );
  const operations = yield* makeLabOperations().pipe(
    Effect.provideService(Scope.Scope, nativeScope)
  );
  return yield* Effect.acquireRelease(
    Effect.sync(() => new LabRuntime({ ...options }, operations, nativeScope)),
    (runtime) => runtime.disposeEffect()
  );
});

export type { LabRuntime };
