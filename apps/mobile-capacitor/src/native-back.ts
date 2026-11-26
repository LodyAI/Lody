import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
  dispatchMobileBack,
  markMobileBackNavigation,
} from '@lody/components/lib/mobile-back-navigation';

export type AndroidBackLocation = {
  readonly pathname: string;
  readonly search?: unknown;
};

export type AndroidBackRouter = {
  readonly state: {
    readonly location: AndroidBackLocation;
  };
  readonly history: {
    readonly back: () => void;
  };
};

const NON_ROOT_SINGLE_SEGMENTS = new Set([
  'complete-email',
  'device',
  'email-verified',
  'forgot-password',
  'recovery',
  'reset-password',
]);

function hasNonEmptySearchParam(search: unknown, key: string): boolean {
  if (typeof search !== 'object' || search === null) return false;
  const value = (search as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0;
}

/**
 * True when the current route is a top-level entry screen (home tabs, login,
 * onboarding) where Android Back should minimize the app instead of replaying
 * stale WebView history entries.
 */
export function isRootAndroidBackLocation(location: AndroidBackLocation): boolean {
  const segments = location.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.length === 1) return !NON_ROOT_SINGLE_SEGMENTS.has(segments[0] ?? '');
  if (segments.length === 2 && segments[1] === 'chat') {
    return (
      !hasNonEmptySearchParam(location.search, 'project') &&
      !hasNonEmptySearchParam(location.search, 'repo')
    );
  }
  return false;
}

export function handleNativeAndroidBack({
  canGoBack,
  location,
  historyBack,
  minimizeApp,
}: {
  readonly canGoBack: boolean;
  readonly location: AndroidBackLocation;
  readonly historyBack: () => void;
  readonly minimizeApp: () => Promise<void> | void;
}): void {
  if (dispatchMobileBack()) return;
  if (isRootAndroidBackLocation(location)) {
    void minimizeApp();
    return;
  }
  if (canGoBack) {
    markMobileBackNavigation();
    historyBack();
    return;
  }
  void minimizeApp();
}

/**
 * Routes Android's hardware/gesture back (`OnBackPressedDispatcher` ->
 * Capacitor `backButton`) through Lody's shared mobile back stack instead of
 * Capacitor's default `webView.goBack()` fallback.
 *
 * Without this listener, `AppPlugin` pops WebView history directly, bypassing
 * `playMobileDrillExit()`, Vaul drawer closes, and state-only overlays so the
 * destination screen mounts without `markMobileBackNavigation()` and slides in
 * from right to left as if pushed forward.
 */
export function initNativeBackNavigation(router: AndroidBackRouter): () => Promise<void> {
  if (Capacitor.getPlatform() !== 'android') {
    return async () => {};
  }

  let disposed = false;
  const listener = App.addListener('backButton', ({ canGoBack }) => {
    if (disposed) return;
    handleNativeAndroidBack({
      canGoBack,
      location: router.state.location,
      historyBack: () => router.history.back(),
      minimizeApp: () => App.minimizeApp().catch(() => {}),
    });
  });

  return async () => {
    if (disposed) return;
    disposed = true;
    await listener.then((handle) => handle.remove()).catch(() => {});
  };
}
