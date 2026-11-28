import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PostHogContext, usePostHog } from '@/lib/posthog-context';
import { useAtomValue } from 'jotai';
import { userAtom } from '@/atoms';
import { deferredPostHog, scheduleDeferredPostHogInitialization } from '@/lib/deferred-posthog';
import { identifyPostHogUser } from '@/lib/posthog-identity';
import {
  claimAccountUsageSave,
  clearPostHogLocalStorage,
  clearSubmittedAccountChoice,
  hasInFlightAccountUsageSave,
  hasSubmittedAccountChoice,
  isEnvUsageSharingDisabledClient,
  pendingAccountChoice,
  readDeviceUsageChoice,
  rememberAccountUsageSharing,
  setAccountUsageAllowed,
  setEnvUsageSharingDisabled,
  setPendingAccountChoice,
  subscribeUsageSharing,
  syncSdkUsageSharing,
  writeDeviceUsageSharing,
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
  const envDisabled = useSyncExternalStore(
    subscribeUsageSharing,
    isEnvUsageSharingDisabledClient,
    () => false
  );
  const pendingChoice = useSyncExternalStore(
    subscribeUsageSharing,
    () => (accountId ? pendingAccountChoice(accountId) : null),
    () => null
  );
  useEffect(() => {
    if (!supported || !window.__LODY_ELECTRON__) {
      setEnvUsageSharingDisabled(false);
      return;
    }
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
        setEnvUsageSharingDisabled(disabledByEnv);
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
      setEnvUsageSharingDisabled(false);
    };
  }, [supported]);

  const accountLoaded = !accountId || preference === undefined || typeof account === 'boolean';
  const allowed =
    pendingChoice === true || (accountLoaded && account !== false && pendingChoice !== false);
  const enabled = supported && allowed && choice !== false && desktopReady && !envDisabled;
  setAccountUsageAllowed(supported && allowed && desktopReady && !envDisabled);

  const savePreference = useCloudMutation(cloudOperations.analytics.setUsageSharing);
  useEffect(() => {
    if (!accountId) return;
    if (window.__LODY_ELECTRON__) {
      const nextLoginChoice = pendingAccountChoice('next-login');
      if (nextLoginChoice !== null) {
        if (pendingAccountChoice(accountId) === null) {
          setPendingAccountChoice(accountId, nextLoginChoice);
        }
        setPendingAccountChoice('next-login', null);
      }
    }
    if (typeof account !== 'boolean') return;
    const desired = pendingAccountChoice(accountId);
    if (desired === null) return;
    if (account === desired) {
      if (!hasInFlightAccountUsageSave(accountId)) {
        clearSubmittedAccountChoice(accountId);
        setPendingAccountChoice(accountId, null);
      }
      return;
    }
    if (hasSubmittedAccountChoice(accountId, desired)) return;
    const finish = claimAccountUsageSave(accountId, desired);
    if (!finish) return;
    void savePreference({ enabled: desired }).then(
      () => finish(true),
      () => finish(false)
    );
  }, [account, accountId, savePreference, choice, pendingChoice]);

  // Keep local client state and Electron main/CLI file synced with the unified account switch.
  useEffect(() => {
    if (!supported || !desktopReady || envDisabled || !accountId || typeof account !== 'boolean')
      return;
    if (pendingAccountChoice(accountId) !== null || hasInFlightAccountUsageSave(accountId)) return;

    if (account === false) {
      if (readDeviceUsageChoice() !== false) {
        writeDeviceUsageSharing(false);
      }
      if (window.__LODY_ELECTRON__) {
        void getIpcServices()
          ?.app.setUsageSharingEnabled(false)
          .catch(() => {});
      }
      return;
    }

    if (readDeviceUsageChoice() === false) {
      writeDeviceUsageSharing(true);
    }
    if (window.__LODY_ELECTRON__) {
      void getIpcServices()
        ?.app.setUsageSharingEnabled(true)
        .catch(() => {});
    }
  }, [supported, desktopReady, envDisabled, account, accountId, choice, pendingChoice]);

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
