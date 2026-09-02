import { useTranslation } from 'react-i18next';

import { Button } from '@lody/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import lodyLogo from '@/assets/lody-icon.png';

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
  const title =
    checkoutResult === 'success'
      ? t('desktopCheckoutReturn.successTitle', 'Payment received')
      : t('desktopCheckoutReturn.title', 'Continue in Lody Desktop');
  const subtitle =
    checkoutResult === 'success'
      ? t(
          'desktopCheckoutReturn.successDescription',
          'Your subscription is being activated. Head back to Lody Desktop to continue.'
        )
      : t('desktopCheckoutReturn.description', 'You can now return to Lody Desktop.');

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md rounded-2xl border-border/60">
        <CardHeader className="items-center gap-6 px-8 pt-10 pb-4 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
            <img src={lodyLogo} alt="Lody" className="h-11 w-11 object-contain" draggable={false} />
          </span>
          <div className="flex flex-col items-center gap-2">
            <CardTitle className="text-xl font-semibold tracking-tight">{title}</CardTitle>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </CardHeader>
        <CardContent className="px-8 pb-9">
          <Button
            render={deepLink ? <a href={deepLink} /> : undefined}
            size="large"
            className="w-full"
            disabled={!deepLink}
          >
            {openLabel}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
