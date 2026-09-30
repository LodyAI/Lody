import * as stylex from '@stylexjs/stylex';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
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
  match: { backgroundColor: colors.selectedFill },
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
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const queryRef = useRef(deferredQuery);
  queryRef.current = deferredQuery;
  const [matches, setMatches] = useState<CellAddress[]>([]);
  const [matchTotal, setMatchTotal] = useState(0);
  const [matchIndex, setMatchIndex] = useState(0);

  useEffect(() => {
    setRows(null);
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
  const cellWidth = Math.round((144 * zoom) / 100);
  const rowHeight = Math.round((30 * zoom) / 100);
  const headerHeight = Math.round((32 * zoom) / 100);
  const numberWidth = 52;
  const rowVirtualizer = useVirtualizer({
    count: rows?.length ?? 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
  });
  const columnVirtualizer = useVirtualizer({
    count: columnCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => cellWidth,
    horizontal: true,
    overscan: 2,
  });
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
          data-native-selection-allow
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
                  styles.cell(numberWidth + column.start, 0, column.size, headerHeight),
                  styles.header
                )}
                role="columnheader"
                aria-colindex={column.index + 1}
              >
                {columnLabel(column.index)}
              </div>
            ))}
            {rowVirtualizer.getVirtualItems().map((row) => (
              <div key={row.index} role="row">
                <div
                  {...stylex.props(
                    styles.cell(0, headerHeight + row.start, numberWidth, row.size),
                    styles.header
                  )}
                  role="rowheader"
                  aria-rowindex={row.index + 1}
                >
                  {row.index + 1}
                </div>
                {columnVirtualizer.getVirtualItems().map((column) => (
                  <div
                    key={`${row.index}:${column.index}`}
                    {...stylex.props(
                      styles.cell(
                        numberWidth + column.start,
                        headerHeight + row.start,
                        column.size,
                        row.size
                      ),
                      currentMatch?.row === row.index &&
                        currentMatch.col === column.index &&
                        styles.match
                    )}
                    role="gridcell"
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
