import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

/**
 * Format the publisher's release date for display. The timezone is pinned to
 * UTC so the same release renders the same day everywhere (release feeds carry
 * a date, not a local moment).
 */
function formatReleaseDate(isoDate: string, language: string | undefined): string | null {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(language === 'zh_CN' ? 'zh-CN' : 'en-US', {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(parsed);
  } catch {
    return null;
  }
}

/**
 * In-app changelog for a pending desktop update. Release notes arrive from a
 * remote update feed, so they are rendered as sanitized Markdown (raw HTML
 * off) — never as trusted markup.
 */
export function UpdateChangelogDialog({
  open,
  onOpenChange,
  version,
  releaseDate,
  notes,
  onOpenChangelogSite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: string;
  releaseDate?: string;
  /** Localized release notes, or null when this build ships none. */
  notes: string | null;
  onOpenChangelogSite: () => void;
}) {
  const { t, i18n } = useTranslation();
  const formattedDate = releaseDate ? formatReleaseDate(releaseDate, i18n.resolvedLanguage) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('updates.changelog.title', "What's new in {{version}}", { version })}
          </DialogTitle>
          <DialogDescription>
            {formattedDate
              ? t('updates.changelog.releasedOn', 'Released {{date}}', { date: formattedDate })
              : t('updates.changelog.subtitle', 'Changes included in this update.')}
          </DialogDescription>
        </DialogHeader>
        {notes ? (
          <div className="max-h-[50vh] overflow-y-auto pr-1">
            <MarkdownRenderer text={notes} size="sm" allowHtml={false} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(
              'updates.changelog.unavailable',
              'This update did not ship release notes. Open the changelog website to see what changed.'
            )}
          </p>
        )}
        <DialogFooter>
          {!notes ? (
            <Button variant="secondary" size="small" onClick={onOpenChangelogSite}>
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              {t('updates.changelog.openWebsite', 'Open changelog website')}
            </Button>
          ) : null}
          <Button size="small" onClick={() => onOpenChange(false)}>
            {t('common.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
