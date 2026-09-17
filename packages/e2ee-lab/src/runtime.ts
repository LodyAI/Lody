import {
  completeEvent,
  emptyScheduler,
  permitEvent,
  requestEvent,
  type LabEvent,
  type SchedulerState,
} from './scheduler';
import { toHex } from '../../e2ee-demo/src/bytes';

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

export class LabRuntime {
  state: SchedulerState;
  readonly paused = new Set<string>();
  readonly frames: ProtocolFrame[] = [];
  private readonly waiters = new Map<string, () => void>();
  private readonly requestWaiters: Array<{ count: number; resolve: () => void }> = [];
  private readonly mode: 'auto' | 'manual';

  constructor(options?: { mode?: 'auto' | 'manual'; time?: number }) {
    this.mode = options?.mode ?? 'auto';
    this.state = emptyScheduler(options?.time ?? 0);
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
      (row) => row.actor === actor && row.status === 'requested'
    );
    if (!event) throw new Error(`no-requested:${actor}`);
    this.permit(event.eventId);
  }

  whenRequested(count: number): Promise<void> {
    if (this.requestedCount() >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.requestWaiters.push({ count, resolve });
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

  async gate(actor: string, operation: string, phase: string): Promise<string> {
    const requested = requestEvent(this.state, { actor, operation, phase });
    this.state = requested.state;
    this.flushRequestWaiters();
    const eventId = requested.event.eventId;
    const ready = new Promise<void>((resolve) => {
      this.waiters.set(eventId, resolve);
    });
    this.dispatch();
    await ready;
    return eventId;
  }

  gatedFetch(actor: string): typeof globalThis.fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      const url = request.url;
      const cas = url.includes('/append-cas');
      let eventId: string | undefined;
      if (cas) {
        eventId = await this.gate(actor, 'submit', 'request-queued');
      }
      const requestHex = cas ? toHex(new Uint8Array(await request.clone().arrayBuffer())) : '';
      try {
        const response = await globalThis.fetch(request);
        if (eventId) {
          const responseHex = toHex(new Uint8Array(await response.clone().arrayBuffer()));
          this.frames.push({
            eventId,
            actor,
            operation: 'submit',
            phase: 'request-queued',
            url: stripSecrets(url),
            requestHex,
            responseStatus: response.status,
            responseHex,
          });
        }
        return response;
      } catch (error) {
        if (eventId) {
          this.frames.push({
            eventId,
            actor,
            operation: 'submit',
            phase: 'request-queued',
            url: stripSecrets(url),
            requestHex,
            responseStatus: 0,
            responseHex: '',
          });
        }
        throw error;
      } finally {
        if (eventId) this.complete(eventId);
      }
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
    if (this.state.events.some((event) => event.status === 'permitted')) {
      const permitted = this.state.events.find((event) => event.status === 'permitted')!;
      const waiter = this.waiters.get(permitted.eventId);
      if (waiter) {
        this.waiters.delete(permitted.eventId);
        waiter();
      }
      return;
    }
    if (this.mode !== 'auto') return;
    const next = this.state.events.find(
      (event) => event.status === 'requested' && !this.paused.has(event.actor)
    );
    if (!next) return;
    this.permit(next.eventId);
  }
}

function stripSecrets(url: string): string {
  return url.replace(/Bearer%20[0-9a-f]+/gi, 'Bearer').split('?')[0] ?? url;
}
