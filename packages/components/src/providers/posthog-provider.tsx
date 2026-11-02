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
