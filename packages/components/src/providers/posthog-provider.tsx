import { createIrohDaily, installIrohDailyRecorder } from '@/lib/iroh-daily';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { isElectronRenderer } from '@/lib/electron';
import { isNativeAppShell, isIOSRuntimeEnvironment } from '@/lib/native-platform';
import { readNativeAppInfo } from '@/lib/native-app-info';
import { useEffect, type ReactNode } from 'react';
import posthog from 'posthog-js';
import { PostHogProvider, usePostHog } from '@posthog/react';
import { useAtomValue } from 'jotai';
import { userAtom } from '@/atoms';
import {
  deferredPostHog,
  scheduleDeferredPostHogInitialization,
  trackDeferredPostHogPageView,
} from '@/lib/deferred-posthog';
import { captureReferralLanding } from '@/lib/referral-analytics';
import { identifyPostHogUser } from '@/lib/posthog-identity';
import { usePlatformCapability } from '@lody/platform/react';

import { POSTHOG_OPTIONS, POSTHOG_HOST } from './posthog-options';
export { POSTHOG_OPTIONS } from './posthog-options';

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
      {enabled && <IrohDailyReporting />}
      {enabled && <PostHogIdentitySync />}
      {enabled && <PostHogInitialPageView />}
      {enabled && import.meta.env.VITE_PUBLIC_POSTHOG_KEY && POSTHOG_HOST && (
        <ReferralLandingAnalytics />
      )}
      {children}
    </PostHogProvider>
  );
}

function ReferralLandingAnalytics() {
  const postHog = usePostHog();
  useEffect(() => {
    captureReferralLanding(postHog);
  }, [postHog]);
  return null;
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

/** One shared origin store, with Web Locks fencing every read/modify/enqueue/write. */
function IrohDailyReporting() {
  useEffect(() => {
    if (
      !import.meta.env.VITE_PUBLIC_POSTHOG_KEY ||
      !POSTHOG_HOST ||
      !navigator.locks ||
      (!isElectronRenderer() && !isNativeAppShell())
    )
      return;
    let active = true;
    const daily = createIrohDaily({
      enabled: () => active,
      now: Date.now,
      storage: localStorage,
      exclusive: async (run) => await navigator.locks.request('lody:iroh-daily', run),
      digest: async (text) => {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(
          ''
        );
      },
      random: () => crypto.randomUUID(),
      online: () => navigator.onLine,
      // Use the initialized SDK, rather than its evictable deferred queue. Undefined
      // means disabled/not initialized, so retain the counters for a later check.
      enqueue: (properties, uuid) =>
        active && !!capturePostHogEvent(posthog, 'e2ee/iroh_daily', properties, { uuid }),
      platform: isElectronRenderer() ? 'desktop' : isIOSRuntimeEnvironment() ? 'ios' : 'android',
      version: () =>
        readNativeAppInfo().app_version ??
        readNativeAppInfo().version ??
        (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown'),
    });
    const remove = installIrohDailyRecorder(daily.record);
    const check = () => {
      void daily.check().catch(() => undefined);
    };
    const foreground = () => {
      if (document.visibilityState === 'visible') check();
    };
    window.addEventListener('online', check);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', foreground);
    const timer = setInterval(check, 60 * 60 * 1000);
    check();
    return () => {
      active = false;
      remove();
      clearInterval(timer);
      window.removeEventListener('online', check);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, []);
  return null;
}
