import * as stylex from '@stylexjs/stylex';
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp, Copy, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  createSpreadsheetClipboard,
  writeSpreadsheetClipboard,
} from './session-file-spreadsheet-clipboard';
import { scheduleFilePreviewWhenIdle } from '@/lib/session-file-preview-idle';

interface CellAddress {
  readonly row: number;
  readonly col: number;
}

interface ParsedMessage {
  readonly type: 'parsed';
  readonly rows: string[][];
  readonly truncated: boolean;
}

interface MatchesMessage {
  readonly type: 'matches';
  readonly query: string;
  readonly matches: CellAddress[];
  readonly total: number;
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    color: colors.label,
    backgroundColor: colors.background,
  },
  toolbar: {
    display: 'flex',
    flex: '0 0 auto',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[2],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  group: { display: 'inline-flex', alignItems: 'center', gap: space[1] },
  spacer: { flex: '1 1 auto' },
  search: { width: 'min(100%, 13rem)' },
  label: { color: colors.secondaryLabel, fontSize: '0.75rem' },
  gridViewport: {
    flex: '1 1 auto',
    minHeight: 0,
    minWidth: 0,
    overflow: 'auto',
    backgroundColor: colors.background,
    userSelect: 'none',
    touchAction: 'pan-x pan-y',
  },
  gridSpace: (width: number, height: number) => ({ position: 'relative', width, height }),
  cell: (left: number, top: number, width: number, height: number) => ({
    position: 'absolute',
    left,
    top,
    width,
    height,
    overflow: 'hidden',
    paddingInline: space[2],
    display: 'flex',
    alignItems: 'center',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.separator,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    fontSize: '0.75rem',
  }),
  header: { backgroundColor: colors.secondaryBackground, color: colors.secondaryLabel },
  match: {
    backgroundColor: colors.selectedFill,
    borderBottomColor: colors.warning,
    borderBottomWidth: 2,
  },
  selected: { backgroundColor: colors.selectedFill },
  activeCell: { outline: `2px solid ${colors.accent}`, outlineOffset: '-2px' },
  resizeHandle: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 8,
    cursor: 'col-resize',
    touchAction: 'none',
    backgroundColor: { default: 'transparent', ':hover': colors.accent },
  },
  status: {
    display: 'flex',
    flex: '1 1 auto',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    color: colors.secondaryLabel,
    fontSize: '0.875rem',
  },
  warning: {
    paddingInline: space[3],
    paddingBlock: space[2],
    color: colors.secondaryLabel,
    fontSize: '0.75rem',
  },
});

