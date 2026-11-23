import { Data, Result } from 'effect';

export class SchedulerError extends Data.TaggedError('SchedulerError')<{
  readonly code: 'event-not-requested' | 'permit-busy' | 'event-not-permitted' | 'invalid-lab-time';
}> {}
const fail = (code: SchedulerError['code']) => Result.fail(new SchedulerError({ code }));

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
): Result.Result<{ state: SchedulerState; event: LabEvent }, SchedulerError> {
  return Result.gen(function* () {
    const requested = requestEvent(state, input);
    const permitted = yield* permitEvent(requested.state, requested.event.eventId);
    const completed = yield* completeEvent(permitted.state, permitted.event.eventId);
    const event = completed.events[completed.events.length - 1]!;
    return { event, state: completed };
  });
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
): Result.Result<
  { state: SchedulerState; event: LabEvent; command: SchedulerCommand },
  SchedulerError
> {
  const index = state.events.findIndex((event) => event.eventId === eventId);
  const current = state.events[index];
  if (!current || current.status !== 'requested') return fail('event-not-requested');
  if (!canPermitEvent(state, eventId)) return fail('permit-busy');
  const event: LabEvent = { ...current, status: 'permitted' };
  const events = state.events.slice();
  events[index] = event;
  return Result.succeed({
    event,
    command: { type: 'run', eventId },
    state: { ...state, events },
  });
}

export function completeEvent(
  state: SchedulerState,
  eventId: string
): Result.Result<SchedulerState, SchedulerError> {
  const index = state.events.findIndex((event) => event.eventId === eventId);
  const current = state.events[index];
  if (!current || current.status !== 'permitted') return fail('event-not-permitted');
  const events = state.events.slice();
  events[index] = { ...current, status: 'completed' };
  return Result.succeed({ ...state, events });
}

export function advanceTime(
  state: SchedulerState,
  ms: number
): Result.Result<SchedulerState, SchedulerError> {
  if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isSafeInteger(state.time + ms))
    return fail('invalid-lab-time');
  return Result.succeed({ ...state, time: state.time + ms });
}

export function isRunnable(state: SchedulerState, eventId: string): boolean {
  return state.events.some((event) => event.eventId === eventId && event.status === 'permitted');
}

export class SubmitModelError extends Data.TaggedError('SubmitModelError')<{
  readonly code: 'invalid-budget';
}> {}
/** Finite two-actor pending/CAS/ACK scheduling oracle only. It does not model
 * network outcomes or prove P09 unknown-CAS/cryptographic safety. Truncation is
 * explicitly unmeasured, never a successful exhaustive search. */
export function exploreSubmitInterleavings(
  input: { readonly maxStates?: number; readonly maxEvents?: number } = {}
) {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return Result.fail(new SubmitModelError({ code: 'invalid-budget' }));
  const maxStates = input.maxStates ?? 50_000,
    maxEvents = input.maxEvents ?? 6;
  if (
    !Number.isSafeInteger(maxStates) ||
    maxStates < 0 ||
    maxStates > 50_000 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 0 ||
    maxEvents > 6
  )
    return Result.fail(new SubmitModelError({ code: 'invalid-budget' }));
  const queue: SchedulerState[] = [],
    discovered = new Set<string>();
  let states = 0,
    terminalStates = 0,
    truncated = false;
  const enqueue = (state: SchedulerState) => {
    const key = JSON.stringify(state);
    if (discovered.has(key)) return;
    if (discovered.size >= maxStates) {
      truncated = true;
      return;
    }
    discovered.add(key);
    queue.push(state);
  };
  const finish = (violation?: string) =>
    Result.succeed({
      verdict: violation
        ? ('violation' as const)
        : truncated
          ? ('unmeasured' as const)
          : ('pass' as const),
      coverage: violation || truncated ? ('incomplete' as const) : ('complete' as const),
      states,
      terminalStates,
      ...(violation ? { reason: violation } : {}),
    });
  enqueue(emptyScheduler());
  while (queue.length) {
    const state = queue.pop()!;
    states++;
    if (state.events.filter((row) => row.status === 'permitted').length > 1)
      return finish('two-permits');
    for (const event of state.events) {
      if (event.status === 'completed') {
        if (
          Result.isSuccess(completeEvent(state, event.eventId)) ||
          Result.isSuccess(permitEvent(state, event.eventId))
        )
          return finish('reused-event');
      } else if (event.status === 'requested') {
        if (Result.isSuccess(completeEvent(state, event.eventId)))
          return finish('run-without-permit');
        const permitted = permitEvent(state, event.eventId);
        const active = state.events.some((row) => row.status === 'permitted');
        if (Result.isSuccess(permitted) && active) return finish('two-permits');
        if (Result.isFailure(permitted) && !active) return finish('invalid-permit');
        if (Result.isSuccess(permitted)) enqueue(permitted.success.state);
      } else {
        if (Result.isSuccess(permitEvent(state, event.eventId))) return finish('reused-permit');
        const completed = completeEvent(state, event.eventId);
        if (Result.isFailure(completed)) return finish('invalid-completion');
        enqueue(completed.success);
      }
    }
    let terminal = true;
    for (const actor of ['A', 'B']) {
      const last = state.events.filter((event) => event.actor === actor).at(-1);
      if (last?.phase === 'ack' && last.status === 'completed') continue;
      terminal = false;
      if (last && last.status !== 'completed') continue;
      const phase = !last
        ? 'pending'
        : last.phase === 'pending'
          ? 'cas'
          : last.phase === 'cas'
            ? 'ack'
            : undefined;
      if (!phase) return finish('invalid-phase');
      if (state.events.length >= maxEvents) truncated = true;
      else enqueue(requestEvent(state, { actor, operation: 'submit', phase }).state);
    }
    if (terminal) terminalStates++;
  }
  return finish();
}
