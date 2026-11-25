import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PostHogContext, usePostHog } from '@/lib/posthog-context';
import { useAtomValue } from 'jotai';
import { userAtom } from '@/atoms';
import {
  deferredPostHog,
  scheduleDeferredPostHogInitialization,
  trackDeferredPostHogPageView,
} from '@/lib/deferred-posthog';
import { captureReferralLanding } from '@/lib/referral-analytics';
import { identifyPostHogUser } from '@/lib/posthog-identity';
import {
  hasPendingUsageOptOut,
  markUsageOptOutPending,
  rememberAccountUsageSharing,
  pendingAccountChoice,
  readDeviceUsageChoice,
  writeDeviceUsageSharing,
  setAccountUsageAllowed,
  subscribeUsageSharing,
  syncSdkUsageSharing,
} from '@/lib/usage-sharing';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { getIpcServices } from '@/lib/electron-ipc-client';
import {
  useCloudMutation,
  usePlatform,
  usePlatformSession,
  usePlatformCapability,
} from '@lody/platform/react';

import { POSTHOG_OPTIONS, POSTHOG_HOST } from './posthog-options';
export { POSTHOG_OPTIONS } from './posthog-options';

function getPostHogClient(enabled: boolean) {
  if (typeof window === 'undefined') {
    return deferredPostHog;
  }

  if (!enabled) {
    return deferredPostHog;
  }

  const postHogKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
  if (!postHogKey || !POSTHOG_HOST) {
    return deferredPostHog;
  }
  scheduleDeferredPostHogInitialization(postHogKey, POSTHOG_OPTIONS);

  return deferredPostHog;
}

export function LodyPostHogProvider({ children }: { children: ReactNode }) {
  const supported = usePlatformCapability('telemetry');
  const session = usePlatformSession();
  const choice = useSyncExternalStore(subscribeUsageSharing, readDeviceUsageChoice, () => null);
  const device = choice ?? (typeof window !== 'undefined' && !window.__LODY_ELECTRON__);
  const preference = usePlatform().cloudApi?.useOptionalAuthenticatedQuery?.(
    cloudOperations.analytics.getUsageSharing,
    session.status === 'authenticated' ? { accountId: session.user.id } : 'skip'
  );
  const account = preference?.data;
  const allowed =
    session.status === 'authenticated'
      ? account === true
      : session.status === 'unauthenticated' && !session.uncertain;
  if (typeof account === 'boolean') rememberAccountUsageSharing(account);
  const [desktopReady, setDesktopReady] = useState(
    () => typeof window !== 'undefined' && !window.__LODY_ELECTRON__
  );
  useEffect(() => {
    if (!supported || !window.__LODY_ELECTRON__) return;
    let live = true;
    const initialChoice = readDeviceUsageChoice();
    const native = getIpcServices();
    if (native)
      void native.app
        .getUsageSharingEnabled()
        .then((enabled) => {
          if (!live) return;
          if (
            readDeviceUsageChoice() === initialChoice &&
            (enabled === false || (enabled === true && initialChoice === null))
          ) {
            writeDeviceUsageSharing(enabled);
          }
          setDesktopReady(true);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [supported]);
  const enabled = supported && allowed && device && desktopReady;
  setAccountUsageAllowed(supported && allowed && desktopReady);
  const savePreference = useCloudMutation(cloudOperations.analytics.setUsageSharing);
  const accountId = session.status === 'authenticated' ? session.user.id : null;
  useEffect(() => {
    if (!accountId) return;
    if (window.__LODY_ELECTRON__ && hasPendingUsageOptOut('next-login')) {
      markUsageOptOutPending(accountId, true);
      markUsageOptOutPending('next-login', false);
    }
    if (typeof account !== 'boolean') return;
    let desired: boolean | null;
    try {
      desired = pendingAccountChoice(accountId);
    } catch {
      return;
    }
    if (desired === null) return;
    if (account === desired) {
      markUsageOptOutPending(accountId, false);
      return;
    }
    void savePreference({ enabled: desired, accountId }).catch(() => {});
  }, [account, accountId, savePreference, choice]);
  useEffect(() => {
    if (!enabled) {
      scheduleDeferredPostHogInitialization(null, POSTHOG_OPTIONS);
      if (deferredPostHog.__loaded) {
        syncSdkUsageSharing(deferredPostHog, false);
        deferredPostHog._requestQueue?.unload();
        deferredPostHog._retryQueue?.unload();
      }
    } else if (deferredPostHog.__loaded) {
      syncSdkUsageSharing(deferredPostHog, true);
    }
  }, [enabled]);
  useEffect(() => {
    if (
      supported &&
      desktopReady &&
      typeof account === 'boolean' &&
      window.__LODY_ELECTRON__ &&
      readDeviceUsageChoice() !== null
    ) {
      void getIpcServices()
        ?.app.setUsageSharingEnabled(account && device)
        .catch(() => {});
    }
  }, [supported, desktopReady, account, device]);
  const client = getPostHogClient(enabled);
  return (
    <PostHogContext.Provider value={enabled ? { client } : null}>
      {enabled && <PostHogIdentitySync />}
      {enabled && <PostHogInitialPageView />}
      {enabled && import.meta.env.VITE_PUBLIC_POSTHOG_KEY && POSTHOG_HOST && (
        <ReferralLandingAnalytics />
      )}
      {children}
    </PostHogContext.Provider>
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
