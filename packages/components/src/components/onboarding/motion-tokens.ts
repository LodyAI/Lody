import { useEffect, useState } from 'react';
import type { Transition } from 'framer-motion';

/**
 * Exact motion tokens from the Onboarding Reorganization specification (§6.1).
 *
 * Reduced motion (`prefers-reduced-motion: reduce`) collapses spatial offsets
 * and scales to pure opacity transitions at half duration, and disables
 * automatic beat advancement on `Arrive`.
 */
export const EASE_OUT = [0.2, 0, 0, 1] as const;
export const EASE_IN = [0.4, 0, 1, 1] as const;

/** Critical-damped spring (`stiffness: 420, damping: 34`) — zero overshoot on landing. */
export const SPRING_CHIP: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 34,
  bounce: 0,
  restDelta: 0.5,
};

export const DUR_PRESS_S = 0.08; // 80ms
export const DUR_OUT_S = 0.14; // 140ms
export const DUR_IN_S = 0.24; // 240ms
export const DUR_IN_DELAY_S = 0.04; // 40ms
export const DUR_HEIGHT_S = 0.22; // 220ms
export const STAGGER_STEP_S = 0.04; // 40ms
export const STAGGER_MAX_ITEMS = 5;
export const HOLD_SUCCESS_MS = 400;
export const CHECK_DRAW_S = 0.22; // 220ms
export const SHAKE_DURATION_S = 0.18; // 180ms
export const ARRIVE_BEAT_MS = 2400; // 2.4s per beat

export function staggerDelay(index: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const clamped = Math.min(Math.max(0, index), STAGGER_MAX_ITEMS - 1);
  return clamped * STAGGER_STEP_S;
}

export function copyEnterProps(reducedMotion: boolean, extraDelay = 0) {
  if (reducedMotion) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: {
        duration: DUR_IN_S * 0.5,
        delay: extraDelay * 0.5,
        ease: EASE_OUT,
      },
    };
  }
  return {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4, transition: { duration: DUR_OUT_S, ease: EASE_IN } },
    transition: {
      duration: DUR_IN_S,
      delay: DUR_IN_DELAY_S + extraDelay,
      ease: EASE_OUT,
    },
  };
}

export function heightTransition(reducedMotion: boolean): Transition {
  return {
    duration: reducedMotion ? DUR_HEIGHT_S * 0.5 : DUR_HEIGHT_S,
    ease: EASE_OUT,
  };
}

export function useOnboardingReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}
