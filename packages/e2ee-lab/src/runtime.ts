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

export class LabRuntime {
  private static readonly live = new Set<LabRuntime>();
  state: SchedulerState;
  readonly paused = new Set<string>();
  readonly frames: ProtocolFrame[] = [];
  private readonly intercepts: FetchIntercept[] = [];
  private readonly waiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private readonly requestWaiters: Array<{
    count: number;
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];
  private readonly gateContext = new AsyncLocalStorage<string>();
  private readonly mode: 'auto' | 'manual';
  private closed = false;

  constructor(options?: { mode?: 'auto' | 'manual'; time?: number }) {
    this.mode = options?.mode ?? 'auto';
    this.state = emptyScheduler(options?.time ?? 0);
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
    if (this.requestedCount() >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.requestWaiters.push({ count, resolve, reject });
    });
  }

  permit(eventId: string): void {
    const next = permitEvent(this.state, eventId);
    this.state = next.state;
    this.dispatch();
  }

  complete(eventId: string): void {
    this.state = completeEvent(this.state, eventId);
    this.dispatch();
  }

  intercept(input: FetchIntercept): void {
    this.intercepts.push(input);
  }

  /** Reject every pending gate and request waiter. Idempotent teardown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    LabRuntime.live.delete(this);
    const error = new Error('runtime-closed');
    const waiters = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of waiters) waiter.reject(error);
    for (const waiter of this.requestWaiters.splice(0)) waiter.reject(error);
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
    const ready = new Promise<void>((resolve, reject) => {
      this.waiters.set(eventId, { resolve, reject });
    });
    this.dispatch();
    await ready;
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
      const request = new Request(input, init);
      const url = request.url;
      const method = request.method.toUpperCase();
      const labPath = url.includes('/ds/') || url.includes('/append-cas');
      const content = url.includes('/loro') || url.includes('/flock');
      const reading = method === 'GET' || method === 'HEAD';
      const operation = reading ? 'read' : content ? 'content' : 'submit';
      if (!labPath) return globalThis.fetch(request);
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
          await globalThis.fetch(request.clone());
        }
        let response =
          intercept?.kind === 'replace'
            ? new Response(Buffer.from(fromHexBody(intercept.bodyHex ?? '')), {
                status: intercept.status ?? 200,
              })
            : await globalThis.fetch(request);
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
      if (count >= waiter.count) waiter.resolve();
      else this.requestWaiters.push(waiter);
    }
  }

  private dispatch(): void {
    for (const event of this.state.events) {
      if (event.status !== 'permitted') continue;
      const waiter = this.waiters.get(event.eventId);
      if (waiter) {
        this.waiters.delete(event.eventId);
        waiter.resolve();
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
