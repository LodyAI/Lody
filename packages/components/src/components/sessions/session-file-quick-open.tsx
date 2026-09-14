import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Spinner } from '@/ui/spinner';
import { useTranslation } from 'react-i18next';
import { getBasename } from '@/lib';
import type { SessionFileProvider, SessionFileProviderEntry } from '@/lib/session-file-provider';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/ui/command';
import { FileIcon } from '@/components/icons/file-icons';

export type SessionFileQuickOpenItem = {
  readonly path: string;
  readonly fileId?: string;
  readonly readonly?: boolean;
};

const QUICK_OPEN_VIRTUALIZE_THRESHOLD = 50;
const QUICK_OPEN_ROW_ESTIMATE_PX = 52;
const QUICK_OPEN_OVERSCAN = 8;
const EMPTY_QUICK_OPEN_FALLBACK_PATHS: readonly string[] = [];

export function mapSessionFileProviderEntriesToQuickOpenItems(
  entries: readonly SessionFileProviderEntry[],
  limit?: number
): SessionFileQuickOpenItem[] {
  return sliceQuickOpenItems(entries, limit).map((entry) => ({
    path: entry.path,
    ...(entry.fileId === undefined ? {} : { fileId: entry.fileId }),
    ...(entry.readonly === undefined ? {} : { readonly: entry.readonly }),
  }));
}

export function filterSessionFileQuickOpenFallbackPaths(
  paths: readonly string[],
  query: string,
  limit?: number
): SessionFileQuickOpenItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedPaths = [...new Set(paths.filter((path) => path.trim().length > 0))].sort(
    (left, right) => left.localeCompare(right)
  );
  const filtered = normalizedQuery
    ? normalizedPaths.filter((path) => path.toLowerCase().includes(normalizedQuery))
    : normalizedPaths;
  return sliceQuickOpenItems(filtered, limit).map((path) => ({ path }));
}

export function shouldVirtualizeSessionFileQuickOpenItems(
  itemCount: number,
  threshold = QUICK_OPEN_VIRTUALIZE_THRESHOLD
): boolean {
  return itemCount > threshold;
}

export async function loadSessionFileQuickOpenItems(input: {
  readonly provider?: SessionFileProvider | null;
  readonly fallbackPaths?: readonly string[];
  readonly query: string;
}): Promise<SessionFileQuickOpenItem[]> {
  if (!input.provider) {
    return filterSessionFileQuickOpenFallbackPaths(input.fallbackPaths ?? [], input.query);
  }
  const providerState = input.provider.getState();
  if (!providerState.ready) {
    throw new Error(providerState.message ?? 'Files are unavailable.');
  }
  const entries = await input.provider.searchFiles(input.query);
  return mapSessionFileProviderEntriesToQuickOpenItems(entries);
}

function sliceQuickOpenItems<T>(items: readonly T[], limit?: number): readonly T[] {
  if (limit === undefined) return items;
  return items.slice(0, limit);
}

export function SessionFileQuickOpen({
  open,
  onOpenChange,
  provider,
  providerPending,
  providerMessage,
  fallbackPaths = EMPTY_QUICK_OPEN_FALLBACK_PATHS,
  onOpenFile,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly provider?: SessionFileProvider | null;
  readonly providerPending?: boolean;
  readonly providerMessage?: string;
  readonly fallbackPaths?: readonly string[];
  readonly onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SessionFileQuickOpenItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const listViewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    if (providerPending === true && !provider) {
      setItems([]);
      setLoading(true);
      setMessage(
        providerMessage ?? t('sessions.codeSession.connecting', 'Connecting to code session…')
      );
      return undefined;
    }

    if (!provider) {
      setLoading(false);
      setMessage(null);
      setItems(filterSessionFileQuickOpenFallbackPaths(fallbackPaths, query));
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setMessage(null);

    void loadSessionFileQuickOpenItems({ provider, fallbackPaths, query })
      .then((nextItems) => {
        if (cancelled) return;
        setItems(nextItems);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setItems([]);
        setLoading(false);
        setMessage(error instanceof Error ? error.message : 'Failed to search files.');
      });

    return () => {
      cancelled = true;
    };
  }, [fallbackPaths, open, provider, providerMessage, providerPending, query, t]);

  const emptyLabel = useMemo(() => {
    if (loading) {
      return message ?? t('sessions.fileQuickOpen.loading', 'Loading files…');
    }
    if (message) {
      return message;
    }
    if (!provider && fallbackPaths.length === 0) {
      return t('sessions.fileQuickOpen.noIndex', 'No file index is available yet.');
    }
    return t('sessions.fileQuickOpen.empty', 'No matching files.');
  }, [fallbackPaths.length, loading, message, provider, t]);

  const handleSelect = (path: string) => {
    onOpenFile(path);
    onOpenChange(false);
  };
  const shouldVirtualizeItems = shouldVirtualizeSessionFileQuickOpenItems(items.length);
  const getVirtualItemKey = useCallback(
    (index: number) => items[index]?.fileId ?? items[index]?.path ?? index,
    [items]
  );
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => listViewportRef.current,
    estimateSize: () => QUICK_OPEN_ROW_ESTIMATE_PX,
    getItemKey: getVirtualItemKey,
    overscan: QUICK_OPEN_OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    if (!open) return;
    listViewportRef.current?.scrollTo({ top: 0 });
  }, [open, provider, query]);

  const renderItem = (item: SessionFileQuickOpenItem) => (
    <>
      <FileIcon filePath={item.path} className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{getBasename(item.path)}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">{item.path}</div>
      </div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl">
        <DialogTitle className="sr-only">
          {t('sessions.fileQuickOpen.title', 'Quick open file')}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t('sessions.fileQuickOpen.description', 'Search indexed files and open one.')}
        </DialogDescription>
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('sessions.fileQuickOpen.placeholder', 'Search files…')}
          />
          <CommandList
            containerClassName="max-h-[420px]"
            viewportClassName="max-h-[420px]"
            viewportRef={listViewportRef}
          >
            <CommandEmpty>
              <div className="flex items-center justify-center gap-2 px-3 text-muted-foreground">
                {loading ? <Spinner className="h-4 w-4" /> : null}
                <span>{emptyLabel}</span>
              </div>
            </CommandEmpty>
            {items.length > 0 && shouldVirtualizeItems ? (
              <CommandGroup className="p-0">
                <div
                  className="relative w-full"
                  style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                >
                  {virtualItems.map((virtualItem) => {
                    const item = items[virtualItem.index];
                    if (!item) return null;
                    return (
                      <CommandItem
                        key={virtualItem.key}
                        value={item.path}
                        onSelect={() => handleSelect(item.path)}
                        className="absolute left-0 top-0 min-w-0 py-2"
                        style={{
                          height: `${virtualItem.size}px`,
                          transform: `translateY(${virtualItem.start}px)`,
                          width: '100%',
                        }}
                      >
                        {renderItem(item)}
                      </CommandItem>
                    );
                  })}
                </div>
              </CommandGroup>
            ) : items.length > 0 ? (
              <CommandGroup>
                {items.map((item) => (
                  <CommandItem
                    key={item.fileId ?? item.path}
                    value={item.path}
                    onSelect={() => handleSelect(item.path)}
                    className="min-w-0 py-2"
                  >
                    {renderItem(item)}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
