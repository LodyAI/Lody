import { describe, it, expect } from 'vitest';
import {
  createEagerSyncInteractionSignal,
  bindEagerSyncInteractionSignalToDom,
  EAGER_SYNC_INTERACTION_EVENTS,
} from '../src/providers/eager-sync-interaction';

function createFakeTime() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fire: () => void; due: number }>();
  return {
    clock: { now: () => now },
    scheduler: {
      setTimeout: (handler: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { fire: handler, due: now + ms });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        timers.delete(handle as number);
      },
    },
    pending: () => timers.size,
    advance: (ms: number) => {
      now += ms;
      for (const [id, timer] of Array.from(timers)) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.fire();
        }
      }
    },
  };
}

function setup(quietMs = 1_000) {
  const time = createFakeTime();
  const signal = createEagerSyncInteractionSignal({
    quietMs,
    clock: time.clock,
    scheduler: time.scheduler,
  });
  const flips: boolean[] = [];
  signal.subscribe(() => flips.push(signal.isInteracting()));
  return { time, signal, flips };
}

describe('createEagerSyncInteractionSignal', () => {
  it('is idle until the first input', () => {
    const { signal, flips } = setup();
    expect(signal.isInteracting()).toBe(false);
    expect(flips).toEqual([]);
  });

  it('reports interacting for the quiet window after input, then flips back once', () => {
    const { signal, time, flips } = setup();

    signal.mark();
    expect(signal.isInteracting()).toBe(true);
    expect(flips).toEqual([true]);

    time.advance(999);
    expect(signal.isInteracting()).toBe(true);
    expect(flips).toEqual([true]);

    time.advance(1);
    expect(signal.isInteracting()).toBe(false);
    expect(flips).toEqual([true, false]);
  });

  it('extends the quiet window across a continuing gesture without re-notifying', () => {
    const { signal, time, flips } = setup();

    signal.mark();
    for (let i = 0; i < 5; i++) {
      time.advance(200);
      signal.mark();
      expect(signal.isInteracting()).toBe(true);
    }
    // One transition into "interacting", not one per event.
    expect(flips).toEqual([true]);

    time.advance(1_000);
    expect(signal.isInteracting()).toBe(false);
    expect(flips).toEqual([true, false]);
  });

  it('keeps at most one pending timer regardless of input rate', () => {
    const { signal, time } = setup();
    for (let i = 0; i < 20; i++) {
      signal.mark();
      time.advance(10);
    }
    expect(time.pending()).toBe(1);
  });

  it('reports idle and schedules nothing after dispose', () => {
    const { signal, time } = setup();
    signal.mark();
    expect(signal.isInteracting()).toBe(true);

    signal.dispose();
    expect(signal.isInteracting()).toBe(false);
    expect(time.pending()).toBe(0);

    signal.mark();
    expect(signal.isInteracting()).toBe(false);
  });
});

describe('bindEagerSyncInteractionSignalToDom', () => {
  function createFakeTarget() {
    const listeners = new Map<string, Set<EventListener>>();
    return {
      count: () => Array.from(listeners.values()).reduce((sum, set) => sum + set.size, 0),
      dispatch: (type: string) => {
        for (const listener of Array.from(listeners.get(type) ?? [])) {
          listener(new Event(type));
        }
      },
      target: {
        addEventListener: (type: string, listener: EventListener) => {
          const set = listeners.get(type) ?? new Set<EventListener>();
          set.add(listener);
          listeners.set(type, set);
        },
        removeEventListener: (type: string, listener: EventListener) => {
          listeners.get(type)?.delete(listener);
        },
      },
    };
  }

  it('marks the signal from direct-manipulation input and unbinds cleanly', () => {
    const { signal } = setup();
    const fake = createFakeTarget();

    const unbind = bindEagerSyncInteractionSignalToDom(signal, fake.target);
    expect(fake.count()).toBe(EAGER_SYNC_INTERACTION_EVENTS.length);

    fake.dispatch('touchmove');
    expect(signal.isInteracting()).toBe(true);

    unbind();
    expect(fake.count()).toBe(0);
  });

  it('ignores scroll events so a streaming session cannot starve background sync', () => {
    // The conversation view auto-scrolls itself while an agent streams. Treating
    // that as user input would defer eager-sync for as long as any session runs.
    expect(EAGER_SYNC_INTERACTION_EVENTS).not.toContain('scroll');

    const { signal } = setup();
    const fake = createFakeTarget();
    bindEagerSyncInteractionSignalToDom(signal, fake.target);

    fake.dispatch('scroll');
    expect(signal.isInteracting()).toBe(false);
  });

  it('is a no-op without a DOM target', () => {
    const { signal } = setup();
    expect(() => bindEagerSyncInteractionSignalToDom(signal, undefined)()).not.toThrow();
  });
});
