import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { isNativeAppShell } from '@/lib/native-platform';
import {
  consumeMobileBackNavigation,
  markMobileBackNavigation,
} from '@/lib/mobile-back-navigation';
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

/* Exit slide and reveal duration. Keep in sync with `.mobile-drill-reveal`
   in `tailwind/index.css`. */
const MOBILE_DRILL_EXIT_MS = 280;
/* Same curve as `.mobile-drill-in` / `.mobile-drill-reveal`. */
const MOBILE_DRILL_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

/* Context lets descendants (e.g. a header's chevron back button)
   share the same animated-back trigger as the edge-swipe zone, so
   *every* back affordance runs the same exit transition instead of
   only the one wired in this layout. */
const noop = () => {};

const MobileDrillAnimatedBackContext = createContext<(() => void) | null>(null);

export function useMobileDrillAnimatedBack(): (() => void) | null {
  return useContext(MobileDrillAnimatedBackContext);
}

/**
 * Pop a mobile "drill" page with the iOS-style exit slide, then run
 * `onBack`. `source` is the page root; its `[data-mobile-drill-panel]`
 * descendant (or the root itself) is the part that slides off.
 *
 * Clone-overlay strategy: snapshot the live page into a fixed overlay on
 * `document.body`, slide that off from wherever the panel currently sits
 * (it may still be mid-enter), and fire the route change *immediately* so
 * the destination paints behind the clone. Without it the page simply
 * unmounts and the destination pops into view.
 *
 * The destination plays the matching parallax itself: the flag set here
 * makes it mount with `useMobileBackRevealClass()`. Animating some ancestor
 * of the source instead would depend on DOM shape: it can unmount with the
 * route, still hold the old page, or be a shared container.
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

  const findPanel = (root: HTMLElement) =>
    root.matches('[data-mobile-drill-panel]')
      ? root
      : root.querySelector<HTMLElement>('[data-mobile-drill-panel]');
  const livePanel = findPanel(source);
  /* Read before cloning: a Back during the enter slide must leave from the
     panel's current offset rather than jump back to fully open. */
  const startTransform = livePanel ? getComputedStyle(livePanel).transform : 'none';

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
  const panel = findPanel(clone);
  if (panel) {
    panel.classList.remove('mobile-drill-in');
    panel.classList.add('mobile-drill-out');
    panel.style.animation = 'none';
  }
  document.body.appendChild(clone);
  panel?.animate(
    [
      { transform: startTransform === 'none' ? 'translate3d(0, 0, 0)' : startTransform },
      { transform: 'translate3d(100%, 0, 0)' },
    ],
    { duration: MOBILE_DRILL_EXIT_MS, easing: MOBILE_DRILL_EASING, fill: 'forwards' }
  );

  /* The destination (home, project screen, settings body) consumes this on
     mount: it skips its forward-push slide and plays the reveal instead. */
  markMobileBackNavigation();
  onBack();

  window.setTimeout(() => {
    clone.remove();
  }, MOBILE_DRILL_EXIT_MS);
  return true;
}

/**
 * Back affordance for a drill page rooted at `sourceRef`: plays
 * `playMobileDrillExit` once and ignores repeat taps until the slide ends,
 * so a double tap cannot spawn two clones or navigate twice.
 */
export function useMobileDrillExit(
  sourceRef: RefObject<HTMLElement | null>,
  onBack: (() => void) | undefined
): (() => void) | null {
  const exitingRef = useRef(false);
  const animatedBack = useCallback(() => {
    if (!onBack || exitingRef.current) return;
    if (!playMobileDrillExit(sourceRef.current, onBack)) return;
    exitingRef.current = true;
    /* Reset in case the page stays mounted (router error, redirect back to
       the same route), so later taps still work. */
    window.setTimeout(() => {
      exitingRef.current = false;
    }, MOBILE_DRILL_EXIT_MS);
  }, [onBack, sourceRef]);
  return onBack ? animatedBack : null;
}

/**
 * For a page that can be the destination of a drill Back: consumes the
 * back-navigation flag once on mount. Returns the class that plays the
 * iOS-style parallax (in from a dimmed, left-shifted position) when this
 * mount is a back destination, else `null`.
 */
export function useMobileBackRevealClass(): string | null {
  const [reveal] = useState(() => consumeMobileBackNavigation());
  return reveal ? 'mobile-drill-reveal' : null;
}

/**
 * Generic "drill" page layout for mobile detail surfaces (session
 * detail, settings sub-pages, future drill-in routes). Provides:
 *
 *   - Entry: `.mobile-drill-in` CSS keyframe on the inner div (right
 *     → left on mount). Pure CSS so the compositor handles it
 *     regardless of how busy the React tree is during mount.
 *   - Exit: `playMobileDrillExit` (clone overlay slid off while the
 *     destination paints behind it and plays its reveal).
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
  const contextValue = useMobileDrillExit(layoutRef, onBack);
  const animatedBack = contextValue ?? noop;

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
        <div
          data-mobile-drill-panel=""
          {...withClassName(stylex.props(styles.inner), 'mobile-drill-in')}
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
