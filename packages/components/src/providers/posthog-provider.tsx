import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PostHogContext, usePostHog } from '@/lib/posthog-context';
import { useAtomValue } from 'jotai';
import { userAtom } from '@/atoms';
import { deferredPostHog, scheduleDeferredPostHogInitialization } from '@/lib/deferred-posthog';
import { identifyPostHogUser } from '@/lib/posthog-identity';
import {
  clearPostHogLocalStorage,
  hasPendingUsageOptOut,
  hasSubmittedAccountOptOut,
  isAccountUsageSaveInFlight,
  markAccountOptOutSubmitted,
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
  if (typeof window === 'undefined' || !enabled) {
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
  const accountId = session.status === 'authenticated' ? session.user.id : null;
  const preference = usePlatform().cloudApi?.useOptionalAuthenticatedQuery?.(
    cloudOperations.analytics.getUsageSharing,
    accountId ? {} : 'skip'
  );
  const account = preference?.data;
  if (typeof account === 'boolean') rememberAccountUsageSharing(account);
  const [desktopReady, setDesktopReady] = useState(
    () => typeof window !== 'undefined' && !window.__LODY_ELECTRON__
  );
  const [envDisabled, setEnvDisabled] = useState(false);
  useEffect(() => {
    if (!supported || !window.__LODY_ELECTRON__) return;
    let live = true;
    const initialChoice = readDeviceUsageChoice();
    const native = getIpcServices();
    if (!native) {
      setDesktopReady(true);
      return;
    }
    void Promise.all([
      native.app.getUsageSharingEnabled(),
      native.app.isUsageSharingDisabledByEnv().catch(() => false),
    ])
      .then(([enabled, disabledByEnv]) => {
        if (!live) return;
        if (disabledByEnv) {
          setEnvDisabled(true);
        }
        if (readDeviceUsageChoice() === initialChoice && (enabled === false || disabledByEnv)) {
          writeDeviceUsageSharing(false);
        }
        setDesktopReady(true);
      })
      .catch(() => {
        if (live) setDesktopReady(true);
      });
    return () => {
      live = false;
    };
  }, [supported]);

  let pendingChoice: boolean | null = null;
  if (accountId) {
    try {
      pendingChoice = pendingAccountChoice(accountId);
    } catch {
      pendingChoice = null;
    }
  }

  const accountLoaded = !accountId || preference === undefined || typeof account === 'boolean';
  const allowed = accountLoaded && account !== false && pendingChoice !== false;
  const enabled = supported && allowed && choice !== false && desktopReady && !envDisabled;
  setAccountUsageAllowed(supported && allowed && desktopReady && !envDisabled);

  const savePreference = useCloudMutation(cloudOperations.analytics.setUsageSharing);
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
      markAccountOptOutSubmitted(accountId, false);
      return;
    }
    if (isAccountUsageSaveInFlight(accountId) || hasSubmittedAccountOptOut(accountId)) {
      return;
    }
    void savePreference({ enabled: desired }).catch(() => {});
  }, [account, accountId, savePreference, choice]);

  // Keep local client state and Electron main/CLI file synced with the unified account switch.
  useEffect(() => {
    if (!supported || !desktopReady || envDisabled || !accountId || typeof account !== 'boolean')
      return;
    let desired: boolean | null = null;
    try {
      desired = pendingAccountChoice(accountId);
    } catch {
      desired = null;
    }
    if (desired !== null) return;

    if (account === false) {
      if (readDeviceUsageChoice() !== false) {
        try {
          writeDeviceUsageSharing(false);
        } catch {
          // Local storage unavailable; fail-closed in-memory flag already blocks capture.
        }
      }
      if (window.__LODY_ELECTRON__) {
        void getIpcServices()
          ?.app.setUsageSharingEnabled(false)
          .catch(() => {});
      }
      return;
    }

    if (readDeviceUsageChoice() === false) {
      try {
        writeDeviceUsageSharing(true);
      } catch {
        // Ignore storage write failure.
      }
    }
    if (window.__LODY_ELECTRON__) {
      void getIpcServices()
        ?.app.setUsageSharingEnabled(true)
        .catch(() => {});
    }
  }, [supported, desktopReady, envDisabled, account, accountId, choice]);

  useEffect(() => {
    if (!enabled) {
      scheduleDeferredPostHogInitialization(null, POSTHOG_OPTIONS);
      if (deferredPostHog.__loaded) {
        syncSdkUsageSharing(deferredPostHog, false);
        deferredPostHog._requestQueue?.unload();
        deferredPostHog._retryQueue?.unload();
      }
      if (choice === false || account === false) {
        clearPostHogLocalStorage();
      }
    } else if (deferredPostHog.__loaded) {
      syncSdkUsageSharing(deferredPostHog, true);
    }
  }, [enabled, choice, account]);

  const client = getPostHogClient(enabled);
  return (
    <PostHogContext.Provider value={enabled ? { client } : null}>
      {enabled && <PostHogIdentitySync />}
      {children}
    </PostHogContext.Provider>
  );
}

function PostHogIdentitySync() {
  const postHog = usePostHog();
  const user = useAtomValue(userAtom);

  useEffect(() => {
    identifyPostHogUser(postHog, user);
  }, [postHog, user]);

  return null;
}
