import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import {
  ARCHIVE_LIST_OVERSCAN,
  ARCHIVE_LIST_VIRTUALIZE_THRESHOLD,
  archiveRowDataId,
  estimateArchiveRowSize,
  shouldVirtualizeVisibleArchiveRows,
  type ArchiveVirtualRow,
} from '@/lib/archive-list-virtualization';
import { isImeComposingNativeKeyboardEvent } from '@/lib/ime';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';

function isArchiveListTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function rowGapClassName(row: ArchiveVirtualRow): string {
  return cn(
    row.kind === 'header' && !row.isFirst && 'pt-4',
    row.kind === 'header' && row.isLastInGroup && 'pb-4',
    row.kind === 'session' && row.isLastInGroup && 'pb-4'
  );
}

function useArchiveVirtualListKeyboardNavigation({
  enabled,
  rootRef,
  rows,
  scrollToIndex,
}: {
  enabled: boolean;
  rootRef: RefObject<HTMLElement | null>;
  rows: readonly ArchiveVirtualRow[];
  scrollToIndex: (index: number) => void;
}): void {
  const pendingFocusDataIdRef = useRef<string | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const scrollToIndexRef = useRef(scrollToIndex);
  scrollToIndexRef.current = scrollToIndex;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isImeComposingNativeKeyboardEvent(event) || isArchiveListTextInput(event.target)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      const root = rootRef.current;
      if (!root) return;
      const active = document.activeElement;
      if (!(active instanceof Node) || !root.contains(active)) return;

      const currentRows = rowsRef.current;
      if (currentRows.length === 0) return;

      const focusedItem =
        active instanceof HTMLElement ? active.closest<HTMLElement>('[data-scope-item]') : null;
      const focusedId = focusedItem?.getAttribute('data-id');
      const currentIndex = focusedId
        ? currentRows.findIndex((row) => archiveRowDataId(row) === focusedId)
        : -1;

      let nextIndex: number;
      switch (event.key) {
        case 'ArrowDown':
        case 'j':
          nextIndex = currentIndex < 0 ? 0 : currentIndex + 1;
          break;
        case 'ArrowUp':
        case 'k':
          nextIndex = currentIndex < 0 ? currentRows.length - 1 : currentIndex - 1;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = currentRows.length - 1;
          break;
        default:
          return;
      }

      nextIndex = (nextIndex + currentRows.length) % currentRows.length;
      const nextRow = currentRows[nextIndex];
      if (!nextRow) return;
      event.preventDefault();
      pendingFocusDataIdRef.current = archiveRowDataId(nextRow);
      scrollToIndexRef.current(nextIndex);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, rootRef]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const dataId = pendingFocusDataIdRef.current;
    if (!dataId) return;
    const root = rootRef.current;
    if (!root) return;
    const item = root.querySelector(`[data-id="${CSS.escape(dataId)}"]`);
    if (!(item instanceof HTMLElement)) return;
    pendingFocusDataIdRef.current = null;
    const target = item.matches(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]'
    )
      ? item
      : item.querySelector<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]'
        );
    target?.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

export type ArchiveListWindowProps = {
  rows: readonly ArchiveVirtualRow[];
  isMobile: boolean;
  listScopeId: string;
  renderRow: (row: ArchiveVirtualRow) => ReactNode;
  virtualizeThreshold?: number;
  resetScrollKey?: string;
};

export function ArchiveListWindow({
  rows,
  isMobile,
  listScopeId,
  renderRow,
  virtualizeThreshold = ARCHIVE_LIST_VIRTUALIZE_THRESHOLD,
  resetScrollKey,
}: ArchiveListWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = shouldVirtualizeVisibleArchiveRows(rows.length, virtualizeThreshold);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateArchiveRowSize(rows[index], { isMobile }),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: ARCHIVE_LIST_OVERSCAN,
    enabled: shouldVirtualize,
  });

  useEffect(() => {
    if (resetScrollKey === undefined) return;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetScrollKey]);

  useListKeyboardNavigation({ scopeId: listScopeId, enabled: !shouldVirtualize });
  const scrollToIndex = useCallback(
    (index: number) => {
      rowVirtualizer.scrollToIndex(index, { align: 'auto' });
    },
    [rowVirtualizer]
  );
  useArchiveVirtualListKeyboardNavigation({
    enabled: shouldVirtualize,
    rootRef: scrollRef,
    rows,
    scrollToIndex,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      data-archive-list-scroll=""
      className="min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-4 sm:px-6"
    >
      <FocusScope id={listScopeId} className="w-full min-w-0">
        {shouldVirtualize ? (
          <div
            data-archive-list="virtualized"
            className="relative w-full min-w-0"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualItem) => {
              const row = rows[virtualItem.index];
              if (!row) return null;
              return (
                <div
                  key={virtualItem.key}
                  className={cn('absolute left-0 top-0 w-full', rowGapClassName(row))}
                  style={{
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {renderRow(row)}
                </div>
              );
            })}
          </div>
        ) : (
          <div data-archive-list="static" className="flex w-full min-w-0 flex-col">
            {rows.map((row) => (
              <div key={row.key} className={rowGapClassName(row)}>
                {renderRow(row)}
              </div>
            ))}
          </div>
        )}
      </FocusScope>
    </div>
  );
}
