import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PostHogContext, usePostHog } from '@/lib/posthog-context';
import { useAtomValue } from 'jotai';
import { userAtom } from '@/atoms';
import { deferredPostHog, scheduleDeferredPostHogInitialization } from '@/lib/deferred-posthog';
import { identifyPostHogUser } from '@/lib/posthog-identity';
import {
  clearPostHogLocalStorage,
  hasAccountUsagePromptDecision,
  hasPendingUsageOptOut,
  markAccountUsagePromptDecided,
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
  const promptDecided = useSyncExternalStore(
    subscribeUsageSharing,
    () => (accountId ? hasAccountUsagePromptDecision(accountId) : false),
    () => false
  );
  const preference = usePlatform().cloudApi?.useOptionalAuthenticatedQuery?.(
    cloudOperations.analytics.getUsageSharing,
    accountId ? { accountId } : 'skip'
  );
  const account = preference?.data;
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

  let pendingChoice: boolean | null = null;
  if (accountId) {
    try {
      pendingChoice = pendingAccountChoice(accountId);
    } catch {
      pendingChoice = null;
    }
  }

  const hasExplicitDecision = promptDecided || choice !== null;
  // Unified user-level opt-in: stay disabled before sign-in and before explicit consent.
  const allowed =
    session.status === 'authenticated' &&
    account === true &&
    hasExplicitDecision &&
    pendingChoice !== false;
  const enabled = supported && allowed && choice === true && desktopReady;
  setAccountUsageAllowed(supported && allowed && desktopReady);

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
      return;
    }
    void savePreference({ enabled: desired, accountId }).catch(() => {});
  }, [account, accountId, savePreference, choice, promptDecided]);

  // Keep local client state and Electron main/CLI file synced with the unified account switch.
  useEffect(() => {
    if (!supported || !desktopReady || !accountId || typeof account !== 'boolean') return;
    let desired: boolean | null = null;
    try {
      desired = pendingAccountChoice(accountId);
    } catch {
      desired = null;
    }
    if (desired !== null) return;

    if (account === false) {
      if (!hasAccountUsagePromptDecision(accountId)) {
        markAccountUsagePromptDecided(accountId);
      }
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

    // account === true: mirror to local/desktop only after the user has explicitly decided.
    if (hasAccountUsagePromptDecision(accountId) || readDeviceUsageChoice() !== null) {
      if (readDeviceUsageChoice() !== true) {
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
    }
  }, [supported, desktopReady, account, accountId, choice, promptDecided]);

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
