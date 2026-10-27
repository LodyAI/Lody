import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { VList } from 'virtua';
import type { PagedFileSource } from '@/lib/paged-file-source';
import { Pagination } from '@lody/ui/pagination';
import { Button } from '@lody/ui/button';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  root: {
    display: 'flex',
    height: '100%',
    minHeight: 0,
    flexDirection: 'column',
  },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: themeSpace[2],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    padding: themeSpace[2],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  notice: {
    padding: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  list: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontFamily: 'var(--font-mono)',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  line: {
    minHeight: themeSpace[5],
    whiteSpace: 'pre',
    paddingInline: themeSpace[3],
    lineHeight: '1.25rem',
  },
});

/** One bounded page, virtual rows, no editor/LSP/HTML execution or accumulated cache. */
export function PagedFileViewer({
  source,
  active = true,
  onOpenExternal,
}: {
  source: PagedFileSource;
  active?: boolean;
  onOpenExternal?: () => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [loaded, setLoaded] = useState<{
    source: PagedFileSource;
    page: number;
    text?: string;
    error?: string;
  }>();
  const pages = Math.max(1, Math.ceil(source.sizeBytes / source.pageBytes));
  const current = Math.min(page, pages - 1);
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    void source.readPage(current, controller.signal).then(
      (text) => {
        if (!controller.signal.aborted) setLoaded({ source, page: current, text });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ source, page: current, error: String(error) });
      }
    );
    return () => controller.abort();
  }, [source, current, active]);
  const result = loaded?.source === source && loaded.page === current ? loaded : undefined;
  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.toolbar)}>
        <span>{t('sessions.fileViewer.paged', 'Large file · read-only')}</span>
        <Pagination
          layout="compact"
          jump
          size="small"
          page={current + 1}
          pages={pages}
          onPageChange={(next) => setPage(next - 1)}
          labels={{
            root: t('sessions.fileViewer.pagination', 'File pages'),
            previous: t('sessions.fileViewer.previousPage', 'Previous page'),
            next: t('sessions.fileViewer.nextPage', 'Next page'),
            jump: t('sessions.fileViewer.page', 'Page'),
            position: (shown, count) =>
              t('sessions.fileViewer.position', 'Page {{page}} of {{total}}', {
                page: shown,
                total: count,
              }),
          }}
        />
        {onOpenExternal ? (
          <Button variant="ghost" size="small" onClick={onOpenExternal}>
            {t('sessions.fileActions.openInDefaultApp', 'Open in default app')}
          </Button>
        ) : null}
      </div>
      {result?.error ? (
        <div role="alert" {...stylex.props(styles.notice)}>
          {t(
            'sessions.fileViewer.pageUnavailable',
            'File changed or is unavailable. Reopen the preview.'
          )}
        </div>
      ) : result?.text === undefined ? (
        <div role="status" {...stylex.props(styles.notice)}>
          {t('sessions.fileViewer.loading', 'Loading file…')}
        </div>
      ) : (
        <VList
          key={`${current}:${source.sizeBytes}`}
          {...stylex.props(styles.list)}
          style={{ overflowX: 'auto' }}
        >
          {result.text.split('\n').map((line, index) => (
            <div key={index} {...stylex.props(styles.line)}>
              {line || ' '}
            </div>
          ))}
        </VList>
      )}
    </div>
  );
}
