import { useTranslation } from 'react-i18next';
import { CreditCard } from 'lucide-react';

import { Button } from '@lody/ui/button';
import { SecondaryPage } from '@/components/pages/secondary-page';

export interface DesktopCheckoutReturnPageProps {
  deepLink: string | null;
  /** 'success' shows the payment-received copy; anything else is a neutral return. */
  checkoutResult: 'success' | 'canceled' | null;
}

/**
 * Browser-side landing page after a desktop-initiated Stripe checkout or
 * billing portal visit. Hands control back to the desktop app via the
 * `lody://checkout-return` deep link (mirrors DesktopGithubInstallPage).
 */
export function DesktopCheckoutReturnPage({
  deepLink,
  checkoutResult,
}: DesktopCheckoutReturnPageProps) {
  const { t } = useTranslation();
  const openLabel = t('desktopCheckoutReturn.openButton', 'Open Lody Desktop');
  const settled = checkoutResult === 'success';
  const title = settled
    ? t('desktopCheckoutReturn.successTitle', 'Payment received')
    : t('desktopCheckoutReturn.title', 'Continue in Lody Desktop');
  const subtitle = settled
    ? t(
        'desktopCheckoutReturn.successDescription',
        'Your subscription is being activated. Head back to Lody Desktop to continue.'
      )
    : t('desktopCheckoutReturn.description', 'You can now return to Lody Desktop.');

  return (
    <SecondaryPage
      state={settled ? 'done' : 'ask'}
      from={<CreditCard size={22} strokeWidth={1.6} aria-hidden="true" />}
      markLabel={t('desktopCheckoutReturn.markLabel', 'Stripe and Lody')}
      title={title}
      description={subtitle}
      actions={
        <Button
          render={deepLink ? <a href={deepLink} /> : undefined}
          size="large"
          disabled={!deepLink}
        >
          {openLabel}
        </Button>
      }
    />
  );
}
