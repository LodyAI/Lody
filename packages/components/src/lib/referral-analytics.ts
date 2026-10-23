import { hashAnalyticsId } from '@lody/shared';
import { readReferral } from './referral-attribution';
import { capturePostHogEvent, type PostHogAnalyticsClient } from './posthog-analytics';

/** Only called behind the platform telemetry capability. Analytics cannot break billing. */
export function captureReferralEvent(
  client: PostHogAnalyticsClient | null | undefined,
  event: 'viewed' | 'link_copied' | 'link_shared' | 'details_viewed',
  properties: {
    workspace_id: string;
    referral_code_hash?: string;
    can_manage?: boolean;
    campaign_id?: string;
    discount_percent?: number;
    reward_percent?: number;
  }
) {
  try {
    capturePostHogEvent(client, `referral/${event}`, properties);
  } catch {
    // Clipboard and navigation must still work with an unavailable analytics SDK.
  }
}

/** First stored referral observed by the app, including a static landing-page redirect.
 * This does not count visits that leave before the app/analytics loads.
 */
export function captureReferralLanding(
  client: PostHogAnalyticsClient | null | undefined,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  now = Date.now()
) {
  if (!client) return;
  try {
    storage ??= localStorage;
    const code = readReferral(storage, now);
    if (!code) return;
    const record = JSON.parse(storage.getItem('lody:referral')!);
    if (record.analyticsCapturedAt !== undefined) return;
    capturePostHogEvent(client, 'referral/landed', {
      referral_code_hash: hashAnalyticsId(code),
      source: 'stored_attribution',
    });
    storage.setItem('lody:referral', JSON.stringify({ ...record, analyticsCapturedAt: now }));
  } catch {
    // Storage and telemetry are optional; never lose the attribution hint.
  }
}
