export type AppDeviceClass = 'mobile' | 'desktop' | 'tablet' | 'unknown';

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    mobile?: boolean;
  };
};

export function detectAppDeviceClass(): AppDeviceClass {
  if (typeof window === 'undefined') {
    return 'unknown';
  }

  const navigator = window.navigator as NavigatorWithUserAgentData;
  if (navigator.userAgentData?.mobile === true) {
    return 'mobile';
  }

  const userAgent = navigator.userAgent.toLowerCase();
  if (
    /ipad|tablet|playbook|silk/.test(userAgent) ||
    (/android/.test(userAgent) && !/mobile/.test(userAgent))
  ) {
    return 'tablet';
  }

  if (/mobi|iphone|ipod|android/.test(userAgent)) {
    return 'mobile';
  }

  return 'desktop';
}

/**
 * Shells that always keep the desktop layout family regardless of viewport
 * width. `detectAppDeviceClass() === 'desktop'` already covers a normal
 * Electron or desktop-browser window; this preload-global check is the
 * explicit fallback for shells whose UA does not parse to 'desktop'. A narrow
 * window there takes the compact desktop presentation, never the mobile
 * renderer. Kept free of imports so `use-mobile.ts` stays lightweight in
 * every bundle and test graph; lib/electron.ts owns the richer Electron API
 * surface.
 */
export function isDesktopLayoutShell(): boolean {
  return typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
}
