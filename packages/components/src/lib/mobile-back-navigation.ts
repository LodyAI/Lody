/**
 * Single-shot module-level flag that tells the *next* mounted mobile page
 * it is the destination of a back navigation.
 *
 * Why: drill destinations (home, project screen, settings body) re-mount on
 * Back. Left alone, a page with a forward push would slide in from the right
 * while the page being left slides off to the right — an iOS push visual on a
 * pop — and a page without one would just pop into view.
 *
 * `playMobileDrillExit` (`components/mobile/mobile-drill-page-layout.tsx`)
 * calls `markMobileBackNavigation()` right before the route change, for
 * every caller. Each destination calls `consumeMobileBackNavigation()` once
 * on mount, via `useMobileBackRevealClass()` or its own `useState`
 * initializer, so the value is stable across re-renders, then skips its
 * forward push and plays `.mobile-drill-reveal` instead. Nothing clears the
 * flag on a timer, so a destination that mounts late (lazy chunk, async
 * navigate) still sees it. If the destination never consumes it (e.g.
 * Settings closing to Archive), the user's next press clears it, so it
 * cannot turn a later forward push into a reveal.
 *
 * Module-level boolean instead of jotai/context because the lifetime
 * is intentionally one-shot and synchronous — a Provider would just
 * add render-tree plumbing for a flag that only matters during the
 * navigation tick itself.
 */
let suppressNextEnter = false;

function clearOnNextPress(): void {
  suppressNextEnter = false;
}

export function markMobileBackNavigation(): void {
  suppressNextEnter = true;
  /* The Back press itself fired before this mark (click / swipe release),
     so the next press is a new user action: the back navigation is over. */
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', clearOnNextPress, { capture: true, once: true });
  }
}

export function consumeMobileBackNavigation(): boolean {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', clearOnNextPress, { capture: true });
  }
  if (suppressNextEnter) {
    suppressNextEnter = false;
    return true;
  }
  return false;
}
