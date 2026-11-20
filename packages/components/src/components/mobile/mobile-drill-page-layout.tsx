import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react';
import { isNativeAppShell } from '@/lib/native-platform';
import {
  consumeMobileBackNavigation,
  markMobileBackNavigation,
} from '@/lib/mobile-back-navigation';
import { MobileEdgeBackSwipeZone } from './mobile-edge-back-swipe';

export type MobileDrillPageLayoutProps = {
  children: ReactNode;
  /** Optional iOS-style edge-swipe-back handler. When omitted, no
     swipe zone is mounted — the caller might prefer to leave back
     navigation up to the header's chevron / browser history. */
  onBack?: () => void;
};

/* Duration of the exit slide animation. Keep in sync with the
   `.mobile-drill-out` keyframe in `tailwind/index.css`. */
export const MOBILE_DRILL_EXIT_MS = 280;
/* Same curve as `.mobile-drill-out`. */
const MOBILE_DRILL_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

/* Context lets descendants (e.g. a header's chevron back button)
   share the same animated-back trigger as the edge-swipe zone, so
   *every* back affordance runs the same exit transition instead of
   only the one wired in this layout. */
const MobileDrillAnimatedBackContext = createContext<(() => void) | null>(null);

export function useMobileDrillAnimatedBack(): (() => void) | null {
  return useContext(MobileDrillAnimatedBackContext);
}

/**
 * Pop a mobile "drill" page with the iOS-style exit slide, then run
 * `onBack`. `source` is the page root; its `[data-mobile-drill-panel]`
 * descendant (or the root itself) is the part that slides off, while the
 * page underneath eases in from a dimmed, left-shifted position.
 *
 * Clone-overlay strategy: snapshot the live page into a fixed overlay on
 * `document.body`, slide that off with `.mobile-drill-out`, and fire the
 * route change *immediately* so the destination paints behind the clone.
 * Without it the page simply unmounts and the destination pops into view.
 *
 * Returns `true` when the exit slide plays, `false` when `onBack` ran
 * directly (reduced motion, no DOM).
 */
export function playMobileDrillExit(source: HTMLElement | null, onBack: () => void): boolean {
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion || !source || typeof document === 'undefined') {
    onBack();
    return false;
  }

  /* cloneNode preserves classes (so Tailwind utilities still resolve)
     but is a *static* visual — fine for a 280ms slide. */
  const clone = source.cloneNode(true) as HTMLElement;
  clone.style.position = 'fixed';
  clone.style.inset = '0';
  clone.style.zIndex = '9999';
  /* Non-interactive so the destination gets pointer events from t=0. */
  clone.style.pointerEvents = 'none';
  /* Strip the root's opaque background so the *real* destination shows
     through as the panel slides away instead of a blank sheet. */
  clone.style.backgroundColor = 'transparent';
  const panel = clone.matches('[data-mobile-drill-panel]')
    ? clone
    : clone.querySelector<HTMLElement>('[data-mobile-drill-panel]');
  if (panel) {
    panel.classList.remove('mobile-drill-in');
    panel.classList.add('mobile-drill-out');
  }
  document.body.appendChild(clone);

  /* iOS-style parallax: the page underneath starts shifted left and dimmed,
     then settles into place as the clone slides off. The source's parent
     survives the route change (it is the slot the destination renders into,
     or the still-mounted layout for in-surface pops), so animating it moves
     whatever page appears there. WAAPI with no fill leaves no inline style. */
  const underlay = source.parentElement;
  if (underlay && underlay !== document.body && typeof underlay.animate === 'function') {
    underlay.animate(
      [
        { transform: 'translate3d(-28%, 0, 0)', opacity: 0.72 },
        { transform: 'translate3d(0, 0, 0)', opacity: 1 },
      ],
      { duration: MOBILE_DRILL_EXIT_MS, easing: MOBILE_DRILL_EASING }
    );
  }

  /* Tell a destination that replays a forward-push slide on mount
     (project screen, settings body) that this mount is a *back*
     navigation; the clone already covers it. */
  markMobileBackNavigation();
  onBack();

  window.setTimeout(() => {
    clone.remove();
    /* Destinations without an enter slide (home) never consume the flag;
       clear it so the next forward push still animates. */
    consumeMobileBackNavigation();
  }, MOBILE_DRILL_EXIT_MS);
  return true;
}

/**
 * Generic "drill" page layout for mobile detail surfaces (session
 * detail, settings sub-pages, future drill-in routes). Provides:
 *
 *   - Entry: `.mobile-drill-in` CSS keyframe on the inner div (right
 *     → left on mount). Pure CSS so the compositor handles it
 *     regardless of how busy the React tree is during mount.
 *   - Exit: `playMobileDrillExit` (clone overlay slid off with
 *     `.mobile-drill-out` while the destination paints behind it).
 *   - Edge-swipe-back zone (native iOS only) wired to the same
 *     animatedBack as the rest.
 *
 * Descendants that need to trigger the animated back (e.g. a header
 * chevron) read it from `useMobileDrillAnimatedBack()`.
 */
export function MobileDrillPageLayout({ children, onBack }: MobileDrillPageLayoutProps) {
  /* CSS keyframes + a clone overlay avoid the heavy-mount stutter we
     saw with framer-motion and the forced destination slide from the
     View Transitions API on iOS WebKit 18. The clone keeps the
     destination visible underneath with no white flash. */
  const layoutRef = useRef<HTMLDivElement>(null);
  const exitingRef = useRef(false);

  const animatedBack = useCallback(() => {
    if (!onBack || exitingRef.current) return;
    if (playMobileDrillExit(layoutRef.current, onBack)) {
      exitingRef.current = true;
      /* `exitingRef` belongs to the unmounted instance once the route
         changes; resetting it keeps back working if the layout stays
         mounted (router error, redirect back to the same route). */
      window.setTimeout(() => {
        exitingRef.current = false;
      }, MOBILE_DRILL_EXIT_MS);
    }
  }, [onBack]);

  const contextValue = onBack ? animatedBack : null;

  return (
    /* Outer wrapper carries `overflow-hidden` so the entry slide
       doesn't paint outside the viewport, and `bg-background` keeps
       the mount/unmount frames theme-colored instead of flashing
       white. The exit slide happens on the clone in `body`, not on
       this element. */
    <MobileDrillAnimatedBackContext.Provider value={contextValue}>
      <div
        ref={layoutRef}
        /* `safe-areas` opts into Konsta's safe-area CSS variables
           (`--k-safe-area-top`, `--k-safe-area-bottom`, etc.) for
           every descendant. Without it the Tailwind utilities like
           `pt-safe-*` resolve to 0 and the headers/content end up
           tucked under the notch on iOS. The home screen does the
           same opt-in on its root container — see
           `mobile-home-screen.tsx`. */
        className="safe-areas relative h-full w-full overflow-hidden bg-background"
      >
        <div
          data-mobile-drill-panel=""
          className="mobile-drill-in relative flex h-full flex-col bg-background"
        >
          {onBack ? (
            <MobileEdgeBackSwipeZone
              isNativeApp={isNativeAppShell()}
              onBack={animatedBack}
              zIndex={30}
            />
          ) : null}
          {children}
        </div>
      </div>
    </MobileDrillAnimatedBackContext.Provider>
  );
}
