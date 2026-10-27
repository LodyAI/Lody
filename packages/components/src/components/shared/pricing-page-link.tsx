import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { openExternalUrl } from '@/lib/native-browser';
import { withClassName } from '@/lib/stylex';
import { sharedSurface } from './surface';

/**
 * Subtle text link to the public pricing page, shown on checkout surfaces
 * (billing upgrade card, paid-workspace creation). Opens in the system browser
 * on Electron / a new tab on web (`openExternalUrl` handles both).
 */
export function PricingPageLink({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const url = i18n.language?.startsWith('zh')
    ? 'https://lody.ai/zh/price'
    : 'https://lody.ai/price';

  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(url)}
      {...withClassName(stylex.props(sharedSurface.externalLink), className)}
    >
      {t('billing.viewPricingPage')}
      <ExternalLink
        className={stylex.props(sharedSurface.externalLinkGlyph).className}
        aria-hidden="true"
      />
    </button>
  );
}
