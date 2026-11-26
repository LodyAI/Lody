import { useEffect } from 'react';
import { usePostHog } from '@/lib/posthog-context';
import { capturePostHogEvent } from '@/lib/posthog-analytics';

export function AppLaunchAnalyticsTracker(_props: { isElectron?: boolean }) {
  const client = usePostHog();
  useEffect(() => {
    capturePostHogEvent(client, 'app/launch');
  }, [client]);
  return null;
}
