import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

/** Release notes read as a column of prose: wider than the default panel. */
const PANEL_WIDTH = '576px';

const styles = stylex.create({
  notes: { maxHeight: '50vh', overflowY: 'auto', paddingInlineEnd: '4px' },
  unavailable: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
  },
  icon: { flexShrink: 0, width: '14px', height: '14px' },
});

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content style={{ width: PANEL_WIDTH }}>
        <Dialog.Header>
          <Dialog.Title>
            {t('updates.changelog.title', "What's new in {{version}}", { version })}
          </Dialog.Title>
          <Dialog.Description>
            {formattedDate
              ? t('updates.changelog.releasedOn', 'Released {{date}}', { date: formattedDate })
              : t('updates.changelog.subtitle', 'Changes included in this update.')}
          </Dialog.Description>
        </Dialog.Header>
        {notes ? (
          <div {...stylex.props(styles.notes)}>
            <MarkdownRenderer text={notes} size="sm" allowHtml={false} />
          </div>
        ) : (
          <p {...stylex.props(styles.unavailable)}>
            {t(
              'updates.changelog.unavailable',
              'This update did not ship release notes. Open the changelog website to see what changed.'
            )}
          </p>
        )}
        <Dialog.Footer>
          {!notes ? (
            <Button variant="secondary" size="small" onClick={onOpenChangelogSite}>
              <ExternalLink {...stylex.props(styles.icon)} />
              {t('updates.changelog.openWebsite', 'Open changelog website')}
            </Button>
          ) : null}
          <Button size="small" onClick={() => onOpenChange(false)}>
            {t('common.close', 'Close')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
