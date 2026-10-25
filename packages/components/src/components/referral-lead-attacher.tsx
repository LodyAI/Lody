import { useEffect, useRef } from 'react';
import { useCloudMutation } from '@lody/platform/react';
import { useAppCapability } from '@/lib/app-platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { readReferralHint } from '@/lib/referral-attribution';

/**
 * Hands this browser's referral link to the authenticated account. The server owns
 * click ordering; the success cache lasts only for this mounted component,
 * so a new launch can retry failed or expired attribution without stale storage.
 */
export function ReferralLeadAttacher({ userId }: { userId: string | null }) {
  const billingAvailable = useAppCapability('billing');
  const attachLead = useCloudMutation(cloudOperations.referrals.attachLead);
  const attached = useRef<{ userId: string; code: string; clickedAt: number } | null>(null);
  useEffect(() => {
    if (!billingAvailable || !userId) return undefined;
    let cancelled = false;
    const attachCurrent = () => {
      const hint = readReferralHint();
      if (
        !hint ||
        (attached.current?.userId === userId &&
          attached.current.code === hint.code &&
          attached.current.clickedAt === hint.clickedAt)
      )
        return;
      attachLead(hint).then(
        ({ status }) => {
          const current = readReferralHint();
          if (
            !cancelled &&
            current?.code === hint.code &&
            current.clickedAt === hint.clickedAt &&
            (status === 'attached' || status === 'kept')
          ) {
            attached.current = { userId, ...hint };
          }
        },
        () => {
          /* Retried on foreground/next launch and awaited again before checkout. */
        }
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'lody:referral' || event.key === null) attachCurrent();
    };
    attachCurrent();
    window.addEventListener('storage', onStorage);
    window.addEventListener('lody:referral-changed', attachCurrent);
    window.addEventListener('focus', attachCurrent);
    return () => {
      cancelled = true;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('lody:referral-changed', attachCurrent);
      window.removeEventListener('focus', attachCurrent);
    };
  }, [attachLead, billingAvailable, userId]);
  return null;
}
