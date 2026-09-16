/** Pure event log. Does not perform I/O. P2 adds pause/permit. */
export interface LabEvent {
  readonly eventId: string;
  readonly step: number;
  readonly time: number;
  readonly actor: string;
  readonly operation: string;
  readonly phase: string;
}

export interface SchedulerState {
  readonly time: number;
  readonly nextId: number;
  readonly events: readonly LabEvent[];
}

export function emptyScheduler(time = 0): SchedulerState {
  return { time, nextId: 1, events: [] };
}

export function recordEvent(
  state: SchedulerState,
  input: { actor: string; operation: string; phase: string }
): { state: SchedulerState; event: LabEvent } {
  const event: LabEvent = {
    eventId: `e${state.nextId}`,
    step: state.events.length,
    time: state.time,
    actor: input.actor,
    operation: input.operation,
    phase: input.phase,
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

export function advanceTime(state: SchedulerState, ms: number): SchedulerState {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('invalid-lab-time');
  return { ...state, time: state.time + ms };
}
