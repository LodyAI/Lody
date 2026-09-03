import { describe, it, expect } from 'vitest';
import {
  createEagerSyncInteractionSignal,
  bindEagerSyncInteractionSignalToDom,
  EAGER_SYNC_INTERACTION_EVENTS,
  EAGER_SYNC_INTERACTION_QUIET_MS,
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

function setup(quietMs = EAGER_SYNC_INTERACTION_QUIET_MS) {
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
  it('reports interacting for the quiet window after input, then flips back once', () => {
    const { signal, time, flips } = setup();
    expect(signal.isInteracting()).toBe(false);
    expect(flips).toEqual([]);

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

  it('extends a continuing gesture without re-notifying or piling up timers', () => {
    const { signal, time, flips } = setup();

    // A scroll fires input events by the dozen per second. Each one must extend
    // the window in place: no subscriber churn (every notify schedules a drain)
    // and no timer per event.
    signal.mark();
    for (let i = 0; i < 20; i++) {
      time.advance(50);
      signal.mark();
      expect(signal.isInteracting()).toBe(true);
      expect(time.pending()).toBe(1);
    }
    expect(flips).toEqual([true]);

    time.advance(EAGER_SYNC_INTERACTION_QUIET_MS);
    expect(signal.isInteracting()).toBe(false);
    expect(flips).toEqual([true, false]);
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

  it('marks the signal from every bound input event and unbinds cleanly', () => {
    const fake = createFakeTarget();
    const { signal, time } = setup();
    const unbind = bindEagerSyncInteractionSignalToDom(signal, fake.target);

    // Each covers an input modality the others miss: tap, drag, trackpad/mouse
    // scroll, typing. A device that only ever fires one of them still defers.
    for (const eventName of EAGER_SYNC_INTERACTION_EVENTS) {
      fake.dispatch(eventName);
      expect(signal.isInteracting(), eventName).toBe(true);
      time.advance(1_000);
      expect(signal.isInteracting(), eventName).toBe(false);
    }

    unbind();
    fake.dispatch('touchmove');
    expect(fake.count()).toBe(0);
    expect(signal.isInteracting()).toBe(false);
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
});
