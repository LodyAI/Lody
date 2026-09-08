import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VList } from 'virtua';
import type { PagedFileSource } from '@/lib/paged-file-source';
import { Input } from '@/ui/input';
import { Button } from '@lody/ui/button';

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs text-muted-foreground">
        <span>{t('sessions.fileViewer.paged', 'Large file · read-only')}</span>
        <Button
          variant="ghost"
          size="small"
          disabled={current === 0}
          onClick={() => setPage(current - 1)}
        >
          {t('sessions.fileViewer.previousPage', 'Previous page')}
        </Button>
        <label>
          {t('sessions.fileViewer.page', 'Page')}{' '}
          <Input
            aria-label={t('sessions.fileViewer.page', 'Page')}
            type="number"
            min={1}
            max={pages}
            value={current + 1}
            className="inline-flex h-7 w-20 px-2 py-1"
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isSafeInteger(value) && value >= 1 && value <= pages) setPage(value - 1);
            }}
          />
          {' / '}
          {pages.toLocaleString()}
        </label>
        <Button
          variant="ghost"
          size="small"
          disabled={current + 1 >= pages}
          onClick={() => setPage(current + 1)}
        >
          {t('sessions.fileViewer.nextPage', 'Next page')}
        </Button>
        {onOpenExternal ? (
          <Button variant="ghost" size="small" onClick={onOpenExternal}>
            {t('sessions.fileActions.openInDefaultApp', 'Open in default app')}
          </Button>
        ) : null}
      </div>
      {result?.error ? (
        <div role="alert" className="p-3 text-sm">
          {t(
            'sessions.fileViewer.pageUnavailable',
            'File changed or is unavailable. Reopen the preview.'
          )}
        </div>
      ) : result?.text === undefined ? (
        <div role="status" className="p-3 text-sm">
          {t('sessions.fileViewer.loading', 'Loading file…')}
        </div>
      ) : (
        <VList
          key={`${current}:${source.sizeBytes}`}
          className="min-h-0 flex-1 font-mono text-xs"
          style={{ overflowX: 'auto' }}
        >
          {result.text.split('\n').map((line, index) => (
            <div key={index} className="min-h-5 whitespace-pre px-3 leading-5">
              {line || ' '}
            </div>
          ))}
        </VList>
      )}
    </div>
  );
}
