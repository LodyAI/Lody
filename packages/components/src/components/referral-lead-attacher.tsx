import { useEffect, useRef } from 'react';
import { useCloudMutation } from '@lody/platform/react';
import { useAppCapability } from '@/lib/app-platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { readReferral } from '@/lib/referral-attribution';

/**
 * Hands this browser's referral link to the authenticated account. The server owns
 * first-link retention; the success cache lasts only for this mounted component,
 * so a new launch can retry failed or expired attribution without stale storage.
 */
export function ReferralLeadAttacher({ userId }: { userId: string | null }) {
  const billingAvailable = useAppCapability('billing');
  const attachLead = useCloudMutation(cloudOperations.referrals.attachLead);
  const attached = useRef<{ userId: string; code: string } | null>(null);
  useEffect(() => {
    if (!billingAvailable || !userId) return undefined;
    const code = readReferral();
    if (!code || (attached.current?.userId === userId && attached.current.code === code)) {
      return undefined;
    }
    let cancelled = false;
    attachLead({ code }).then(
      ({ status }) => {
        if (!cancelled && (status === 'attached' || status === 'kept')) {
          attached.current = { userId, code };
        }
      },
      () => {
        /* Retried on the next launch; checkout also uses the browser's hint. */
      }
    );
    return () => {
      cancelled = true;
    };
  }, [attachLead, billingAvailable, userId]);
  return null;
}
