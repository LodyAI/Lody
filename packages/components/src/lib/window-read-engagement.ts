import { useCallback, useEffect, useRef, useState } from 'react';
import type { ElectronPowerState } from '@lody/shared/electron-ipc';
import { onIpcEvent } from '@/lib/electron-ipc-client';
import { isAppForeground } from '@/lib/session-completion-notification';

/**
 * A foreground window that receives no page interaction for this long stops
 * automatically marking newly arriving messages as read until the user
 * interacts with the page again.
 */
export const READ_INTERACTION_IDLE_MS = 2 * 60_000;

/**
 * Clicking inside an unfocused window can dispatch `pointerdown` / `touchstart`
 * just before `window` `focus` settles. Coalesce within this brief window so
 * clicking directly into an inactive conversation window still counts as a
 * page interaction on activation.
 */
export const ACTIVATION_INTERACTION_COALESCE_MS = 200;

const READ_INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'click'] as const;

export type WindowReadEngagementState = {
  /** Host window/tab is visible, focused, and neither suspended nor locked. */
  isWindowActive: boolean;
  /** User interacted with the page during this active window visit (within idle limit). */
  hasPageInteraction: boolean;
};

export type WindowReadEngagementEnvironment = {
  isForeground(): boolean;
  now(): number;
  subscribe(listeners: {
    onFocusChange: () => void;
    onInput: (type: string) => void;
    onPowerState: (state: ElectronPowerState) => void;
  }): () => void;
};

export type WindowReadEngagementTracker = {
  getState(): WindowReadEngagementState;
  subscribe(listener: (state: WindowReadEngagementState) => void): () => void;
  dispose(): void;
};

/**
 * Tracks whether the host window is active in the foreground AND has received
 * page interaction during the current active visit.
 */
export function createWindowReadEngagementTracker(
  env: WindowReadEngagementEnvironment,
  options: { idleMs?: number; coalesceMs?: number } = {}
): WindowReadEngagementTracker {
  const idleMs = options.idleMs ?? READ_INTERACTION_IDLE_MS;
  const coalesceMs = options.coalesceMs ?? ACTIVATION_INTERACTION_COALESCE_MS;

  let suspended = false;
  let locked = false;
  let hasInteractedSinceActive = false;
  let lastInteractionAt: number | null = null;
  let lastPreFocusPointerAt: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(state: WindowReadEngagementState) => void>();

  const computeActive = () => !suspended && !locked && env.isForeground();

  const clearIdleTimer = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const syncAndRead = (): WindowReadEngagementState => {
    const nowMs = env.now();
    const isWindowActive = computeActive();
    if (!isWindowActive) {
      hasInteractedSinceActive = false;
      clearIdleTimer();
      return { isWindowActive: false, hasPageInteraction: false };
    }
    if (
      hasInteractedSinceActive &&
      (lastInteractionAt === null || nowMs - lastInteractionAt >= idleMs)
    ) {
      hasInteractedSinceActive = false;
      clearIdleTimer();
    }
    return {
      isWindowActive: true,
      hasPageInteraction: hasInteractedSinceActive,
    };
  };

  let lastEmitted: WindowReadEngagementState = syncAndRead();

  const emitIfChanged = () => {
    const next = syncAndRead();
    if (
      next.isWindowActive === lastEmitted.isWindowActive &&
      next.hasPageInteraction === lastEmitted.hasPageInteraction
    ) {
      return;
    }
    lastEmitted = next;
    for (const listener of listeners) {
      listener(next);
    }
  };

  const scheduleIdleTimer = (delayMs: number) => {
    clearIdleTimer();
    idleTimer = setTimeout(
      () => {
        idleTimer = null;
        if (!hasInteractedSinceActive || !computeActive() || lastInteractionAt === null) {
          emitIfChanged();
          return;
        }
        const remaining = lastInteractionAt + idleMs - env.now();
        if (remaining > 0) {
          scheduleIdleTimer(remaining);
          return;
        }
        emitIfChanged();
      },
      Math.max(0, delayMs)
    );
  };

  const armInteraction = (timestampMs: number) => {
    hasInteractedSinceActive = true;
    lastInteractionAt = timestampMs;
    if (idleTimer === null) {
      scheduleIdleTimer(idleMs);
    }
  };

  const handleFocusChange = () => {
    const nowMs = env.now();
    if (!computeActive()) {
      hasInteractedSinceActive = false;
      clearIdleTimer();
      emitIfChanged();
      return;
    }
    if (
      !hasInteractedSinceActive &&
      lastPreFocusPointerAt !== null &&
      nowMs - lastPreFocusPointerAt <= coalesceMs
    ) {
      const pointerAt = lastPreFocusPointerAt;
      lastPreFocusPointerAt = null;
      armInteraction(pointerAt);
    } else {
      lastPreFocusPointerAt = null;
    }
    emitIfChanged();
  };

  const unsubscribeEnv = env.subscribe({
    onFocusChange: handleFocusChange,
    onInput: (type) => {
      const nowMs = env.now();
      if (env.isForeground()) {
        // Real foreground user input proves the OS is neither suspended nor
        // screen-locked, recovering from a missed resume/unlock power event.
        suspended = false;
        locked = false;
      }
      if (!computeActive()) {
        // Track only direct pointer/touch presses so clicking into an unfocused
        // window's content area still registers if `focus` fires slightly after.
        if (type === 'pointerdown' || type === 'touchstart') {
          lastPreFocusPointerAt = nowMs;
        }
        return;
      }
      // Flush any elapsed idle expiration into lastEmitted before re-arming so
      // subscribers receive a single transition to active engagement.
      lastEmitted = syncAndRead();
      lastPreFocusPointerAt = null;
      armInteraction(nowMs);
      emitIfChanged();
    },
    onPowerState: (state) => {
      if (state === 'suspend') suspended = true;
      else if (state === 'resume') suspended = false;
      else if (state === 'lock-screen') locked = true;
      else locked = false;
      handleFocusChange();
    },
  });

  return {
    getState: () => syncAndRead(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      unsubscribeEnv();
      clearIdleTimer();
      listeners.clear();
    },
  };
}

