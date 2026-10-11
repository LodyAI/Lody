import { useEffect, type ReactNode } from 'react';
import posthog from 'posthog-js';
import { PostHogProvider, usePostHog } from '@posthog/react';
import { useAtomValue } from 'jotai';
import { isConvexAuthErrorData } from '@lody/shared';
import { userAtom } from '@/atoms';
import {
  deferredPostHog,
  scheduleDeferredPostHogInitialization,
  trackDeferredPostHogPageView,
} from '@/lib/deferred-posthog';
import { isElectronRenderer } from '@/lib/electron';
import { readNativeAppInfo } from '@/lib/native-app-info';
import { isNativeAppShell } from '@/lib/native-platform';
import { POSTHOG_INIT_PROPERTY_DENYLIST } from '@/lib/posthog-analytics';
import { identifyPostHogUser } from '@/lib/posthog-identity';
import { isResizeObserverLoopError } from '@/lib/resize-observer';
import { usePlatformCapability } from '@lody/platform/react';

type PostHogOptions = NonNullable<Parameters<typeof posthog.init>[1]>;

const POSTHOG_HOST = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;
const POSTHOG_DESKTOP_LIBRARY = 'desktop';
const POSTHOG_IOS_LIBRARY = 'iOS';
const POSTHOG_ANDROID_LIBRARY = 'Android';

function maskPostHogRecordingText(text: string): string {
  return text.replace(/\S/g, '*');
}

function readPostHogLibraryVersion(): string | null {
  const appInfo = typeof window === 'undefined' ? undefined : window.__LODY_APP_INFO__;
  const shellVersion = appInfo?.app_version ?? appInfo?.version;
  if (shellVersion) {
    return shellVersion;
  }

  if (typeof __APP_VERSION__ === 'undefined') {
    return null;
  }

  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0 ? __APP_VERSION__ : null;
}

function normalizeMobilePostHogLibrary(platform: string | null | undefined): string | null {
  const normalized = platform?.toLowerCase();
  if (normalized === 'ios') {
    return POSTHOG_IOS_LIBRARY;
  }
  if (normalized === 'android') {
    return POSTHOG_ANDROID_LIBRARY;
  }
  return null;
}

function readCapacitorPlatform(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const platform = (
      window as unknown as { Capacitor?: { getPlatform?: () => string } }
    ).Capacitor?.getPlatform?.();
    return typeof platform === 'string' ? platform : null;
  } catch {
    return null;
  }
}

function readMobilePostHogLibrary(): { library: string; nativePlatform: string } | null {
  if (!isNativeAppShell()) {
    return null;
  }

  const nativePlatform = readNativeAppInfo().native_platform ?? readCapacitorPlatform();
  const library = normalizeMobilePostHogLibrary(nativePlatform);
  if (!library || !nativePlatform) {
    return null;
  }

  return {
    library,
    nativePlatform: nativePlatform.toLowerCase(),
  };
}

function isUnauthenticatedExceptionMessage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // PostHog serializes errors before before_send, losing ConvexError.data and
  // its identifying symbol. Match the namespaced JSON contract, including the
  // nested ConvexError prefix produced by action -> query failures.
  const payload = value.match(/\bConvexError:\s*(\{[^{}\r\n]*\})/)?.[1] ?? value;
  try {
    return isConvexAuthErrorData(JSON.parse(payload));
  } catch {
    return false;
  }
}

function isUnauthenticatedPostHogEvent(event: {
  event: string;
  properties?: Record<string, unknown>;
}): boolean {
  if (event.event !== '$exception') return false;
  const properties = event.properties;
  if (!properties) return false;
  const exceptions = properties.$exception_list;
  if (Array.isArray(exceptions) && exceptions.length > 0) {
    // Preserve mixed exception chains: an auth failure must not hide another bug.
    return exceptions.every((item) => {
      if (!item || typeof item !== 'object') return false;
      const exception = item as Record<string, unknown>;
      return isUnauthenticatedExceptionMessage(exception.value ?? exception.message);
    });
  }
  return isUnauthenticatedExceptionMessage(
    properties.$exception_message ?? properties.$exception_description
  );
}

