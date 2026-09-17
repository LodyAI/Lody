import { describe, expect, it } from 'vitest';
import { firstDivergence } from '../src/replay';
import { exploreSubmitInterleavings } from '../src/model';
import {
  advanceTime,
  completeEvent,
  emptyScheduler,
  isRunnable,
  permitEvent,
  recordEvent,
  requestEvent,
} from '../src/scheduler';

describe('lab scheduler', () => {
  it('assigns stable ids and does not execute effects', () => {
    const first = recordEvent(emptyScheduler(10), {
      actor: 'alice',
      operation: 'submit',
      phase: 'pending-saved',
    });
    const second = recordEvent(first.state, {
      actor: 'bob',
      operation: 'submit',
      phase: 'request-queued',
    });
    expect(first.event.eventId).toBe('e1');
    expect(second.event.eventId).toBe('e2');
    expect(second.event.step).toBe(1);
    expect(second.event.time).toBe(10);
    expect(advanceTime(second.state, 5).time).toBe(15);
    expect(second.state.events).toHaveLength(2);
  });

  it('does not run a side effect until it is permitted, and consumes the event once', () => {
    const requested = requestEvent(emptyScheduler(), {
      actor: 'alice',
      operation: 'submit',
      phase: 'pending-saved',
    });
    expect(isRunnable(requested.state, requested.event.eventId)).toBe(false);
    const permitted = permitEvent(requested.state, requested.event.eventId);
    expect(permitted.command).toEqual({ type: 'run', eventId: 'e1' });
    expect(isRunnable(permitted.state, 'e1')).toBe(true);
    const other = requestEvent(permitted.state, {
      actor: 'bob',
      operation: 'submit',
      phase: 'pending-saved',
    });
    expect(() => permitEvent(other.state, 'e2')).toThrow('permit-busy');
    const done = completeEvent(permitted.state, 'e1');
    expect(isRunnable(done, 'e1')).toBe(false);
    expect(() => completeEvent(done, 'e1')).toThrow('event-not-permitted');
    const bob = permitEvent(
      requestEvent(done, {
        actor: 'bob',
        operation: 'submit',
        phase: 'pending-saved',
      }).state,
      'e2'
    );
    expect(bob.command).toEqual({ type: 'run', eventId: 'e2' });
  });

  it('explores bounded two-actor submit interleavings without double permits', () => {
    const result = exploreSubmitInterleavings(8);
    expect(result.ok).toBe(true);
    expect(result.steps).toBeGreaterThan(10);
  });

  it('matches C2: unknown CAS does not create a second submit for the same actor', () => {
    let state = emptyScheduler();
    const pending = requestEvent(state, { actor: 'A', operation: 'submit', phase: 'pending' });
    state = permitEvent(pending.state, pending.event.eventId).state;
    state = completeEvent(state, pending.event.eventId);
    const cas = requestEvent(state, { actor: 'A', operation: 'submit', phase: 'cas' });
    state = permitEvent(cas.state, cas.event.eventId).state;
    state = completeEvent(state, cas.event.eventId);
    const ack = requestEvent(state, { actor: 'A', operation: 'submit', phase: 'ack' });
    expect(ack.event.phase).toBe('ack');
    expect(
      state.events.filter((event) => event.actor === 'A' && event.phase === 'pending')
    ).toHaveLength(1);
  });

  it('reports the first diverging event instead of only comparing finals', () => {
    const base = recordEvent(emptyScheduler(), {
      actor: 'alice',
      operation: 'submit',
      phase: 'pending-saved',
    });
    const same = recordEvent(emptyScheduler(), {
      actor: 'alice',
      operation: 'submit',
      phase: 'pending-saved',
    });
    expect(firstDivergence(base.state.events, same.state.events)).toBeNull();
    const mutated = recordEvent(emptyScheduler(), {
      actor: 'bob',
      operation: 'submit',
      phase: 'pending-saved',
    });
    const divergence = firstDivergence(base.state.events, mutated.state.events);
    expect(divergence?.index).toBe(0);
    expect(divergence?.expected).toBe('alice');
    expect(divergence?.actual).toBe('bob');
  });
});
