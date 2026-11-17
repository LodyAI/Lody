import { isAppForeground } from '@/lib/session-completion-notification';

/** Focus flapping (alt-tab bursts) collapses into at most one presence write per window. */
export const DESKTOP_FOREGROUND_DEBOUNCE_MS = 1_000;
/**
 * A focused window without keyboard/pointer input for this long no longer counts:
 * a locked screen or an abandoned desk may keep the window focused, and the user
 * then expects the phone to ring.
 */
export const DESKTOP_FOREGROUND_IDLE_MS = 5 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 15_000;

export type DesktopForegroundEnvironment = {
  /** Window visible and focused. */
  isForeground(): boolean;
  now(): number;
  /** Subscribe to focus/visibility transitions and to user input; returns the unsubscribe. */
  subscribe(listeners: { onFocusChange: () => void; onInput: () => void }): () => void;
};

/**
 * Keeps this window's `desktop-foreground` presence entry in step with whether the
 * user is actually at it. `publish(userId)` sets the entry and `publish(null)`
 * deletes it; it is only called on a state change, so the presence write rate is
 * bounded by the debounce rather than by event frequency. Returns the stop
 * function, which clears a published entry.
 */
export function startDesktopForegroundPublisher(args: {
  userId: string;
  publish: (userId: string | null) => void;
  env: DesktopForegroundEnvironment;
}): () => void {
  const { userId, publish, env } = args;
  let lastInputAt = env.now();
  let published = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const desired = () => env.isForeground() && env.now() - lastInputAt < DESKTOP_FOREGROUND_IDLE_MS;
  const apply = () => {
    debounceTimer = null;
    const want = desired();
    if (want === published) return;
    published = want;
    publish(want ? userId : null);
  };
  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(apply, DESKTOP_FOREGROUND_DEBOUNCE_MS);
  };

  const unsubscribe = env.subscribe({
    onFocusChange: schedule,
    onInput: () => {
      lastInputAt = env.now();
      // Only input that ends an idle period can change the verdict.
      if (!published && !debounceTimer && env.isForeground()) schedule();
    },
  });
  const idleCheck = setInterval(() => {
    if (published && !desired()) apply();
  }, IDLE_CHECK_INTERVAL_MS);
  apply();

  return () => {
    unsubscribe();
    clearInterval(idleCheck);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (published) publish(null);
    published = false;
  };
}

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

export function createBrowserDesktopForegroundEnvironment(): DesktopForegroundEnvironment {
  return {
    isForeground: isAppForeground,
    now: () => Date.now(),
    subscribe: ({ onFocusChange, onInput }) => {
      const options = { capture: true, passive: true } as const;
      window.addEventListener('focus', onFocusChange);
      window.addEventListener('blur', onFocusChange);
      document.addEventListener('visibilitychange', onFocusChange);
      for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, options);
      return () => {
        window.removeEventListener('focus', onFocusChange);
        window.removeEventListener('blur', onFocusChange);
        document.removeEventListener('visibilitychange', onFocusChange);
        for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, options);
      };
    },
  };
}
