import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { openExternalUrl } from '@/lib/native-browser';
import { cn } from '@/lib/utils';

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
      className={cn(
        'inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline',
        className
      )}
    >
      {t('billing.bookFounderCall')}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
