import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  advanceTime,
  canPermitEvent,
  completeEvent,
  emptyScheduler,
  permitEvent,
  requestEvent,
  recordEvent,
  exploreSubmitInterleavings,
} from '../src/pure/scheduler';
const ok = Result.getOrThrow;
describe('explicit logical scheduler, without expected throws', () => {
  it('retains stable ids and logical time without mutating the old event log', () => {
    const original = emptyScheduler(10);
    const first = ok(
      recordEvent(original, { actor: 'alice', operation: 'submit', phase: 'pending-saved' })
    );
    const second = ok(
      recordEvent(first.state, { actor: 'bob', operation: 'submit', phase: 'request-queued' })
    );
    expect(first.event.eventId).toBe('e1');
    expect(second.event.eventId).toBe('e2');
    expect(second.event.step).toBe(1);
    expect(second.event.time).toBe(10);
    expect(ok(advanceTime(second.state, 5)).time).toBe(15);
    expect(original.events).toEqual([]);
    expect(first.state.events).toHaveLength(1);
    expect(Result.isFailure(advanceTime(second.state, -1))).toBe(true);
    expect(Result.isFailure(advanceTime(emptyScheduler(Number.MAX_SAFE_INTEGER), 1))).toBe(true);
  });
  it('allows only the active root chain, once per permit, and keeps failed commands inert', () => {
    const root = requestEvent(emptyScheduler(), {
      actor: 'alice',
      operation: 'write',
      phase: 'root',
    });
    const active = ok(permitEvent(root.state, root.event.eventId));
    const other = requestEvent(active.state, { actor: 'bob', operation: 'write', phase: 'root' });
    const before = other.state;
    expect(Result.isFailure(permitEvent(before, other.event.eventId))).toBe(true);
    expect(before.events.map((event) => event.status)).toEqual(['permitted', 'requested']);
    const nested = requestEvent(before, {
      actor: 'alice',
      operation: 'write',
      phase: 'save',
      parent: root.event.eventId,
    });
    expect(canPermitEvent(nested.state, nested.event.eventId)).toBe(true);
    const child = ok(permitEvent(nested.state, nested.event.eventId));
    expect(Result.isFailure(permitEvent(child.state, other.event.eventId))).toBe(true);
    const doneChild = ok(completeEvent(child.state, nested.event.eventId));
    expect(Result.isFailure(completeEvent(doneChild, nested.event.eventId))).toBe(true);
    const doneRoot = ok(completeEvent(doneChild, root.event.eventId));
    expect(ok(permitEvent(doneRoot, other.event.eventId)).command).toEqual({
      type: 'run',
      eventId: 'e2',
    });
  });
  it('refuses a requested or missing parent instead of granting a nested permit', () => {
    const root = requestEvent(emptyScheduler(), {
      actor: 'alice',
      operation: 'read',
      phase: 'root',
    });
    const child = requestEvent(root.state, {
      actor: 'alice',
      operation: 'read',
      phase: 'load',
      parent: root.event.eventId,
    });
    expect(canPermitEvent(child.state, child.event.eventId)).toBe(false);
    const missing = requestEvent(emptyScheduler(), {
      actor: 'alice',
      operation: 'read',
      phase: 'load',
      parent: 'unknown',
    });
    expect(Result.isFailure(permitEvent(missing.state, missing.event.eventId))).toBe(true);
  });
  it('explores both actor phase orders with single-use permits and distinguishes exhaustive coverage from exhausted budgets', () => {
    const complete = ok(exploreSubmitInterleavings());
    expect(complete.verdict).toBe('pass');
    expect(complete.coverage).toBe('complete');
    expect(complete.terminalStates).toBeGreaterThan(1);
    expect(complete.states).toBeGreaterThan(complete.terminalStates);
    for (const budget of [{ maxStates: 0 }, { maxStates: 1 }, { maxEvents: 0 }, { maxEvents: 3 }]) {
      const partial = ok(exploreSubmitInterleavings(budget));
      expect(partial.verdict).toBe('unmeasured');
      expect(partial.coverage).toBe('incomplete');
    }
    expect(ok(exploreSubmitInterleavings({ maxStates: 1 })).states).toBeLessThanOrEqual(1);
    expect(Result.isFailure(exploreSubmitInterleavings({ maxStates: -1 }))).toBe(true);
    expect(Result.isFailure(exploreSubmitInterleavings({ maxEvents: 7 }))).toBe(true);
  });
});
