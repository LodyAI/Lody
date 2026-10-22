import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react';
import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequest,
  Hand,
  ChevronDown,
  ChevronUp,
  History,
  PencilLine,
  type LucideIcon,
} from 'lucide-react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import type { HomeNowItem, HomeNowList, HomeNowModel, HomeNowReason } from '@/lib/home-now';
import {
  layoutHomeNow,
  type HomeNowBlock,
  type HomeNowListKey,
  type HomeNowTotals,
} from '@/lib/home-now-layout';
import { ScrollArea } from '@lody/ui/scroll-area';
import { FocusMotion, canAnimateFocus } from './focus-motion';
import {
  Tile,
  UsageTiles,
  tileStyles,
  toIntlLocale,
  type AgentIconRenderer,
  type UsageProps,
} from './tiles';

const styles = stylex.create({
  /* The board is two stacked columns, or one spanning both (a lone card). */
  columns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    alignItems: 'stretch',
    gap: space[1.5],
    width: '100%',
  },
  columnsSingle: { gridTemplateColumns: 'minmax(0, 1fr)' },
  column: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  /* The usage and the Codex reset side by side, inside one column. */
  usagePair: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: space[1.5],
    minWidth: 0,
  },
  count: {
    flexShrink: 0,
    minWidth: '1.5em',
    paddingInline: space[1.5],
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.trayBackground,
    fontSize: text.captionSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
    color: colors.label,
  },
  /* A list with nothing: its count is quiet, and the tile is its title. */
  countEmpty: { color: colors.secondaryLabel },
  headEmpty: { marginBottom: 0 },
  /*
   * "Show all 12" under a tile's last row: where the eye finishes reading the list, a whole row
   * wide, in a row's box so the tile's rhythm holds. It reads as an action, not a session: a
   * chevron where a row has its mark, and the quiet label colour. (A fading preview of the next
   * session was tried here and read as a row that would open that session.)
   */
  showAll: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: 'calc(100% + 8px)',
    height: '1.9em',
    margin: 0,
    marginInline: '-4px',
    paddingInline: '4px',
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
    outlineStyle: 'none',
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    lineHeight: 1,
    textAlign: 'start',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    cursor: 'pointer',
  },
  /*
   * The way back from a whole list, at its foot: where "Show all" was pressed, the less is. It
   * floats over the frame's bottom edge rather than taking height, so at the tile's size, at
   * either end of the motion, the rows and the "Show all" stand-in have the tile's whole height
   * (it is invisible then). Rows scrolling under it fade out into an opaque strip in the frame's
   * own colour instead of showing through the control; the rows keep room for the strip at their
   * end (`focusRowsFoot`).
   */
  focusFootBar: {
    position: 'absolute',
    insetInline: 0,
    bottom: 0,
    paddingTop: space[2],
    paddingInline: '10px',
    paddingBottom: '10px',
    backgroundImage: `linear-gradient(to bottom, transparent, ${
      colors.secondaryBackground
    } ${space[2]})`,
  },
  focusFoot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    width: '100%',
    height: '1.9em',
    margin: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: colors.trayBackground, ':hover': colors.hoverFill },
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
    outlineStyle: 'none',
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    lineHeight: 1,
    color: colors.secondaryLabel,
    cursor: 'pointer',
  },
  focusFootGlyph: { flexShrink: 0, width: '12px', height: '12px' },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
    margin: 0,
    marginInline: '-4px',
    padding: 0,
    listStyle: 'none',
  },
  /*
   * Each column is a stage of its own, and over it an opened list in the column's box: the tile
   * that was pressed, grown to its whole column while the rest of that column steps back
   * (`focus-motion.ts`). The other column stays, in reach. The list is laid out so that, at the
   * tile's size, it is that tile: the same head and its first rows at the column's width. Its way
   * back sits at its foot. The two column stages stretch to the taller, so either list opens to
   * the board's height.
   */
  columnStage: { position: 'relative', minWidth: 0 },
  columnAway: { pointerEvents: 'none' },
  focus: { position: 'absolute', inset: 0, minHeight: 0, justifyContent: 'flex-start' },
  focusTitle: { flex: '1 1 auto' },
  /* The list scrolls inside the frame with the app's own overlay scrollbar (`ScrollArea`). */
  focusScroll: { flex: '1 1 auto', minHeight: 0 },
  focusRow: { position: 'relative', minWidth: 0 },
  /* The last rows scroll clear of "Show less" floating over the foot. */
  focusRowsFoot: { paddingBottom: `calc(${text.footnoteSize} * 1.9 + ${space[2]})` },
  /*
   * Where the tile's "Show all" is: under its last row, past the rows' 1px gap, in the row's own
   * width. Seen only at the tile's size, at either end of the motion (`focus-motion.ts` fades
   * it); at rest it is not there.
   */
  focusStandIn: {
    position: 'absolute',
    top: 'calc(100% + 1px)',
    left: 0,
    width: '100%',
    marginInline: 0,
    opacity: 0,
    pointerEvents: 'none',
  },
  row: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    height: '1.9em',
    margin: 0,
    paddingInline: '4px',
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
    outlineStyle: 'none',
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    lineHeight: 1,
    textAlign: 'start',
    color: colors.label,
    cursor: 'pointer',
  },
  glyph: { flexShrink: 0, width: '14px', height: '14px' },
  /* A running agent: a still accent dot. Nothing on the page pulses. */
  dot: {
    flexShrink: 0,
    boxSizing: 'border-box',
    width: '14px',
    height: '14px',
    borderWidth: '4px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: '50%',
    backgroundClip: 'content-box',
    backgroundColor: colors.accent,
  },
  waiting: { color: colors.warning },
  failed: { color: colors.destructive },
  good: { color: colors.success },
  quiet: { color: colors.secondaryLabel },
  title: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontSize: text.captionSize,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  body: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
  pressable: { cursor: 'pointer' },
  /* The quiet card's head: the mark and the words on one line. */
  quietHead: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  summary: { display: 'inline-flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  summaryPart: { display: 'inline-flex', alignItems: 'center', gap: '3px' },
  /* Nothing of its kind: the part keeps its place in the line, faded. */
  summaryZero: { opacity: 0.45 },
  /* Nothing at all is happening: one quiet phrase, in the same place the counters were. */
  summaryQuiet: { color: colors.secondaryLabel },
});

