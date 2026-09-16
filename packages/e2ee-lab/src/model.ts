import {
  completeEvent,
  emptyScheduler,
  permitEvent,
  requestEvent,
  type SchedulerState,
} from './scheduler';

export type ModelAction =
  | {
      readonly type: 'request';
      readonly actor: 'A' | 'B';
      readonly phase: 'pending' | 'cas' | 'ack';
    }
  | { readonly type: 'permit'; readonly eventId: string }
  | { readonly type: 'complete'; readonly eventId: string };

export interface ModelTrace {
  readonly ok: boolean;
  readonly reason?: string;
  readonly steps: number;
}

/**
 * Bounded two-actor submit interleaving. Not a cryptographic proof.
 * Checks: no run without permit, each event consumed once, unknown CAS does not
 * spawn a second operation.
 */
export function exploreSubmitInterleavings(maxSteps = 12): ModelTrace {
  const queue: SchedulerState[] = [emptyScheduler()];
  const seen = new Set<string>();
  let steps = 0;
  while (queue.length > 0 && steps < 50_000) {
    const state = queue.pop()!;
    const key = JSON.stringify(state);
    if (seen.has(key)) continue;
    seen.add(key);
    steps += 1;
    const requested = state.events.filter((event) => event.status === 'requested');
    const permitted = state.events.filter((event) => event.status === 'permitted');
    if (permitted.length > 1) return { ok: false, reason: 'two-permits', steps };
    if (permitted.length === 1) {
      const eventId = permitted[0]!.eventId;
      try {
        queue.push(completeEvent(state, eventId));
      } catch (error) {
        return { ok: false, reason: String(error), steps };
      }
      continue;
    }
    if (state.events.length >= maxSteps) continue;
    for (const actor of ['A', 'B'] as const) {
      const ops = state.events.filter((event) => event.actor === actor);
      const last = ops[ops.length - 1];
      if (last && last.status !== 'completed') continue;
      const phase = !last
        ? 'pending'
        : last.phase === 'pending'
          ? 'cas'
          : last.phase === 'cas'
            ? 'ack'
            : null;
      if (phase === null) continue;
      const next = requestEvent(state, { actor, operation: 'submit', phase });
      queue.push(next.state);
    }
    for (const event of requested) {
      try {
        queue.push(permitEvent(state, event.eventId).state);
      } catch (error) {
        return { ok: false, reason: String(error), steps };
      }
    }
  }
  return { ok: true, steps };
}
