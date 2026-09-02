import { atom, useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { usePlatform } from '@lody/platform/react';
import { motion } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { useStuckConnectionHint } from '@/hooks/use-stuck-connection';
import { ClearCacheConfirmDialog, useClearCache } from './settings/clear-cache';

/**
 * Dismissal intentionally lives in a page-load-scoped atom, not storage: the
 * recovery action IS a reload, so a fresh page load should get a fresh verdict.
 */
const stuckConnectionBannerDismissedAtom = atom(false);

export type StuckConnectionBannerLabels = {
  title: string;
  description: string;
  clearCache: string;
  dismissAriaLabel: string;
};

/**
 * Floating hint shown when the workspace connection has been stuck in
 * `loading` for an extended time (see `useStuckConnectionHint`).
 *
 * Sits at the BOTTOM, above the mobile dock (`bottom-0 z-30`, ~72px tall plus
 * safe area) rather than under the header: the bottom of a list is usually
 * empty space, while the top covers the rows the user came to read, and a
 * bottom sheet is both the platform-conventional place for a recoverable
 * status and within thumb reach. The description stays — without the "broken
 * local cache" link, "Clear cache" reads as an unrelated button next to a
 * connection problem — but the specifics of what gets deleted live in the
 * confirmation dialog the action opens, not here.
 */
export function StuckConnectionBanner({
  labels,
  onClearCache,
  onDismiss,
}: {
  labels: StuckConnectionBannerLabels;
  onClearCache: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--k-safe-area-bottom,0px)+5.25rem)] z-40 flex justify-center px-4"
      role="status"
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }}
        className="pointer-events-auto w-full max-w-md rounded-2xl border border-border/70 bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur"
      >
        <div className="flex items-center gap-2">
          <Loader2
            className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{labels.title}</p>
          <Button
            variant="ghost"
            size="mini"
            icon
            className="-mr-1 shrink-0"
            onClick={onDismiss}
            aria-label={labels.dismissAriaLabel}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {/* Reason and action share one row: the action alone on its own row
            left a wide empty gutter, and the reason is what makes "clear
            cache" a sensible answer to a connection problem. */}
        <div className="mt-1 flex items-center gap-2 pl-6">
          <p className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground">
            {labels.description}
          </p>
          <Button size="small" shape="pill" className="shrink-0" onClick={onClearCache}>
            {labels.clearCache}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * Mounted once in `MainLayout`. Renders nothing on the local-only platform
 * (no cloud connection to get stuck), before the hint threshold, or after the
 * user dismissed it for this page load. The clear action reuses the settings
 * "Clear cache" flow — confirmation dialog included — so both entry points
 * share one behavior and one copy.
 */
export function StuckConnectionBannerContainer() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const stuck = useStuckConnectionHint();
  const [dismissed, setDismissed] = useAtom(stuckConnectionBannerDismissedAtom);
  const { dialogOpen, setDialogOpen, isClearing, confirmClear } = useClearCache();

  if (platform.sync.mode === 'local' || !stuck || dismissed) {
    return null;
  }

  return (
    <>
      <StuckConnectionBanner
        labels={{
          title: t('connectionRecovery.title'),
          description: t('connectionRecovery.description'),
          clearCache: t('connectionRecovery.clearCache'),
          dismissAriaLabel: t('connectionRecovery.dismiss'),
        }}
        onClearCache={() => setDialogOpen(true)}
        onDismiss={() => setDismissed(true)}
      />
      <ClearCacheConfirmDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        isClearing={isClearing}
        onConfirm={() => void confirmClear()}
      />
    </>
  );
}