const REASON_GLYPH: Record<HomeNowReason, { glyph: LucideIcon | null; tone: stylex.StyleXStyles }> =
  {
    waiting: { glyph: Hand, tone: styles.waiting },
    working: { glyph: null, tone: styles.quiet },
    ciFailed: { glyph: CircleX, tone: styles.failed },
    finished: { glyph: CircleCheck, tone: styles.good },
    draft: { glyph: PencilLine, tone: styles.quiet },
    readyToMerge: { glyph: GitMerge, tone: styles.good },
    openPr: { glyph: GitPullRequest, tone: styles.quiet },
    recent: { glyph: History, tone: styles.quiet },
  };

function ReasonMark({ reason }: { reason: HomeNowReason }) {
  const { glyph: Glyph, tone } = REASON_GLYPH[reason];
  if (!Glyph) return <i aria-hidden="true" {...stylex.props(styles.dot)} />;
  return <Glyph aria-hidden="true" {...stylex.props(styles.glyph, tone)} />;
}

/** "5 min. ago", "yesterday": the last moment the session moved. */
function useAgo(nowMs: number) {
  const { i18n } = useTranslation();
  const format = useMemo(
    () =>
      new Intl.RelativeTimeFormat(toIntlLocale(i18n.language), {
        numeric: 'auto',
        style: 'narrow',
      }),
    [i18n.language]
  );
  return (atMs: number) => {
    const seconds = Math.round((atMs - nowMs) / 1000);
    const minutes = Math.round(seconds / 60);
    const hours = Math.round(minutes / 60);
    const days = Math.round(hours / 24);
    if (Math.abs(seconds) < 60) return format.format(0, 'second');
    if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
    if (Math.abs(hours) < 24) return format.format(hours, 'hour');
    return format.format(days, 'day');
  };
}

