import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { isNativeAppShell } from '@/lib/native-platform';
import { markMobileBackNavigation } from '@/lib/mobile-back-navigation';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { MobileEdgeBackSwipeZone } from './mobile-edge-back-swipe';

const styles = stylex.create({
  root: {
    position: 'relative',
    height: '100%',
    width: '100%',
    overflow: 'hidden',
    backgroundColor: themeColors.background,
  },
  inner: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    flexDirection: 'column',
    backgroundColor: themeColors.background,
  },
});

export type MobileDrillPageLayoutProps = {
  children: ReactNode;
  /** Optional iOS-style edge-swipe-back handler. When omitted, no
     swipe zone is mounted — the caller might prefer to leave back
     navigation up to the header's chevron / browser history. */
  onBack?: () => void;
};

/* Duration of the exit slide animation. Keep in sync with the
   `.mobile-drill-out` keyframe in `tailwind/index.css`. */
const MOBILE_DRILL_EXIT_MS = 280;

/* Context lets descendants (e.g. a header's chevron back button)
   share the same animated-back trigger as the edge-swipe zone, so
   *every* back affordance runs the same exit transition instead of
   only the one wired in this layout. */
const MobileDrillAnimatedBackContext = createContext<(() => void) | null>(null);

export function useMobileDrillAnimatedBack(): (() => void) | null {
  return useContext(MobileDrillAnimatedBackContext);
}

/**
 * Generic "drill" page layout for mobile detail surfaces (session
 * detail, settings sub-pages, future drill-in routes). Provides:
 *
 *   - Entry: `.mobile-drill-in` CSS keyframe on the inner div (right
 *     → left on mount). Pure CSS so the compositor handles it
 *     regardless of how busy the React tree is during mount.
 *   - Exit: clone-overlay strategy on `document.body`. Snapshot the
 *     live page into a fixed-position clone, slide that off with
 *     `.mobile-drill-out`, and fire the actual route change
 *     *immediately* so the destination paints behind the clone.
 *     Tears the overlay off after the animation duration.
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

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      onBack();
      return;
    }

    const sourceEl = layoutRef.current;
    if (!sourceEl || typeof document === 'undefined') {
      onBack();
      return;
    }

    /* Snapshot the live layout into a body-level overlay. cloneNode
       preserves classes (so Tailwind utilities still resolve) and
       inline DOM state but is a *static* visual — interactions and
       animations on the clone don't keep running. That's fine for a
       280ms slide. */
    const clone = sourceEl.cloneNode(true) as HTMLElement;
    clone.style.position = 'fixed';
    clone.style.inset = '0';
    clone.style.zIndex = '9999';
    /* Non-interactive so the underlying destination route gets
       pointer events from t=0. */
    clone.style.pointerEvents = 'none';
    /* The outer wrapper has bg-background so the page is opaque; on
       the clone we strip that so as the inner div slides away the
       *real* destination behind it is what shows through (otherwise
       the outer's background paints over the destination for the
       full 280ms and reads as a white flash). */
    clone.style.backgroundColor = 'transparent';
    /* Swap drill-in → drill-out on the inner div. The clone inherits
       `.mobile-drill-in`; replacing it with `.mobile-drill-out`
       starts the keyframe at translateX(0) (where the original sits
       at rest) and animates to translateX(100%). */
    const inner = clone.querySelector('.mobile-drill-in');
    if (inner instanceof HTMLElement) {
      inner.classList.remove('mobile-drill-in');
      inner.classList.add('mobile-drill-out');
    }
    document.body.appendChild(clone);

    exitingRef.current = true;
    /* Tell the destination layout (home, project, settings list,
       etc.) that this mount is a *back* navigation so it suppresses
       its own forward-push slide. The clone is already covering the
       destination at t=0, so a destination enter slide would compete
       with the overlay's exit slide. */
    markMobileBackNavigation();
    onBack();

    window.setTimeout(() => {
      clone.remove();
      /* `exitingRef` belongs to the unmounted instance by now, so
         the reset is mostly defensive — but if for some reason the
         layout is still mounted (router error, redirect back to the
         same route), subsequent back clicks should still work. */
      exitingRef.current = false;
    }, MOBILE_DRILL_EXIT_MS);
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
        {...withClassName(stylex.props(styles.root), 'safe-areas')}
      >
        <div {...withClassName(stylex.props(styles.inner), 'mobile-drill-in')}>
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
