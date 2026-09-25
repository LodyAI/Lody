import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import {
  ARCHIVE_GROUP_GAP_PX,
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

const WIDE = '@media (min-width: 640px)';

const styles = stylex.create({
  scroll: {
    boxSizing: 'border-box',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    width: '100%',
    minWidth: 0,
    minHeight: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    // A few px above the first row, so a card's top edge is not clipped by the scrollport.
    paddingTop: space[1],
    paddingBottom: space[4],
    paddingInline: { default: space[4], [WIDE]: space[6] },
  },
  fill: { width: '100%', minWidth: 0 },
  virtualList: { position: 'relative', width: '100%', minWidth: 0 },
  virtualItem: { position: 'absolute', top: 0, left: 0, width: '100%' },
  staticList: { display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 },
  gapBefore: { paddingTop: space[4] },
  gapAfter: { paddingBottom: space[4] },
  /**
   * A group's sessions are one card of ruled rows. The card is drawn here, under
   * the rows, rather than by a row: a virtualized row is positioned alone, so the
   * card spans the group's run from the virtualizer's own measurements.
   */
  card: {
    boxSizing: 'border-box',
    minWidth: 0,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  virtualCard: { position: 'absolute', top: 0, left: 0, width: '100%' },
});

function rowGapStyles(row: ArchiveVirtualRow) {
  return [
    row.kind === 'header' && !row.isFirst && styles.gapBefore,
    row.isLastInGroup && styles.gapAfter,
  ];
}

/** One card: the consecutive session rows of a group, as row indexes (inclusive). */
type ArchiveCardRun = { key: string; start: number; end: number };

function archiveCardRuns(rows: readonly ArchiveVirtualRow[]): ArchiveCardRun[] {
  const runs: ArchiveCardRun[] = [];
  let current: ArchiveCardRun | null = null;
  rows.forEach((row, index) => {
    if (row.kind !== 'session') {
      current = null;
      return;
    }
    const previous = rows[index - 1];
    if (current && previous?.kind === 'session' && previous.groupKey === row.groupKey) {
      current.end = index;
    } else {
      current = { key: `card:${row.groupKey}:${index}`, start: index, end: index };
      runs.push(current);
    }
    if (row.isLastInGroup) current = null;
  });
  return runs;
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
  // Phones keep the flat list of the rest of the mobile shell: a swipe row's
  // content is opaque on the page, so it cannot sit on a card.
  const drawCards = !isMobile;
  const cardRuns = useMemo(() => (drawCards ? archiveCardRuns(rows) : []), [drawCards, rows]);

  const renderStaticRows = () => {
    if (!drawCards) {
      return rows.map((row) => (
        <div key={row.key} {...stylex.props(rowGapStyles(row))}>
          {renderRow(row)}
        </div>
      ));
    }
    const runByStart = new Map(cardRuns.map((run) => [run.start, run]));
    const nodes: ReactNode[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      const run = runByStart.get(index);
      if (!run) {
        nodes.push(
          <div key={row.key} {...stylex.props(rowGapStyles(row))}>
            {renderRow(row)}
          </div>
        );
        continue;
      }
      const runRows = rows.slice(run.start, run.end + 1);
      nodes.push(
        <div key={run.key} {...stylex.props(runRows.at(-1)?.isLastInGroup && styles.gapAfter)}>
          <div {...stylex.props(styles.card)}>
            {runRows.map((runRow) => (
              <div key={runRow.key}>{renderRow(runRow)}</div>
            ))}
          </div>
        </div>
      );
      index = run.end;
    }
    return nodes;
  };

  const renderVirtualCards = () => {
    const first = virtualItems[0];
    const last = virtualItems.at(-1);
    if (!drawCards || !first || !last) return null;
    const measurements = rowVirtualizer.measurementsCache;
    return cardRuns.map((run) => {
      if (run.end < first.index || run.start > last.index) return null;
      const top = measurements[run.start]?.start;
      const bottom = measurements[run.end]?.end;
      if (top === undefined || bottom === undefined) return null;
      const gap = rows[run.end]?.isLastInGroup ? ARCHIVE_GROUP_GAP_PX : 0;
      return (
        <div
          key={run.key}
          aria-hidden
          {...stylex.props(styles.card, styles.virtualCard)}
          style={{
            height: `${bottom - gap - top}px`,
            transform: `translateY(${top}px)`,
          }}
        />
      );
    });
  };

  return (
    <div ref={scrollRef} data-archive-list-scroll="" {...stylex.props(styles.scroll)}>
      <FocusScope id={listScopeId} {...stylex.props(styles.fill)}>
        {shouldVirtualize ? (
          <div
            data-archive-list="virtualized"
            {...stylex.props(styles.virtualList)}
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {renderVirtualCards()}
            {virtualItems.map((virtualItem) => {
              const row = rows[virtualItem.index];
              if (!row) return null;
              return (
                <div
                  key={virtualItem.key}
                  {...stylex.props(styles.virtualItem, rowGapStyles(row))}
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
          <div data-archive-list="static" {...stylex.props(styles.staticList)}>
            {renderStaticRows()}
          </div>
        )}
      </FocusScope>
    </div>
  );
}