function isResizeObserverLoopPostHogEvent(event: {
  properties?: Record<string, unknown>;
}): boolean {
  const properties = event.properties;
  if (!properties) return false;

  const candidates = [
    properties.$exception_message,
    properties.$exception_type,
    properties.$exception_description,
  ];
  if (candidates.some((candidate) => isResizeObserverLoopError(candidate))) {
    return true;
  }

  const exceptionList = properties.$exception_list;
  if (!Array.isArray(exceptionList)) return false;

  return exceptionList.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const exception = item as Record<string, unknown>;
    return (
      isResizeObserverLoopError(exception.value) ||
      isResizeObserverLoopError(exception.type) ||
      isResizeObserverLoopError(exception.message)
    );
  });
}

export const POSTHOG_OPTIONS: PostHogOptions = {
  ...(POSTHOG_HOST ? { api_host: POSTHOG_HOST } : {}),
  defaults: '2026-01-30',
  autocapture: false,
  // The deferred controller records pageviews and pageleave itself so routes
  // visited before `posthog.init` retain their original timestamps, and a short
  // visit can flush the current pagehide through sendBeacon.
  capture_pageview: false,
  capture_pageleave: false,
  // Error tracking: auto-capture unhandled errors + promise rejections
  // (replaces Sentry's globalHandlers/browserApiErrors). React render errors
  // are reported explicitly from ErrorBoundary via posthog.captureException.
  capture_exceptions: true,
  capture_performance: false,
  property_denylist: POSTHOG_INIT_PROPERTY_DENYLIST,
  debug: false,
  // Session Replay is useful for product debugging, but this UI can contain
  // private code/chat/repo data. Mask raw content before rrweb emits events.
  disable_session_recording: false,
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: '*',
    maskTextFn: maskPostHogRecordingText,
  },
  mask_all_element_attributes: true,
  mask_all_text: true,
  disable_surveys: true,
  enable_recording_console_log: false,
  // Recorder is loaded as a PostHog external dependency; surveys remain disabled.
  disable_external_dependency_loading: false,
  // Do NOT set `advanced_disable_flags: true`. The server-side `sessionRecording`
  // config (the project's "Record user sessions" toggle + sampling) is delivered
  // only through the `/flags` response. Disabling flags makes posthog-js skip that
  // request, so the recorder never receives its enable signal and Session Replay
  // silently stops capturing — even with `disable_session_recording: false`.
  before_send: (event) => {
    if (!event) {
      return event;
    }
    if (isUnauthenticatedPostHogEvent(event) || isResizeObserverLoopPostHogEvent(event)) {
      return null;
    }

    const libraryVersion = readPostHogLibraryVersion();
    const mobileLibrary = readMobilePostHogLibrary();
    if (mobileLibrary) {
      event.properties = {
        ...event.properties,
        platform: 'mobile',
        native_platform: mobileLibrary.nativePlatform,
        mobile_process: 'webview',
        $lib: mobileLibrary.library,
        ...(libraryVersion ? { $lib_version: libraryVersion } : {}),
      };
      return event;
    }

    if (isElectronRenderer()) {
      event.properties = {
        ...event.properties,
        platform: 'electron',
        electron_process: 'renderer',
        $lib: POSTHOG_DESKTOP_LIBRARY,
        ...(libraryVersion ? { $lib_version: libraryVersion } : {}),
      };
    }

    return event;
  },
};

function getPostHogClient(enabled: boolean) {
  if (typeof window === 'undefined') {
    return deferredPostHog;
  }

  if (!enabled) {
    return posthog;
  }

  const postHogKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
  if (!postHogKey || !POSTHOG_HOST) {
    return posthog;
  }
  scheduleDeferredPostHogInitialization(postHogKey, POSTHOG_OPTIONS);

  return deferredPostHog;
}

export function LodyPostHogProvider({ children }: { children: ReactNode }) {
  const enabled = usePlatformCapability('telemetry');
  const client = getPostHogClient(enabled);
  return (
    <PostHogProvider client={client}>
      {enabled && <PostHogIdentitySync />}
      {enabled && <PostHogInitialPageView />}
      {children}
    </PostHogProvider>
  );
}

function PostHogInitialPageView() {
  useEffect(() => {
    if (typeof window !== 'undefined') {
      trackDeferredPostHogPageView(window.location.href);
    }
  }, []);

  return null;
}

function PostHogIdentitySync() {
  const postHog = usePostHog();
  const user = useAtomValue(userAtom);

  useEffect(() => {
    identifyPostHogUser(postHog, user);
  }, [postHog, user]);

  return null;
}
