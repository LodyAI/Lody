/** Pure event log and permit gate. Does not perform I/O. */
export interface LabEvent {
  readonly eventId: string;
  readonly step: number;
  readonly time: number;
  readonly actor: string;
  readonly operation: string;
  readonly phase: string;
  /** Enclosing event for nested phases; children need their own permit. */
  readonly parent?: string;
  readonly status: 'requested' | 'permitted' | 'completed';
}

export interface SchedulerState {
  readonly time: number;
  readonly nextId: number;
  readonly events: readonly LabEvent[];
}

export type SchedulerCommand =
  | { readonly type: 'none' }
  | { readonly type: 'run'; readonly eventId: string };

export function emptyScheduler(time = 0): SchedulerState {
  return { time, nextId: 1, events: [] };
}

export function requestEvent(
  state: SchedulerState,
  input: { actor: string; operation: string; phase: string; parent?: string }
): { state: SchedulerState; event: LabEvent } {
  const event: LabEvent = {
    eventId: `e${state.nextId}`,
    step: state.events.length,
    time: state.time,
    actor: input.actor,
    operation: input.operation,
    phase: input.phase,
    parent: input.parent,
    status: 'requested',
  };
  return {
    event,
    state: {
      time: state.time,
      nextId: state.nextId + 1,
      events: [...state.events, event],
    },
  };
}

/** Log-only helper: request, permit and complete one event immediately. */
export function recordEvent(
  state: SchedulerState,
  input: { actor: string; operation: string; phase: string }
): { state: SchedulerState; event: LabEvent } {
  const requested = requestEvent(state, input);
  const permitted = permitEvent(requested.state, requested.event.eventId);
  const completed = completeEvent(permitted.state, permitted.event.eventId);
  const event = completed.events[completed.events.length - 1]!;
  return { event, state: completed };
}

function ancestorIds(state: SchedulerState, event: LabEvent): Set<string> {
  const ids = new Set<string>();
  let cursor = event.parent;
  while (cursor !== undefined) {
    if (ids.has(cursor)) break;
    ids.add(cursor);
    cursor = state.events.find((row) => row.eventId === cursor)?.parent;
  }
  return ids;
}

/**
 * Whether a requested event may run now. At most one permitted root chain is
 * allowed: every currently permitted event must be an ancestor of the target,
 * and the target's parent (if any) must already be permitted or completed.
 */
export function canPermitEvent(state: SchedulerState, eventId: string): boolean {
  const target = state.events.find((event) => event.eventId === eventId);
  if (!target || target.status !== 'requested') return false;
  if (target.parent !== undefined) {
    const parent = state.events.find((event) => event.eventId === target.parent);
    if (!parent || parent.status === 'requested') return false;
  }
  const ancestors = ancestorIds(state, target);
  return state.events.every(
    (event) => event.status !== 'permitted' || ancestors.has(event.eventId)
  );
}

export function permitEvent(
  state: SchedulerState,
  eventId: string
): { state: SchedulerState; event: LabEvent; command: SchedulerCommand } {
  const index = state.events.findIndex((event) => event.eventId === eventId);
  const current = state.events[index];
  if (!current || current.status !== 'requested') throw new Error('event-not-requested');
  if (!canPermitEvent(state, eventId)) throw new Error('permit-busy');
  const event: LabEvent = { ...current, status: 'permitted' };
  const events = state.events.slice();
  events[index] = event;
  return {
    event,
    command: { type: 'run', eventId },
    state: { ...state, events },
  };
}

export function completeEvent(state: SchedulerState, eventId: string): SchedulerState {
  const index = state.events.findIndex((event) => event.eventId === eventId);
  const current = state.events[index];
  if (!current || current.status !== 'permitted') throw new Error('event-not-permitted');
  const events = state.events.slice();
  events[index] = { ...current, status: 'completed' };
  return { ...state, events };
}

export function advanceTime(state: SchedulerState, ms: number): SchedulerState {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('invalid-lab-time');
  return { ...state, time: state.time + ms };
}

export function isRunnable(state: SchedulerState, eventId: string): boolean {
  return state.events.some((event) => event.eventId === eventId && event.status === 'permitted');
}
