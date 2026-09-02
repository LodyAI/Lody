import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Progress } from '@/ui/progress';
import { cn } from '@/lib/utils';
import type { UpdateBannerState } from '@/lib/electron-update-banner';

/**
 * Floating sidebar notice for a desktop update that is downloading or ready to
 * install. `View changelog` opens the in-app changelog dialog; it must never
 * leave the app on its own.
 */
export function SidebarUpdateBanner({
  stage,
  version,
  percent,
  isRestarting,
  onViewChangelog,
  onRestart,
  onLater,
}: UpdateBannerState & {
  isRestarting: boolean;
  onViewChangelog: () => void;
  onRestart: () => void;
  onLater: () => void;
}) {
  const { t } = useTranslation();
  const isDownloading = stage === 'downloading';

  return (
    <div
      className={cn(
        'rounded-lg border border-border/80 bg-background/95 px-3 py-2 shadow-lg backdrop-blur-sm',
        'supports-[backdrop-filter]:bg-background/85'
      )}
    >
      <div className="text-sm font-semibold text-foreground">
        {isDownloading
          ? t('sidebar.updateDownloading.title', 'Downloading update')
          : t('sidebar.updateReady.title', 'Update ready')}
      </div>
      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {isDownloading
          ? t(
              'sidebar.updateDownloading.description',
              'Version {{version}} is downloading in the background.',
              { version }
            )
          : t('sidebar.updateReady.description', 'Restart to update to {{version}}.', { version })}
      </div>
      {isDownloading && percent != null ? (
        <div className="mt-2 flex items-center gap-2">
          <Progress value={percent} className="h-1 flex-1" />
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t('sidebar.updateDownloading.percent', '{{percent}}%', { percent })}
          </span>
        </div>
      ) : null}
      <button
        type="button"
        onClick={onViewChangelog}
        className="mt-1 inline-flex text-xs font-medium text-primary underline-offset-2 hover:underline"
      >
        {t('sidebar.updateReady.changelog', 'View changelog')}
      </button>
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="small" onClick={onLater}>
          {t('sidebar.updateReady.later', 'Later')}
        </Button>
        {isDownloading ? null : (
          <Button type="button" size="small" onClick={onRestart}>
            {isRestarting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {t('sidebar.updateReady.restart', 'Update & Restart')}
          </Button>
        )}
      </div>
    </div>
  );
}
