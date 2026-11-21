import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { openExternalUrl } from '@/lib/native-browser';
import { withClassName } from '@/lib/stylex';
import { sharedSurface } from './surface';

/**
 * Pre-checkout consent line shown on every surface that starts a paid
 * subscription (billing upgrade card, paid-workspace creation). States that
 * subscribing agrees to the Terms and that paid plans auto-renew — the
 * disclosure regulators and card networks expect before a recurring charge.
 * The Terms link opens in the system browser on Electron / a new tab on web.
 */
export function SubscribeConsentNotice({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const termsUrl = i18n.language?.startsWith('zh')
    ? 'https://lody.ai/zh/terms'
    : 'https://lody.ai/terms';
  // Split the localized sentence around the {{terms}} slot (via a sentinel
  // that never occurs naturally) so the Terms link renders inline.
  const sentinel = String.fromCharCode(0);
  const parts = t('billing.subscribeConsentNotice', { terms: sentinel }).split(sentinel);

  return (
    <p {...withClassName(stylex.props(sharedSurface.consentNotice), className)}>
      {parts[0] ?? ''}
      <button
        type="button"
        onClick={() => void openExternalUrl(termsUrl)}
        {...stylex.props(sharedSurface.consentLink)}
      >
        {t('billing.subscribeConsentTerms')}
      </button>
      {parts[1] ?? ''}
    </p>
  );
}
