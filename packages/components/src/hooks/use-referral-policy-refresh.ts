import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { getServerNow } from '@lody/shared';

/** Convex subscriptions do not rerun merely because a campaign boundary passes. */
export function useReferralPolicyRefresh(
  nextChangeAt: number | undefined,
  refresh: Dispatch<SetStateAction<number>>
) {
  useEffect(() => {
    if (nextChangeAt === undefined || !Number.isFinite(nextChangeAt)) return undefined;

    const check = () => {
      if (getServerNow() >= nextChangeAt) {
        refresh((value) => value + 1);
      }
    };
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          check();
          schedule();
        },
        Math.max(1000, Math.min(nextChangeAt - getServerNow(), 2147483647))
      );
    };
    schedule();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [nextChangeAt, refresh]);
}
