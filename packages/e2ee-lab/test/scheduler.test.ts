import { describe, expect, it } from 'vitest';
import { advanceTime, emptyScheduler, recordEvent } from '../src/scheduler';

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
});