export function createBrowserWindowReadEngagementEnvironment(): WindowReadEngagementEnvironment {
  return {
    isForeground: isAppForeground,
    now: () => Date.now(),
    subscribe: ({ onFocusChange, onInput, onPowerState }) => {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        return () => {};
      }
      const options = { capture: true, passive: true } as const;
      const inputHandlers = READ_INTERACTION_EVENTS.map((type) => {
        const handler = () => onInput(type);
        window.addEventListener(type, handler, options);
        return { type, handler };
      });
      window.addEventListener('focus', onFocusChange);
      window.addEventListener('blur', onFocusChange);
      document.addEventListener('visibilitychange', onFocusChange);
      const stopPower = window.ipc ? onIpcEvent('app.powerState', onPowerState) : () => {};
      return () => {
        stopPower();
        window.removeEventListener('focus', onFocusChange);
        window.removeEventListener('blur', onFocusChange);
        document.removeEventListener('visibilitychange', onFocusChange);
        for (const { type, handler } of inputHandlers) {
          window.removeEventListener(type, handler, options);
        }
      };
    },
  };
}

let sharedTracker: WindowReadEngagementTracker | null = null;
let sharedSubscriberCount = 0;

function acquireSharedWindowReadEngagementTracker(): {
  tracker: WindowReadEngagementTracker;
  release: () => void;
} {
  if (!sharedTracker) {
    sharedTracker = createWindowReadEngagementTracker(
      createBrowserWindowReadEngagementEnvironment()
    );
  }
  sharedSubscriberCount += 1;
  const tracker = sharedTracker;
  let released = false;
  return {
    tracker,
    release: () => {
      if (released) return;
      released = true;
      sharedSubscriberCount = Math.max(0, sharedSubscriberCount - 1);
      if (sharedSubscriberCount === 0 && sharedTracker) {
        sharedTracker.dispose();
        sharedTracker = null;
      }
    },
  };
}

/**
 * Keeps the shared window read-engagement tracker mounted at a layout root
 * without subscribing the root component to state re-renders.
 */
export function useObserveWindowReadEngagement(): void {
  useEffect(() => {
    const { release } = acquireSharedWindowReadEngagementTracker();
    return release;
  }, []);
}

/**
 * Observes whether the current browser/Electron window is active in the
 * foreground and has received page interaction.
 */
export function useWindowReadEngagement(): WindowReadEngagementState & {
  /** Increments on each emitted engagement transition so effects re-run even after a clock-jump re-arm. */
  engagementRevision: number;
  getLatestState: () => WindowReadEngagementState;
} {
  const trackerRef = useRef<WindowReadEngagementTracker | null>(null);
  const [snapshot, setSnapshot] = useState<{
    state: WindowReadEngagementState;
    revision: number;
  }>(() => ({
    state: sharedTracker
      ? sharedTracker.getState()
      : { isWindowActive: isAppForeground(), hasPageInteraction: false },
    revision: 0,
  }));

  useEffect(() => {
    const { tracker: acquired, release } = acquireSharedWindowReadEngagementTracker();
    trackerRef.current = acquired;
    const latest = acquired.getState();
    setSnapshot((current) =>
      current.state.isWindowActive === latest.isWindowActive &&
      current.state.hasPageInteraction === latest.hasPageInteraction
        ? current
        : { state: latest, revision: current.revision + 1 }
    );
    const unsubscribe = acquired.subscribe((next) => {
      setSnapshot((current) => ({
        state: next,
        revision: current.revision + 1,
      }));
    });
    return () => {
      unsubscribe();
      if (trackerRef.current === acquired) {
        trackerRef.current = null;
      }
      release();
    };
  }, []);

  const getLatestState = useCallback(() => {
    const activeTracker = trackerRef.current ?? sharedTracker;
    return activeTracker
      ? activeTracker.getState()
      : { isWindowActive: isAppForeground(), hasPageInteraction: false };
  }, []);

  return {
    ...snapshot.state,
    engagementRevision: snapshot.revision,
    getLatestState,
  };
}
