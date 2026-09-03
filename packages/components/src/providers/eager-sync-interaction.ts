/**
 * "The user is busy right now" signal for background eager-sync.
 *
 * Every eager-sync prefetch opens a Loro doc, which deserializes on the main
 * thread. Doing that while someone is dragging a list or typing is what makes a
 * syncing app feel frozen, so the coordinator consumes this signal and starts
 * nothing new until the gesture settles.
 *
 * The signal is deliberately driven by DIRECT MANIPULATION events only
 * (`touchmove`, `wheel`, `pointerdown`, `keydown`) and never by `scroll`:
 * the conversation view auto-scrolls itself while an agent streams, and a
 * `scroll` listener would read that as continuous user input and starve
 * background sync for as long as any session is running.
 *
 * The factory is pure and dependency-injected (clock + scheduler); the DOM
 * binding is a separate function so the signal itself is unit-testable.
 */

/**
 * Quiet period after the last input before background work may resume. Long
 * enough to cover inertial scrolling after a flick, which produces no further
 * input events of its own.
 */
export const EAGER_SYNC_INTERACTION_QUIET_MS = 1_000;

/** Direct-manipulation events that mark the user as busy. */
export const EAGER_SYNC_INTERACTION_EVENTS = [
  'pointerdown',
  'touchmove',
  'wheel',
  'keydown',
] as const;

export interface EagerSyncInteractionSignal {
  isInteracting(): boolean;
  /** Fires when the interacting/idle state flips. Returns an unsubscribe fn. */
  subscribe(onChange: () => void): () => void;
  /** Record user input now. */
  mark(): void;
  dispose(): void;
}

export interface EagerSyncInteractionSignalOptions {
  quietMs?: number;
  clock?: { now(): number };
  scheduler?: {
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export function createEagerSyncInteractionSignal(
  options: EagerSyncInteractionSignalOptions = {}
): EagerSyncInteractionSignal {
  const quietMs = Math.max(0, options.quietMs ?? EAGER_SYNC_INTERACTION_QUIET_MS);
  const clock = options.clock ?? { now: () => Date.now() };
  const scheduler = options.scheduler ?? {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  const listeners = new Set<() => void>();
  let lastMarkAt: number | null = null;
  let quietTimer: unknown | null = null;
  // Last value broadcast to subscribers, so a flip notifies exactly once.
  let reported = false;
  let disposed = false;

  const evaluate = (): boolean => lastMarkAt !== null && clock.now() - lastMarkAt < quietMs;

  const clearQuietTimer = () => {
    if (quietTimer !== null) {
      scheduler.clearTimeout(quietTimer);
      quietTimer = null;
    }
  };

  const sync = () => {
    const next = evaluate();
    if (next !== reported) {
      reported = next;
      for (const listener of Array.from(listeners)) {
        listener();
      }
    }
    clearQuietTimer();
    if (next && lastMarkAt !== null) {
      // One timer per quiet period, re-armed on the next mark rather than per event.
      quietTimer = scheduler.setTimeout(() => {
        quietTimer = null;
        sync();
      }, Math.max(0, lastMarkAt + quietMs - clock.now()));
    }
  };

  return {
    isInteracting: evaluate,
    subscribe(onChange: () => void) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    mark() {
      if (disposed) {
        return;
      }
      lastMarkAt = clock.now();
      sync();
    },
    dispose() {
      disposed = true;
      clearQuietTimer();
      lastMarkAt = null;
      reported = false;
      listeners.clear();
    },
  };
}

type EagerSyncInteractionTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Feed a signal from real input events. Returns an unbind fn.
 *
 * Listeners are passive (they never affect the gesture) and CAPTURING, so input
 * still counts when an app-level handler stops its propagation — a swallowed
 * keystroke is still the user typing.
 */
export function bindEagerSyncInteractionSignalToDom(
  signal: EagerSyncInteractionSignal,
  target: EagerSyncInteractionTarget
): () => void {
  const onInput = () => signal.mark();
  const listenerOptions = { passive: true, capture: true } as const;
  for (const eventName of EAGER_SYNC_INTERACTION_EVENTS) {
    target.addEventListener(eventName, onInput, listenerOptions);
  }
  return () => {
    for (const eventName of EAGER_SYNC_INTERACTION_EVENTS) {
      target.removeEventListener(eventName, onInput, listenerOptions);
    }
  };
}
