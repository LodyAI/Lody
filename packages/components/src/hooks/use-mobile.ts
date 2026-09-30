import * as React from 'react';
import { MOBILE_LAYOUT_BREAKPOINT } from '@lody/shared/layout';
import { detectAppDeviceClass, isDesktopLayoutShell } from '@/lib/device-class';

/**
 * Which layout family renders: the mobile renderer or the desktop renderer.
 * Width alone never decides it — the breakpoint only applies to devices that
 * are NOT desktop-class:
 *
 * - a desktop-class device — a desktop browser OR a desktop layout shell like
 *   Electron (`isDesktopLayoutShell()` covers shells whose UA does not parse
 *   to 'desktop') — keeps the desktop renderer at every width; a narrow
 *   window takes the COMPACT desktop presentation (`useIsCompactDesktop`)
 *   instead of a mobile UI that would remount the whole layout tree
 *   mid-resize;
 * - phones, tablets and unrecognized devices keep the viewport breakpoint:
 *   narrow means the touch-first mobile renderer, while a phone rotated wide
 *   enough (or docked to a big screen) gets the real desktop renderer.
 *
 * Width-driven adaptation inside the desktop family belongs to local queries
 * (matchMedia / container queries), never to this hook — see
 * `useNarrowDialogLayout` and `useIsMentionMobile` for that precedent.
 * Native-only behavior should still use `isNativeAppShell()` separately.
 *
 * Context value:
 * - `true`  — force mobile layout (landing phone frame)
 * - `false` — force desktop layout (landing worktree/diff/design demos on phones)
 * - `null`  — follow device/shell detection
 */
const ForceMobileLayoutContext = React.createContext<boolean | null>(null);

export function ForceMobileLayoutProvider({
  force,
  children,
}: {
  force: boolean;
  children: React.ReactNode;
}) {
  // Only force mobile when `force` is true. `force={false}` leaves the viewport
  // in charge (same as no provider) so callers can wrap optionally.
  return React.createElement(
    ForceMobileLayoutContext.Provider,
    { value: force ? true : null },
    children
  );
}

/** Force the desktop (wide) layout regardless of viewport width. */
export function ForceDesktopLayoutProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(ForceMobileLayoutContext.Provider, { value: false }, children);
}

export function checkIsMobileDevice(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  if (detectAppDeviceClass() === 'desktop' || isDesktopLayoutShell()) return false;
  return window.innerWidth < MOBILE_LAYOUT_BREAKPOINT;
}

/**
 * Compact desktop: the desktop renderer at a viewport below
 * MOBILE_LAYOUT_BREAKPOINT. Reachable wherever the desktop family survives
 * narrow widths — any desktop-class device (Electron shell or desktop
 * browser) or a ForceDesktop context — while tablets and phones at that width
 * take the mobile renderer instead.
 */
export function checkIsCompactDesktop(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.innerWidth < MOBILE_LAYOUT_BREAKPOINT && !checkIsMobileDevice();
}

function useViewportLayoutFlags(): { isMobile: boolean; belowBreakpoint: boolean } {
  const [flags, setFlags] = React.useState(() => ({
    isMobile: checkIsMobileDevice(),
    belowBreakpoint: typeof window !== 'undefined' && window.innerWidth < MOBILE_LAYOUT_BREAKPOINT,
  }));

  React.useEffect(() => {
    const update = () => {
      const next = {
        isMobile: checkIsMobileDevice(),
        belowBreakpoint: window.innerWidth < MOBILE_LAYOUT_BREAKPOINT,
      };
      // Bail out on unchanged flags: continuous resize fires per frame but
      // only a breakpoint crossing may re-render subscribed surfaces.
      setFlags((prev) =>
        prev.isMobile === next.isMobile && prev.belowBreakpoint === next.belowBreakpoint
          ? prev
          : next
      );
    };

    // matchMedia fires when crossing the breakpoint threshold (efficient for desktop resizing)
    const mql = window.matchMedia(`(max-width: ${MOBILE_LAYOUT_BREAKPOINT - 1}px)`);
    mql.addEventListener('change', update);

    // resize fires after viewport dimensions are fully updated, which is needed
    // because on mobile orientation changes matchMedia can fire before
    // window.innerWidth reflects the new dimensions
    window.addEventListener('resize', update);

    update();
    return () => {
      mql.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return flags;
}

export function useIsMobile() {
  const forced = React.useContext(ForceMobileLayoutContext);
  const { isMobile } = useViewportLayoutFlags();

  if (forced !== null) return forced;
  return isMobile;
}

/**
 * The compact desktop presentation: desktop layout family with a viewport
 * below MOBILE_LAYOUT_BREAKPOINT. Surfaces adapt within the desktop family —
 * navigation and session side panels become overlays — rather than flipping
 * to the mobile renderer. Always false while `useIsMobile()` resolves true.
 */
export function useIsCompactDesktop() {
  const forced = React.useContext(ForceMobileLayoutContext);
  const { isMobile, belowBreakpoint } = useViewportLayoutFlags();

  const resolvedMobile = forced ?? isMobile;
  return !resolvedMobile && belowBreakpoint;
}
