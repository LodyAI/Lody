import { Deferred, Effect, Layer, Queue, Ref } from 'effect';
import { LabRun, runLabSync } from './services/run';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  canPermitEvent,
  completeEvent,
  emptyScheduler,
  permitEvent,
  requestEvent,
  type LabEvent,
  type SchedulerState,
} from './scheduler';
import { toHex } from './platform/bytes';
import { eventIdentity, identityKey, type ScheduleChoice } from './schedule';

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

export type FetchIntercept = {
  readonly eventId: string;
  readonly kind: 'drop' | 'replace' | 'delay' | 'duplicate' | 'truncate';
  readonly status?: number;
  readonly bodyHex?: string;
};

/**
 * Split view: `actor` sees `stream` only up to byte offset `at`; later records
 * are withheld from that actor while every other client sees the real tail.
 */
export type ViewFreeze = {
  readonly actor: string;
  readonly stream: string;
  readonly at: number;
};

export class LabRuntime {
  private static readonly live = new Set<LabRuntime>();
  private readonly scheduler: Ref.Ref<SchedulerState>;
  private readonly run = new LabRun(Layer.empty);
  private readonly notifications = new Set<Queue.Queue<void>>();
  private readonly abort = new AbortController();
  get state(): SchedulerState {
    return Ref.getUnsafe(this.scheduler);
  }
  private set state(next: SchedulerState) {
    runLabSync(Ref.set(this.scheduler, next));
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

  readonly paused = new Set<string>();
  readonly frames: ProtocolFrame[] = [];
  private readonly intercepts: FetchIntercept[] = [];
  private readonly freezes: ViewFreeze[] = [];
  private readonly pendingIntercepts: {
    match: (event: LabEvent) => boolean;
    intercept: Omit<FetchIntercept, 'eventId'>;
  }[] = [];
  private readonly waiters = new Map<string, Deferred.Deferred<void, Error>>();
  private readonly requestWaiters: Array<{
    count: number;
    ready: Deferred.Deferred<void, Error>;
  }> = [];
  private readonly gateContext = new AsyncLocalStorage<string>();
  private readonly mode: 'auto' | 'manual';
  private readonly fetchImpl: typeof globalThis.fetch;
  private closed = false;
  /** Every permit, in order. Replay uses this instead of an unbounded drain. */
  readonly permitLog: ScheduleChoice[] = [];
  private readonly identityCounts = new Map<string, number>();
  /** Honest-operation starts recorded for strict replay. */
  readonly startLog: ScheduleChoice[] = [];

  constructor(options?: {
    mode?: 'auto' | 'manual';
    time?: number;
    /** Injectable HTTP; defaults to globalThis.fetch (Live LabHttp). */
    fetch?: typeof globalThis.fetch;
  }) {
    this.mode = options?.mode ?? 'auto';
    this.fetchImpl = options?.fetch ?? globalThis.fetch.bind(globalThis);
    this.scheduler = Ref.makeUnsafe(emptyScheduler(options?.time ?? 0));
    LabRuntime.live.add(this);
  }

  events(): readonly LabEvent[] {
    return this.state.events;
  }

  pause(actor: string): void {
    this.paused.add(actor);
  }

  resumeActor(actor: string): void {
    this.paused.delete(actor);
    this.dispatch();
    this.changed();
  }

  permitActor(actor: string): void {
    const event = this.state.events.find(
      (row) => row.actor === actor && canPermitEvent(this.state, row.eventId)
    );
    if (!event) throw new Error(`no-requested:${actor}`);
    this.permit(event.eventId);
  }

  /** Permit the first requested event the scheduler allows. Returns its id. */
  permitNext(): string | null {
    const next = this.state.events.find(
      (event) =>
        event.status === 'requested' &&
        !this.paused.has(event.actor) &&
        canPermitEvent(this.state, event.eventId)
    );
    if (!next) return null;
    this.permit(next.eventId);
    return next.eventId;
  }

  whenRequested(count: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('runtime-closed'));
    if (this.requestedCount() >= count) return Promise.resolve();
    const ready = Deferred.makeUnsafe<void, Error>();
    this.requestWaiters.push({ count, ready });
    return this.run.run(Deferred.await(ready)).finally(() => {
      const index = this.requestWaiters.findIndex((row) => row.ready === ready);
      if (index >= 0) this.requestWaiters.splice(index, 1);
    });
  }