const LIST_TITLES: Record<HomeNowListKey, [key: string, fallback: string]> = {
  attention: ['home.now.attention', 'Needs you'],
  running: ['home.now.running', 'Running'],
  finished: ['home.now.finished', 'Just finished'],
  next: ['home.now.next', 'Worth continuing'],
};

/** What a row says at its end: why it is in its list, or how long ago it last moved. */
function useRowMeta(nowMs: number) {
  const { t } = useTranslation();
  const ago = useAgo(nowMs);
  const pr = (item: HomeNowItem) => (item.prNumber != null ? ` · #${item.prNumber}` : '');
  return (item: HomeNowItem): string => {
    switch (item.reason) {
      case 'waiting':
        return t('home.now.waiting', 'Needs your reply');
      case 'ciFailed':
        return t('home.now.ciFailed', 'CI failed{{pr}}', { pr: pr(item) });
      case 'draft':
        return t('home.now.draft', 'Draft{{pr}}', { pr: pr(item) });
      case 'readyToMerge':
        return t('home.now.readyToMerge', 'Ready to merge{{pr}}', { pr: pr(item) });
      case 'openPr':
        return t('home.now.openPr', 'In review{{pr}}', { pr: pr(item) });
      default:
        return ago(item.lastAt);
    }
  };
}

function NowRow({
  item,
  meta,
  onOpenSession,
}: {
  item: HomeNowItem;
  meta: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-session={item.id}
      data-reason={item.reason}
      onClick={() => onOpenSession?.(item.id)}
      {...stylex.props(styles.row)}
    >
      <ReasonMark reason={item.reason} />
      <span {...stylex.props(styles.title)}>
        {item.title ?? t('sessions.untitled', 'Untitled session')}
      </span>
      <span {...stylex.props(styles.meta)}>{meta}</span>
    </button>
  );
}

/**
 * One list: the rows its share of the board allows (`shown`), most pressing first, and the rest
 * one press away. "Show all" under the last row opens the whole list over its column
 * (`NowFocus`), never inside its own tile: a tile that grows in place unbalances the columns and
 * runs into the composer. While the tile hides rows it is itself that same press: a row still
 * opens its session, and with everything shown the tile is left inert. A list with nothing is
 * its title and a quiet zero, so it holds its place on the board.
 */
