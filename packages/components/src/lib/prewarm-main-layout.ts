import { scheduleIdleTask } from './idle-task';

let prewarmStarted = false;

/**
 * Fetches the `main-layout` chunk before the route that needs it is mounted.
 *
 * `_auth.tsx` reaches the workspace through `lazy(() => import(
 * '@/components/main-layout'))`, so a user who signs in pays for that fetch
 * (plus everything the layout pulls in) at the exact moment the route swaps —
 * hundreds of milliseconds to seconds on a cold start or a slow connection,
 * during which the Suspense fallback is all there is to look at. The login
 * page is idle while the user reads it or completes an OAuth round trip, which
 * is the cheapest moment to spend that bandwidth.
 *
 * Idle-scheduled so it never competes with the login page's own first paint,
 * and returns the cancel handle so an unmount before the fetch starts leaves
 * nothing behind. Failures are ignored on purpose: this is a cache warm-up, and
 * the real import re-runs and surfaces its own error.
 */
export function prewarmMainLayoutChunk(): () => void {
  if (prewarmStarted) {
    return () => {};
  }

  return scheduleIdleTask(() => {
    if (prewarmStarted) {
      return;
    }
    prewarmStarted = true;
    void import('@/components/main-layout').catch(() => {});
  });
}