  permit(eventId: string): void {
    const next = permitEvent(this.state, eventId);
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

  recordStart(input: { actor: string; operation: string; phase?: string }): void {
    this.startLog.push({
      kind: 'start',
      identity: {
        actor: input.actor,
        operation: input.operation,
        phase: input.phase ?? 'start',
      },
      occurrence: this.startLog.length,
    });
    this.changed();
  }

  complete(eventId: string): void {
    this.state = completeEvent(this.state, eventId);
    this.dispatch();
    this.changed();
  }

  intercept(input: FetchIntercept): void {
    this.intercepts.push(input);
  }

  freezeView(input: ViewFreeze): void {
    this.releaseView(input.actor, input.stream);
    this.freezes.push(input);
  }

  releaseView(actor: string, stream: string): void {
    const index = this.freezes.findIndex((row) => row.actor === actor && row.stream === stream);
    if (index >= 0) this.freezes.splice(index, 1);
  }

  views(): readonly ViewFreeze[] {
    return [...this.freezes];
  }

  /** Rewrite a plain stream read so the frozen actor never sees bytes past `at`. */
  private async applyFreeze(
    actor: string,
    url: string,
    method: string,
    response: Response
  ): Promise<Response> {
    const route = /\/ds\/[^/]+\/([^/?]+)(?:\?|$)/.exec(url);
    const freeze =
      route && this.freezes.find((row) => row.actor === actor && row.stream === route[1]);
    if (!freeze || !response.ok) return response;
    const nextHeader = response.headers.get('stream-next-offset');
    if (nextHeader === null || Number(nextHeader) <= freeze.at) return response;
    const width = nextHeader.length;
    const raw = new URL(url).searchParams.get('offset');
    const from = raw === null || raw === '' || raw === '-1' ? 0 : Number(raw);
    if (!Number.isSafeInteger(from)) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const keep = method === 'HEAD' ? 0 : Math.max(0, Math.min(bytes.byteLength, freeze.at - from));
    const headers = new Headers(response.headers);
    headers.delete('etag');
    headers.delete('content-length');
    headers.set('stream-next-offset', String(Math.max(freeze.at, from)).padStart(width, '0'));
    headers.set('stream-up-to-date', 'true');
    return new Response(method === 'HEAD' ? null : Buffer.from(bytes.subarray(0, keep)), {
      status: response.status,
      headers,
    });
  }

  /** Attach an intercept to the next requested event matching `match`. */
  interceptWhen(
    match: (event: LabEvent) => boolean,
    intercept: Omit<FetchIntercept, 'eventId'>
  ): void {
    this.pendingIntercepts.push({ match, intercept });
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

  /** Harness owners register cleanup without exposing their private Context. */
  addFinalizer(finalizer: Effect.Effect<void>): void {
    this.run.addFinalizer(finalizer);
  }

  async dispose(): Promise<void> {
    this.close();
    try {
      await this.run.close();
    } finally {
      LabRuntime.live.delete(this);
    }
  }

  static async disposeAll(): Promise<void> {
    await Promise.all([...LabRuntime.live].map((runtime) => runtime.dispose()));
  }

  static closeAll(): void {
    for (const runtime of [...LabRuntime.live]) runtime.close();
  }

  async gate(actor: string, operation: string, phase: string): Promise<string> {
    if (this.closed) throw new Error('runtime-closed');
    const requested = requestEvent(this.state, {
      actor,
      operation,
      phase,
      parent: this.gateContext.getStore(),
    });
    this.state = requested.state;
    this.flushRequestWaiters();
    const eventId = requested.event.eventId;
    const armed = this.pendingIntercepts.findIndex((item) => item.match(requested.event));
    if (armed >= 0) {
      const matched = this.pendingIntercepts[armed]!;
      this.pendingIntercepts.splice(armed, 1);
      this.intercepts.push({ ...matched.intercept, eventId });
    }
    const ready = Deferred.makeUnsafe<void, Error>();
    this.waiters.set(eventId, ready);
    this.dispatch();
    this.changed();
    try {
      await this.run.run(Deferred.await(ready));
    } finally {
      this.waiters.delete(eventId);
    }
    return eventId;
  }

  /**
   * Gate `work` on an explicit permit. A phase nested inside a permitted
   * phase is a child event: it is visible to the scheduler and needs its own
   * permit, which may be granted only while its parent chain is permitted.
   */
  async phase<T>(
    actor: string,
    operation: string,
    phase: string,
    work: () => Promise<T>
  ): Promise<T> {
    const eventId = await this.gate(actor, operation, phase);
    try {
      return await this.gateContext.run(eventId, work);
    } finally {
      this.complete(eventId);
    }
  }

  gatedFetch(actor: string): typeof globalThis.fetch {
    return async (input, init) => {
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
      if (!labPath) return this.fetchImpl(request);
      const requestId = await this.gate(actor, operation, 'request-queued');
      const requestHex = toHex(new Uint8Array(await request.clone().arrayBuffer()));
      const intercept = this.intercepts.find((item) => item.eventId === requestId);
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
        if (intercept?.kind === 'drop') {
          throw new Error('intercept-drop');
        }
        if (intercept?.kind === 'duplicate') {
          await this.fetchImpl(request.clone());
        }
        let response =
          intercept?.kind === 'replace'
            ? new Response(Buffer.from(fromHexBody(intercept.bodyHex ?? '')), {
                status: intercept.status ?? 200,
              })
            : await this.applyFreeze(actor, url, method, await this.fetchImpl(request));
        if (intercept?.kind === 'truncate') {
          const bytes = new Uint8Array(await response.clone().arrayBuffer());
          const keep = Math.min(1, bytes.byteLength);
          response = new Response(Buffer.from(bytes.subarray(0, keep)), {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        this.frames.push(
          frame(response.status, toHex(new Uint8Array(await response.clone().arrayBuffer())))
        );
        outcome = { response };
      } catch (error) {
        this.frames.push(frame(0, ''));
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
    };
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
      (event) =>
        event.status === 'requested' &&
        !this.paused.has(event.actor) &&
        canPermitEvent(this.state, event.eventId)
    );
    if (!next) return;
    this.permit(next.eventId);
  }
}

function stripSecrets(url: string): string {
  return url.replace(/Bearer%20[0-9a-f]+/gi, 'Bearer').split('?')[0] ?? url;
}

function fromHexBody(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