function NowList({
  listKey,
  list,
  shown,
  nowMs,
  onShowAll,
  onOpenSession,
}: {
  listKey: HomeNowListKey;
  list: HomeNowList;
  shown: number;
  nowMs: number;
  onShowAll: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const meta = useRowMeta(nowMs);
  const [titleKey, titleFallback] = LIST_TITLES[listKey];
  const expandable = list.total > shown;
  const empty = list.total === 0;
  const press = expandable
    ? (event: MouseEvent<HTMLDivElement>) => {
        if ((event.target as Element).closest('[data-session], [data-show-all]')) return;
        onShowAll();
      }
    : undefined;
  return (
    <Tile
      testId={`home-now-${listKey}`}
      onPress={press}
      pressProps={expandable && styles.pressable}
    >
      <div {...stylex.props(tileStyles.head, empty && styles.headEmpty)}>
        <p {...stylex.props(tileStyles.label)}>{t(titleKey, titleFallback)}</p>
        <span {...stylex.props(styles.count, empty && styles.countEmpty)}>{list.total}</span>
      </div>
      {empty ? null : (
        <div {...stylex.props(styles.body)}>
          <ul {...stylex.props(styles.rows)}>
            {list.items.slice(0, shown).map((item) => (
              <li key={item.id}>
                <NowRow item={item} meta={meta(item)} onOpenSession={onOpenSession} />
              </li>
            ))}
          </ul>
          {expandable ? (
            <button
              type="button"
              data-testid={`home-now-${listKey}-toggle`}
              data-show-all={listKey}
              aria-expanded={false}
              onClick={onShowAll}
              {...stylex.props(styles.showAll)}
            >
              <ChevronDown aria-hidden="true" {...stylex.props(styles.glyph)} />
              {t('home.now.showAll', 'Show all {{count}}', { count: list.total })}
            </button>
          ) : null}
        </div>
      )}
    </Tile>
  );
}

/**
 * A whole list over its column, opened from its tile's "Show all" or the tile's own press: the
 * pressed tile grown to its column's box (`focus-motion.ts`), its rows down the column at the
 * tile's width, scrolling inside; the other column stays as it was. "Show less" at its foot,
 * where "Show all" was pressed, Escape, or opening a session returns to the board, and focus
 * returns to the "Show all" that opened it.
 */
function NowFocus({
  listKey,
  list,
  shown,
  nowMs,
  frameRef,
  rowsRef,
  onBack,
  onOpenSession,
}: {
  listKey: HomeNowListKey;
  list: HomeNowList;
  /** The rows its tile showed; the rest arrive late. */
  shown: number;
  nowMs: number;
  frameRef: RefObject<HTMLDivElement | null>;
  rowsRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const meta = useRowMeta(nowMs);
  const backRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [titleKey, titleFallback] = LIST_TITLES[listKey];
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={frameRef}
      role="region"
      aria-labelledby={titleId}
      data-testid={`home-now-${listKey}-all`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onBack();
      }}
      {...stylex.props(tileStyles.tile, styles.focus)}
    >
      <div {...stylex.props(tileStyles.head)}>
        <p id={titleId} {...stylex.props(tileStyles.label, styles.focusTitle)}>
          {t(titleKey, titleFallback)}
        </p>
        <span {...stylex.props(styles.count)}>{list.total}</span>
      </div>
      <ScrollArea
        {...stylex.props(styles.focusScroll)}
        viewportRef={rowsRef}
        viewportClassName="overscroll-contain"
        // Hidden while the frame moves (`focus-motion.ts` marks it), so no bar slides with it.
        scrollbarClassName="[[data-focus-moving]_&]:hidden"
      >
        <ul {...stylex.props(styles.rows, styles.focusRowsFoot)}>
          {list.items.map((item, index) => (
            <li
              key={item.id}
              data-focus-late={index >= shown ? '' : undefined}
              {...stylex.props(styles.focusRow)}
            >
              <NowRow item={item} meta={meta(item)} onOpenSession={onOpenSession} />
              {index === shown - 1 && list.total > shown ? (
                <span
                  aria-hidden="true"
                  data-focus-early=""
                  {...stylex.props(styles.showAll, styles.focusStandIn)}
                >
                  <ChevronDown aria-hidden="true" {...stylex.props(styles.glyph)} />
                  {t('home.now.showAll', 'Show all {{count}}', { count: list.total })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div data-focus-late="" {...stylex.props(styles.focusFootBar)}>
        <button
          ref={backRef}
          type="button"
          data-testid="home-now-back"
          aria-expanded={true}
          onClick={onBack}
          {...stylex.props(styles.focusFoot)}
        >
          <ChevronUp aria-hidden="true" {...stylex.props(styles.focusFootGlyph)} />
          {t('home.now.showLess', 'Show less')}
        </button>
      </div>
    </div>
  );
}

/** How many sessions each list holds, as `layoutHomeNow` counts them. */
export function homeNowTotals(model: HomeNowModel): HomeNowTotals {
  return {
    attention: model.attention.total,
    running: model.running.total,
    finished: model.finished.total,
    next: model.next.total,
  };
}

/**
 * What the person's agents are doing right now: what needs the person, what is running, what
 * just finished, and what is worth picking back up, beside the plan usage, since running out is
 * something to act on too. Every list keeps its fixed place, and how much each shows is
 * `layoutHomeNow`'s call: a row budget spent by priority, within the rows the window has room
 * for, in two columns with level bottoms. A row opens its session; "Show all" (or the tile
 * itself, while it hides rows) opens its whole list over its column. A pure picture of its props.
 */
export function NowBoard({
  model,
  agentIcon,
  nowMs,
  maxRows,
  onOpenSession,
  ...usage
}: UsageProps & {
  model: HomeNowModel;
  agentIcon?: AgentIconRenderer;
  /** The moment ages and resets are counted from. */
  nowMs: number;
  /** The rows one column has room for (`layoutHomeNow`); unlimited when absent. */
  maxRows?: number;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  // The list opened over the board (and how many rows its tile showed), kept while it closes.
  const [focus, setFocus] = useState<{ key: HomeNowListKey; shown: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const motion = useRef<{ key: HomeNowListKey; motion: FocusMotion; tile: HTMLElement }>(null);
  // The "Show all" to hand focus back to once the list is gone.
  const [returnTo, setReturnTo] = useState<HomeNowListKey | null>(null);
  useEffect(() => {
    if (focus || !returnTo) return;
    stageRef.current
      ?.querySelector<HTMLElement>(`[data-show-all="${returnTo}"]`)
      ?.focus({ preventScroll: true });
    setReturnTo(null);
  }, [focus, returnTo]);
  useEffect(() => () => motion.current?.motion.cancel(), []);

  // Gone: the list leaves the DOM and the tile shows in the same frame, and only then does the
  // motion let go (cancelled first, the unclipped frame and the board's resting state would
  // paint for a frame before React removed it).
  const settle = (key: HomeNowListKey) => {
    const current = motion.current;
    motion.current = null;
    flushSync(() => {
      setClosing(false);
      setFocus(null);
      setReturnTo(key);
    });
    if (current) {
      current.tile.style.visibility = '';
      current.motion.cancel();
    }
  };

  const open = (key: HomeNowListKey, shown: number) => {
    const current = motion.current;
    if (current && current.key === key && current.motion.closingNow) {
      // Turned around on the way back: it opens again from where it is.
      current.motion.reopen();
      setClosing(false);
      return;
    }
    if (current) settle(current.key);
    setFocus({ key, shown });
    setClosing(false);
  };

  // Once the opened list is in the DOM, grow it out of the pressed tile.
  useLayoutEffect(() => {
    if (!focus || motion.current?.key === focus.key) return;
    const frame = frameRef.current;
    // The opened list's column: its stage, and the tiles in it that step back.
    const stage = frame?.parentElement ?? null;
    const board = boardRef.current;
    const rows = rowsRef.current;
    const tile = stage?.querySelector<HTMLElement>(`[data-testid="home-now-${focus.key}"]`);
    if (!stage || !board || !frame || !rows || !tile || !canAnimateFocus(frame)) return;
    tile.style.visibility = 'hidden';
    motion.current = {
      key: focus.key,
      tile,
      motion: new FocusMotion({
        stage,
        tile,
        frame,
        rows,
        board,
        late: Array.from(frame.querySelectorAll<HTMLElement>('[data-focus-late]')),
        early: Array.from(frame.querySelectorAll<HTMLElement>('[data-focus-early]')),
      }),
    };
  }, [focus]);

  const back = () => {
    if (!focus || closing) return;
    const key = focus.key;
    const current = motion.current;
    if (!current) {
      settle(key);
      return;
    }
    setClosing(true);
    void current.motion.close().then((home) => {
      if (home && motion.current === current) settle(key);
    });
  };

  const layout = layoutHomeNow(homeNowTotals(model), usage.usage != null, maxRows);
  const block = (item: HomeNowBlock) => {
    switch (item.kind) {
      case 'usage':
        return (
          <div key="usage" {...stylex.props(styles.usagePair)}>
            <UsageTiles
              {...usage}
              agentIcon={agentIcon}
              nowMs={nowMs}
              areas={{
                usage: { column: '1', row: '1' },
                side: { column: '2', row: '1' },
                wide: { column: '1 / span 2', row: '1' },
              }}
            />
          </div>
        );
      case 'quiet':
        return (
          <Tile key="quiet" testId="home-now-quiet">
            <div {...stylex.props(styles.quietHead)}>
              <CircleCheck aria-hidden="true" {...stylex.props(styles.glyph, styles.good)} />
              <p {...stylex.props(tileStyles.value)}>{t('home.now.quiet', 'All quiet')}</p>
            </div>
            <p {...stylex.props(tileStyles.note)}>
              {t('home.now.quietNote', 'Nothing is running or waiting on you.')}
            </p>
          </Tile>
        );
      case 'list':
        return (
          <NowList
            key={item.key}
            listKey={item.key}
            list={model[item.key]}
            shown={item.shown}
            nowMs={nowMs}
            onShowAll={() => open(item.key, item.shown)}
            onOpenSession={onOpenSession}
          />
        );
    }
    return null;
  };
  const opened = focus != null && model[focus.key].total > 0 ? focus : null;
  const away = opened != null && !closing;
  return (
    <div ref={stageRef} data-testid="home-now" data-focus={opened?.key}>
      <div {...stylex.props(styles.columns, layout.columns.length === 1 && styles.columnsSingle)}>
        {layout.columns.map((column, index) => {
          // The column the opened list belongs to: it opens over this column only.
          const holds =
            opened != null &&
            column.some((item) => item.kind === 'list' && item.key === opened.key);
          return (
            <div
              key={index}
              data-now-column={index === 0 ? 'left' : 'right'}
              {...stylex.props(styles.columnStage)}
            >
              <div
                ref={holds ? boardRef : undefined}
                inert={holds && away}
                {...stylex.props(styles.column, holds && away && styles.columnAway)}
              >
                {column.map(block)}
              </div>
              {holds && opened ? (
                <NowFocus
                  listKey={opened.key}
                  list={model[opened.key]}
                  shown={opened.shown}
                  nowMs={nowMs}
                  frameRef={frameRef}
                  rowsRef={rowsRef}
                  onBack={back}
                  onOpenSession={(id) => {
                    settle(opened.key);
                    onOpenSession?.(id);
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What "now" says in the line: how many things need the person, how many agents run, how many
 * finished. All three always keep their places (a zero fades), so the line never changes shape
 * while the counts change.
 *
 * With nothing at all happening, the three zeros are noise: they read as three failures rather
 * than as a quiet page. Then the line says so in one quiet phrase instead, and the shape of the
 * segment changes with the state — a phrase is shorter than three counters, and the line is
 * centred under the heading, so nothing else moves.
 */
export function NowSummary({ model }: { model: HomeNowModel }) {
  const { t } = useTranslation();
  const parts = [
    {
      key: 'attention',
      count: model.attention.total,
      mark: <Hand aria-hidden="true" {...stylex.props(styles.glyph, styles.waiting)} />,
      label: t('home.now.attention', 'Needs you'),
    },
    {
      key: 'running',
      count: model.running.total,
      mark: <i aria-hidden="true" {...stylex.props(styles.dot)} />,
      label: t('home.now.running', 'Running'),
    },
    {
      key: 'finished',
      count: model.finished.total,
      mark: <CircleCheck aria-hidden="true" {...stylex.props(styles.glyph, styles.good)} />,
      label: t('home.now.finished', 'Just finished'),
    },
  ];
  const quiet = parts.every((part) => part.count === 0);
  if (quiet) {
    return (
      <span data-testid="home-now-summary" data-summary="quiet" {...stylex.props(styles.summary)}>
        <span {...stylex.props(styles.summaryPart, styles.summaryQuiet)}>
          {t('home.now.allCaughtUp', 'All caught up')}
        </span>
      </span>
    );
  }
  return (
    <span data-testid="home-now-summary" {...stylex.props(styles.summary)}>
      {parts.map((part) => (
        <span
          key={part.key}
          data-summary={part.key}
          {...stylex.props(styles.summaryPart, part.count === 0 && styles.summaryZero)}
        >
          {part.mark}
          <span {...stylex.props(tileStyles.srOnly)}>{part.label}</span>
          {part.count}
        </span>
      ))}
    </span>
  );
}
