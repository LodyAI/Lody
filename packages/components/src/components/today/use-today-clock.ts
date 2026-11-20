import { createContext, useContext, useEffect, useState } from 'react';
import type { TodayDate } from '@lody/shared';
import { localTodayDate, msUntilNextLocalMidnight } from './today-stream';

/** Fallback poll in case a sleeping timer missed midnight. */
const TODAY_CLOCK_FALLBACK_MS = 60_000;

/**
 * The viewer's local date, rolling over at local midnight and rechecked when
 * the window becomes visible or focused again (sleep, resume).
 */
export function useTodayClock(now: () => Date = () => new Date()): TodayDate {
  const [today, setToday] = useState(() => localTodayDate(now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const current = now();
      setToday(localTodayDate(current));
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, msUntilNextLocalMidnight(current) + 50);
    };
    check();
    const interval = setInterval(check, TODAY_CLOCK_FALLBACK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, [now]);
  return today;
}

/** Minute tick shared by a whole Today surface (snooze countdowns, Later expiry). */
export const TodayNowContext = createContext<number | null>(null);

/** The surface's minute clock: one interval per surface, never one per mention. */
export function useTodayMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TODAY_CLOCK_FALLBACK_MS);
    return () => clearInterval(interval);
  }, []);
  return now;
}

/**
 * Now, read fresh on every render. The surface's minute tick only makes
 * mentions re-render; reading its (up to a minute old) value would round a
 * just-chosen "Later today" countdown up an extra hour.
 */
export function useTodayNow(): number {
  const tick = useContext(TodayNowContext);
  return Math.max(tick ?? 0, Date.now());
}