function columnLabel(index: number): string {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function SessionFileCsvPreview({
  text,
  path,
  active,
}: {
  readonly text: string;
  readonly path: string;
  readonly active: boolean;
}) {
  const { t } = useTranslation();
  const workerRef = useRef<Worker | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(100);
  const gridId = useId();
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [selection, setSelection] = useState<{ anchor: CellAddress; end: CellAddress } | null>(
    null
  );
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copyFailed' | 'copyTooLarge' | null>(
    null
  );
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setColumnWidths({});
    setSelection(null);
    setCopyStatus(null);
  }, [path, text]);

  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const queryRef = useRef(deferredQuery);
  queryRef.current = deferredQuery;
  const [matches, setMatches] = useState<CellAddress[]>([]);
  const [matchTotal, setMatchTotal] = useState(0);
  const [matchIndex, setMatchIndex] = useState(0);

  useEffect(() => {
    setRows(null);
    setDragging(false);
    dragRef.current = null;
    setTruncated(false);
    setFailed(false);
    setMatches([]);
    setMatchTotal(0);
    if (!active) return undefined;
    let disposed = false;
    const cancelIdle = scheduleFilePreviewWhenIdle(() => {
      if (disposed) return;
      const worker = new Worker(new URL('./session-file-csv.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = worker;
      worker.onmessage = (
        event: MessageEvent<ParsedMessage | MatchesMessage | { type: 'error' }>
      ) => {
        if (disposed) return;
        const message = event.data;
        if (message.type === 'parsed') {
          setRows(message.rows);
          setTruncated(message.truncated);
        } else if (message.type === 'matches') {
          if (message.query !== queryRef.current) return;
          setMatches(message.matches);
          setMatchTotal(message.total);
          setMatchIndex(0);
        } else {
          setFailed(true);
        }
      };
      worker.onerror = () => {
        if (!disposed) setFailed(true);
      };
      worker.postMessage({
        type: 'parse',
        text,
        delimiter: path.toLowerCase().endsWith('.tsv') ? '\t' : ',',
      });
    });
    return () => {
      disposed = true;
      cancelIdle();
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [active, path, text]);

  useEffect(() => {
    if (rows) workerRef.current?.postMessage({ type: 'search', query: deferredQuery });
  }, [deferredQuery, rows]);

  const columnCount = useMemo(
    () => rows?.reduce((maximum, row) => Math.max(maximum, row.length), 0) ?? 0,
    [rows]
  );
  const resizeColumn = (index: number, width: number) =>
    setColumnWidths((current) => ({
      ...current,
      [index]: Math.max(48, Math.min(800, width)),
    }));
  const columnSizes = useMemo(
    () =>
      Array.from({ length: columnCount }, (_, index) =>
        Math.round(((columnWidths[index] ?? 144) * zoom) / 100)
      ),
    [columnCount, columnWidths, zoom]
  );
  const rowHeight = Math.round((30 * zoom) / 100);
  const headerHeight = Math.round((32 * zoom) / 100);
  const numberWidth = 52;
  const rowVirtualizer = useVirtualizer({
    count: rows?.length ?? 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => rowHeight,
    scrollMargin: headerHeight,
    overscan: 4,
  });
  const columnVirtualizer = useVirtualizer({
    count: columnCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => columnSizes[index],
    scrollMargin: numberWidth,
    horizontal: true,
    overscan: 2,
  });
  useEffect(() => {
    columnVirtualizer.measure();
  }, [columnSizes, columnVirtualizer]);
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  const bounds = selection && {
    top: Math.min(selection.anchor.row, selection.end.row),
    bottom: Math.max(selection.anchor.row, selection.end.row),
    left: Math.min(selection.anchor.col, selection.end.col),
    right: Math.max(selection.anchor.col, selection.end.col),
  };
  const clipboardData = () => {
    if (!rows || !bounds) return null;
    if ((bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1) > 200_000)
      throw new RangeError('Selection too large');
    return createSpreadsheetClipboard(
      rows
        .slice(bounds.top, bounds.bottom + 1)
        .map((row) =>
          Array.from(
            { length: bounds.right - bounds.left + 1 },
            (_, index) => row[bounds.left + index] ?? ''
          )
        )
    );
  };
  const copySelection = () => {
    try {
      const data = clipboardData();
      if (!data) return;
      setCopyStatus(null);
      void writeSpreadsheetClipboard(data).then(
        () => setCopyStatus('copied'),
        () => setCopyStatus('copyFailed')
      );
    } catch (error) {
      setCopyStatus(error instanceof RangeError ? 'copyTooLarge' : 'copyFailed');
    }
  };
  const extendSelection = useCallback(
    (x: number, y: number) => {
      const viewport = viewportRef.current;
      if (!viewport || !rows || rows.length === 0 || columnCount === 0) return;
      const rect = viewport.getBoundingClientRect();
      const offset = x - rect.left + viewport.scrollLeft - numberWidth;
      let col = 0;
      let edge = columnSizes[0];
      while (col < columnCount - 1 && offset >= edge) edge += columnSizes[++col];
      const row = Math.max(
        0,
        Math.min(
          rows.length - 1,
          Math.floor((y - rect.top + viewport.scrollTop - headerHeight) / rowHeight)
        )
      );
      setSelection((current) =>
        current && (current.end.row !== row || current.end.col !== col)
          ? { ...current, end: { row, col } }
          : current
      );
    },
    [rows, columnCount, columnSizes, headerHeight, rowHeight]
  );

  // Pointer capture and edge scrolling extend selection beyond mounted virtual cells.
  useEffect(() => {
    if (!dragging) return undefined;
    let frame: number;
    const move = () => {
      const viewport = viewportRef.current;
      const pointer = dragRef.current;
      if (!viewport || !pointer) return;
      const rect = viewport.getBoundingClientRect();
      const delta = (value: number, start: number, end: number) =>
        value < start + 24 ? -12 : value > end - 24 ? 12 : 0;
      viewport.scrollBy(
        delta(pointer.x, rect.left, rect.right),
        delta(pointer.y, rect.top, rect.bottom)
      );
      extendSelection(pointer.x, pointer.y);
      frame = requestAnimationFrame(move);
    };
    frame = requestAnimationFrame(move);
    return () => cancelAnimationFrame(frame);
  }, [dragging, extendSelection]);

  const currentMatch = matches[matchIndex];
  const goToMatch = (index: number) => {
    if (matches.length === 0) return;
    const next = (index + matches.length) % matches.length;
    setMatchIndex(next);
    rowVirtualizer.scrollToIndex(matches[next].row, { align: 'center' });
    columnVirtualizer.scrollToIndex(matches[next].col, { align: 'center' });
  };

  return (
    <section
      {...stylex.props(styles.root)}
      aria-label={t('sessions.fileViewer.csv.viewer', 'CSV viewer')}
    >
      <div {...stylex.props(styles.toolbar)}>
        <span {...stylex.props(styles.label)}>
          {rows
            ? t('sessions.fileViewer.csv.dimensions', '{{rows}} rows · {{columns}} columns', {
                rows: rows.length,
                columns: columnCount,
              })
            : ''}
        </span>
        <span {...stylex.props(styles.spacer)} />
        <Button
          type="button"
          variant="ghost"
          size="mini"
          disabled={!selection || !rows}
          onClick={copySelection}
        >
          <Copy size={16} aria-hidden />
          {t('sessions.fileViewer.spreadsheet.copySelection', 'Copy selection')}
        </Button>
        <div {...stylex.props(styles.group)}>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.zoomOut', 'Zoom out')}
            disabled={zoom <= 50}
            onClick={() => setZoom((value) => value - 25)}
          >
            <ZoomOut size={16} aria-hidden />
          </Button>
          <span {...stylex.props(styles.label)}>{zoom}%</span>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.zoomIn', 'Zoom in')}
            disabled={zoom >= 200}
            onClick={() => setZoom((value) => value + 25)}
          >
            <ZoomIn size={16} aria-hidden />
          </Button>
        </div>
        <span {...stylex.props(styles.search)}>
          <Input
            type="search"
            size="small"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t('sessions.fileViewer.csv.search', 'Search cells')}
            aria-label={t('sessions.fileViewer.csv.search', 'Search cells')}
          />
        </span>
        <span {...stylex.props(styles.label)} aria-live="polite">
          {matchTotal > 0
            ? `${matchIndex + 1}/${matches.length}${matchTotal > matches.length ? '+' : ''}`
            : ''}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          aria-label={t('sessions.fileViewer.csv.previousMatch', 'Previous match')}
          disabled={matches.length === 0}
          onClick={() => goToMatch(matchIndex - 1)}
        >
          <ChevronUp size={16} aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          aria-label={t('sessions.fileViewer.csv.nextMatch', 'Next match')}
          disabled={matches.length === 0}
          onClick={() => goToMatch(matchIndex + 1)}
        >
          <ChevronDown size={16} aria-hidden />
        </Button>
      </div>
      {failed ? (
        <div {...stylex.props(styles.status)} role="alert">
          {t(
            'sessions.fileViewer.csv.failed',
            'This table could not be previewed. Switch to source view.'
          )}
        </div>
      ) : rows ? (
        <div
          ref={viewportRef}
          {...stylex.props(styles.gridViewport)}
          role="grid"
          aria-rowcount={rows.length}
          aria-colcount={columnCount}
          tabIndex={0}
          onFocus={(event) => {
            if (event.target === event.currentTarget && !selection && rows.length && columnCount) {
              const first = { row: 0, col: 0 };
              setSelection({ anchor: first, end: first });
            }
          }}
          aria-readonly="true"
          aria-multiselectable="true"
          aria-activedescendant={
            selection ? `${gridId}-${selection.end.row}-${selection.end.col}` : undefined
          }
          onCopy={(event) => {
            if (!selection) return;
            event.preventDefault();
            event.stopPropagation();
            try {
              const data = clipboardData();
              if (!data) return;
              event.clipboardData.setData('text/plain', data.text);
              event.clipboardData.setData('text/html', data.html);
              setCopyStatus('copied');
            } catch (error) {
              setCopyStatus(error instanceof RangeError ? 'copyTooLarge' : 'copyFailed');
            }
          }}
          onPointerMove={(event) => {
            if (dragRef.current) {
              dragRef.current = { x: event.clientX, y: event.clientY };
              extendSelection(event.clientX, event.clientY);
            }
          }}
          onPointerUp={(event) => {
            if (dragRef.current) extendSelection(event.clientX, event.clientY);
            dragRef.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={() => {
            dragRef.current = null;
            setDragging(false);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || !rows.length || !columnCount) return;
            const current = selection?.end ?? { row: 0, col: 0 };
            let next = current;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
              event.preventDefault();
              setCopyStatus(null);
              setSelection({
                anchor: { row: 0, col: 0 },
                end: { row: rows.length - 1, col: columnCount - 1 },
              });
              return;
            }
            if (event.key === 'ArrowDown')
              next = { ...current, row: Math.min(rows.length - 1, current.row + 1) };
            else if (event.key === 'ArrowUp')
              next = { ...current, row: Math.max(0, current.row - 1) };
            else if (event.key === 'ArrowRight')
              next = { ...current, col: Math.min(columnCount - 1, current.col + 1) };
            else if (event.key === 'ArrowLeft')
              next = { ...current, col: Math.max(0, current.col - 1) };
            else if (event.key === 'Home')
              next = { row: event.ctrlKey || event.metaKey ? 0 : current.row, col: 0 };
            else if (event.key === 'End')
              next = {
                row: event.ctrlKey || event.metaKey ? rows.length - 1 : current.row,
                col: columnCount - 1,
              };
            else return;
            event.preventDefault();
            setCopyStatus(null);
            setSelection({
              anchor: event.shiftKey && selection ? selection.anchor : next,
              end: next,
            });
            rowVirtualizer.scrollToIndex(next.row, { align: 'auto' });
            columnVirtualizer.scrollToIndex(next.col, { align: 'auto' });
          }}
        >
          <div
            {...stylex.props(
              styles.gridSpace(
                numberWidth + columnVirtualizer.getTotalSize(),
                headerHeight + rowVirtualizer.getTotalSize()
              )
            )}
          >
            <div {...stylex.props(styles.cell(0, 0, numberWidth, headerHeight), styles.header)} />
            {columnVirtualizer.getVirtualItems().map((column) => (
              <div
                key={`header-${column.index}`}
                {...stylex.props(
                  styles.cell(column.start, 0, column.size, headerHeight),
                  styles.header
                )}
                role="columnheader"
                aria-colindex={column.index + 1}
              >
                {columnLabel(column.index)}
                <div
                  {...stylex.props(styles.resizeHandle)}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t(
                    'sessions.fileViewer.spreadsheet.resizeColumn',
                    'Resize column {{column}}',
                    { column: columnLabel(column.index) }
                  )}
                  aria-valuenow={Math.round(columnWidths[column.index] ?? 144)}
                  aria-valuemin={48}
                  aria-valuemax={800}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    resizeColumn(
                      column.index,
                      (columnWidths[column.index] ?? 144) + (event.key === 'ArrowRight' ? 16 : -16)
                    );
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const handle = event.currentTarget;
                    const startX = event.clientX;
                    const startWidth = columnWidths[column.index] ?? 144;
                    handle.setPointerCapture(event.pointerId);
                    handle.onpointermove = (move) =>
                      resizeColumn(
                        column.index,
                        startWidth + ((move.clientX - startX) * 100) / zoom
                      );
                    handle.onlostpointercapture = () => {
                      handle.onpointermove = null;
                      handle.onlostpointercapture = null;
                    };
                  }}
                />
              </div>
            ))}
            {rowVirtualizer.getVirtualItems().map((row) => (
              <div key={row.index} role="row">
                <div
                  {...stylex.props(styles.cell(0, row.start, numberWidth, row.size), styles.header)}
                  role="rowheader"
                  aria-rowindex={row.index + 1}
                >
                  {row.index + 1}
                </div>
                {columnVirtualizer.getVirtualItems().map((column) => (
                  <div
                    key={`${row.index}:${column.index}`}
                    {...stylex.props(
                      styles.cell(column.start, row.start, column.size, row.size),
                      currentMatch?.row === row.index &&
                        currentMatch.col === column.index &&
                        styles.match,
                      bounds &&
                        row.index >= bounds.top &&
                        row.index <= bounds.bottom &&
                        column.index >= bounds.left &&
                        column.index <= bounds.right &&
                        styles.selected,
                      selection?.end.row === row.index &&
                        selection.end.col === column.index &&
                        styles.activeCell
                    )}
                    id={`${gridId}-${row.index}-${column.index}`}
                    role="gridcell"
                    aria-selected={
                      !!bounds &&
                      row.index >= bounds.top &&
                      row.index <= bounds.bottom &&
                      column.index >= bounds.left &&
                      column.index <= bounds.right
                    }
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      viewportRef.current?.focus({ preventScroll: true });
                      const address = { row: row.index, col: column.index };
                      setSelection({
                        anchor: event.shiftKey && selection ? selection.anchor : address,
                        end: address,
                      });
                      setCopyStatus(null);
                      // Touch keeps native panning; tap and Shift-click still select a cell/range.
                      if (event.pointerType === 'touch') return;
                      viewportRef.current?.setPointerCapture(event.pointerId);
                      dragRef.current = { x: event.clientX, y: event.clientY };
                      setDragging(true);
                    }}
                    aria-rowindex={row.index + 1}
                    aria-colindex={column.index + 1}
                    title={rows[row.index]?.[column.index] ?? ''}
                  >
                    {rows[row.index]?.[column.index] ?? ''}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div {...stylex.props(styles.status)} role="status">
          <Spinner label={null} />
          {t('sessions.fileViewer.csv.loading', 'Loading table…')}
        </div>
      )}
      {copyStatus ? (
        <div {...stylex.props(styles.warning)} role="status">
          {copyStatus === 'copied'
            ? t('sessions.fileViewer.spreadsheet.copied', 'Selection copied')
            : copyStatus === 'copyTooLarge'
              ? t('sessions.fileViewer.spreadsheet.copyTooLarge', 'Select a smaller range to copy')
              : t('sessions.fileViewer.spreadsheet.copyFailed', 'Could not copy the selection')}
        </div>
      ) : null}
      {truncated ? (
        <div {...stylex.props(styles.warning)}>
          {t(
            'sessions.fileViewer.csv.truncated',
            'Table preview is limited; switch to source view for the original file.'
          )}
        </div>
      ) : null}
    </section>
  );
}
