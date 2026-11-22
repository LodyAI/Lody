import { useEffect } from 'react';
import { usePostHog } from '@/lib/posthog-context';
import {
  capturePostHogEvent,
  detectAppDeviceClass,
  detectAppLaunchMode,
  getAppLaunchPerformanceProperties,
} from '@/lib/posthog-analytics';

const LOGIN_HINT_COOKIE_NAME = 'lody_logged_in';
const INSTALL_ID_STORAGE_KEY = 'lody_install_id';

// `window.__LODY_APP_INFO__` is declared (in window-globals.d.ts) with only
// version/build today; the native shells are expected to widen it with
// platform/os fields (see cross-file note). Read through a structural type so
// this tracker keeps compiling/filling whichever fields the shell has populated
// without depending on the global declaration being widened first.
type NativeAppInfo = {
  version?: string;
  build?: string;
  native_platform?: string;
  os_name?: string;
  os_version?: string;
  app_version?: string;
  install_id?: string;
};

function readNativeAppInfo(): NativeAppInfo {
  if (typeof window === 'undefined') return {};
  const info = (window as { __LODY_APP_INFO__?: NativeAppInfo }).__LODY_APP_INFO__;
  return info ?? {};
}

// install_id is a stable, non-PII per-install surrogate (random, not derived
// from any user/device identifier). Persist it in localStorage so it survives
// reloads; if storage is unavailable we simply omit it rather than throw.
function resolveInstallId(): string | null {
  if (typeof window === 'undefined') return null;
  const fromShell = readNativeAppInfo().install_id;
  if (typeof fromShell === 'string' && fromShell.length > 0) {
    return fromShell;
  }
  try {
    const existing = window.localStorage.getItem(INSTALL_ID_STORAGE_KEY);
    if (existing) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(INSTALL_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    // Private mode / storage disabled: omit install_id rather than fail launch.
    return null;
  }
}

// Build-time linked Lody client version, injected by the web/electron-renderer
// vite configs (undefined in the mobile build — Capacitor supplies the native
// version through `__LODY_APP_INFO__` instead). Guarded with `typeof` so it is
// safe to reference even where the define was never applied.
function readBuildAppVersion(): string | null {
  if (typeof __APP_VERSION__ === 'undefined') return null;
  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0 ? __APP_VERSION__ : null;
}

function readElectronVersion(): string | null {
  if (typeof window === 'undefined') return null;
  const platform = window.__LODY_PLATFORM__;
  const version = (platform as { electronVersion?: string } | undefined)?.electronVersion;
  return typeof version === 'string' && version.length > 0 ? version : null;
}

export function AppLaunchAnalyticsTracker({ isElectron }: { isElectron: boolean }) {
  const postHog = usePostHog();

  useEffect(() => {
    const launchMode = detectAppLaunchMode(isElectron);
    const deviceClass = detectAppDeviceClass();
    const isReturningUser =
      typeof document !== 'undefined' &&
      document.cookie
        .split(';')
        .some((cookie) => cookie.trim().startsWith(`${LOGIN_HINT_COOKIE_NAME}=`));

    const appInfo = readNativeAppInfo();
    const nativePlatform = appInfo.native_platform ?? null;
    const platform = isElectron ? 'electron' : nativePlatform ? 'mobile' : 'web';
    const installId = resolveInstallId();
    // Prefer a version the native shell reported for this exact install
    // (Capacitor on mobile); fall back to the build-time linked version for
    // web/electron renderer. Mirrors how `platform` is resolved per surface.
    const appVersion = appInfo.app_version ?? appInfo.version ?? readBuildAppVersion();

    // Register the durable platform identity as super-properties so every
    // subsequent event in the session carries it (spec §2.2/§2.4) without each
    // call site re-passing it. register() is best-effort and a no-op when the
    // client is unavailable.
    const superProperties: Record<string, unknown> = {
      platform,
      launch_mode: launchMode,
      native_platform: nativePlatform,
    };
    if (installId) {
      superProperties.install_id = installId;
    }
    // Carry the running app version on every event (not just app/launch) so it
    // can be sliced alongside `platform` in product analytics.
    if (appVersion) {
      superProperties.app_version = appVersion;
    }
    try {
      (postHog as { register?: (props: Record<string, unknown>) => void } | null)?.register?.(
        superProperties
      );
    } catch {
      // Analytics is side-effect-only: never let registration throw into boot.
    }

    capturePostHogEvent(postHog, 'app/launch', {
      launch_mode: launchMode,
      platform,
      is_returning_user: isReturningUser,
      device_class: deviceClass,
      native_platform: nativePlatform,
      os_name: appInfo.os_name ?? null,
      os_version: appInfo.os_version ?? null,
      app_version: appVersion,
      app_build: appInfo.build ?? null,
      electron_version: readElectronVersion(),
      install_id: installId,
      ...getAppLaunchPerformanceProperties(),
    });
  }, [isElectron, postHog]);

  return null;
}
