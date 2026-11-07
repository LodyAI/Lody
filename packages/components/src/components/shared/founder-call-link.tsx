import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { openExternalUrl } from '@/lib/native-browser';
import { withClassName } from '@/lib/stylex';
import { sharedSurface } from './surface';

/** `utm_source=app` marks bookings that came from inside the product. */
const FOUNDER_CALL_URL = 'https://calendar.notion.so/meet/remch183/hqic3xqu?utm_source=app';

/**
 * Subtle text link to book a call with the founder, shown on the billing
 * upgrade card next to `PricingPageLink`. Opens in the system browser on
 * Electron / a new tab on web (`openExternalUrl` handles both).
 */
export function FounderCallLink({ className }: { className?: string }) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(FOUNDER_CALL_URL)}
      {...withClassName(stylex.props(sharedSurface.externalLink), className)}
    >
      {t('billing.bookFounderCall')}
      <ExternalLink
        className={stylex.props(sharedSurface.externalLinkGlyph).className}
        aria-hidden="true"
      />
    </button>
  );
}
