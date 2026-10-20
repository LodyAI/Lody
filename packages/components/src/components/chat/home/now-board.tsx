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
  History,
  PencilLine,
  Minimize2,
  type LucideIcon,
} from 'lucide-react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
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
  /* The board is two stacked columns (`layoutHomeNow`), or one spanning both. */
  columns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    alignItems: 'start',
    gap: space[1.5],
    width: '100%',
  },
  single: { gridTemplateColumns: 'minmax(0, 1fr)' },
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
   * The board, and over it an opened list in the board's own box: the tile that was pressed,
   * grown to the whole board while the rest steps back (`focus-motion.ts`). The list is laid
   * out so that, at the tile's size, it is that tile: the same head (the way back sits before
   * the count, so the count keeps the tile's corner), its first rows in the first column at the
   * tile's width, and a stand-in for its "Show all" under them.
   */
  stage: { position: 'relative', minWidth: 0 },
  boardAway: { pointerEvents: 'none' },
  focus: { position: 'absolute', inset: 0, minHeight: 0, justifyContent: 'flex-start' },
  focusTitle: { flex: '1 1 auto' },
  /* The mini button is taller than the head's line; it overhangs instead of pushing rows down. */
  focusBack: {
    display: 'inline-flex',
    alignSelf: 'center',
    marginBlock: '-4px',
    marginInlineEnd: '-4px',
  },
  focusScroll: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
  /* Rows down, then across. 18px is two tiles' padding and the board's 6px column gap, less the
     4px the rows overhang on each side, so the first column is exactly a half-board tile's rows
     and the second lands where the right-hand tiles' rows were. */
  focusRows: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    columnGap: '18px',
    rowGap: '1px',
  },
  focusRowsWhole: { gridTemplateColumns: 'minmax(0, 1fr)' },
  focusRow: { position: 'relative', minWidth: 0 },
  /* Where the tile's "Show all" was: under its last row, past the body's 4px gap. Seen only at
     the tile's size, at either end of the motion. */
  focusStandIn: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    marginBlock: 0,
    marginInline: 0,
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
  /* "Show all 12": a quiet text control under the rows, the tile's own way to the rest.
     The tile that hides rows is itself one press to the same place; the pointer says so,
     and nothing more changes on hover (the rows' own hover already answers a point). */
  toggle: {
    alignSelf: 'flex-start',
    margin: 0,
    marginInline: '-4px',
    paddingBlock: '2px',
    paddingInline: '4px',
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
    outlineStyle: 'none',
    fontFamily: 'inherit',
    fontSize: text.captionSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    cursor: 'pointer',
  },
  body: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  pressable: { cursor: 'pointer' },
  quietHead: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  summary: { display: 'inline-flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  summaryPart: { display: 'inline-flex', alignItems: 'center', gap: '3px' },
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
 * one press away. "Show all" opens the whole list over the board (`NowFocus`), never inside its
 * own tile: a tile that grows in place unbalances the columns and runs into the composer.
 * While the tile hides rows it is itself that same press: a row still opens its session, and
 * with everything shown the tile is left inert.
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
      <div {...stylex.props(tileStyles.head)}>
        <p {...stylex.props(tileStyles.label)}>{t(titleKey, titleFallback)}</p>
        <span {...stylex.props(styles.count)}>{list.total}</span>
      </div>
      <div {...stylex.props(styles.body)}>
        <ul {...stylex.props(styles.rows)}>
          {list.items.slice(0, shown).map((item) => (
            <li key={item.id}>
              <NowRow item={item} meta={meta(item)} onOpenSession={onOpenSession} />
            </li>
          ))}
        </ul>
        {list.total > shown ? (
          <button
            type="button"
            data-testid={`home-now-${listKey}-toggle`}
            data-show-all={listKey}
            onClick={onShowAll}
            {...stylex.props(styles.toggle)}
          >
            {t('home.now.showAll', 'Show all {{count}}', { count: list.total })}
          </button>
        ) : null}
      </div>
    </Tile>
  );
}

/**
 * A whole list over the board, opened from its tile's "Show all" or the tile's own press: the
 * pressed tile grown to the board's
 * box (`focus-motion.ts`), its rows down the board's two columns (or one, for a tile that spanned
 * the board), scrolling inside. The way back, Escape, or opening a session returns to the board,
 * and focus returns to the "Show all" that opened it.
 */
function NowFocus({
  listKey,
  list,
  shown,
  whole,
  nowMs,
  frameRef,
  rowsRef,
  onBack,
  onOpenSession,
}: {
  listKey: HomeNowListKey;
  list: HomeNowList;
  /** The rows its tile showed; the rest, and the way back, arrive late. */
  shown: number;
  /** The tile spanned the whole board: one column. */
  whole: boolean;
  nowMs: number;
  frameRef: RefObject<HTMLDivElement | null>;
  rowsRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const meta = useRowMeta(nowMs);
  const backRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const [titleKey, titleFallback] = LIST_TITLES[listKey];
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);
  // The first column holds at least the tile's rows, so they stay where the tile had them.
  const perColumn = whole ? list.items.length : Math.max(shown, Math.ceil(list.items.length / 2));
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
        <span data-focus-late="" {...stylex.props(styles.focusBack)}>
          <Button
            ref={backRef}
            variant="ghost"
            size="mini"
            icon
            data-testid="home-now-back"
            aria-label={t('home.now.back', 'Back to the board')}
            onClick={onBack}
          >
            <Minimize2 aria-hidden="true" />
          </Button>
        </span>
        <span {...stylex.props(styles.count)}>{list.total}</span>
      </div>
      <div ref={rowsRef} {...stylex.props(styles.focusScroll)}>
        <ul
          style={{ gridTemplateRows: `repeat(${Math.max(perColumn, 1)}, auto)` }}
          {...stylex.props(styles.rows, styles.focusRows, whole && styles.focusRowsWhole)}
        >
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
                  {...stylex.props(styles.toggle, styles.focusStandIn)}
                >
                  {t('home.now.showAll', 'Show all {{count}}', { count: list.total })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
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
 * something to act on too. How much each list shows and which column it stands in is
 * `layoutHomeNow`'s call: a row budget spent by priority, within the rows the window has room
 * for, in two columns with level bottoms. Lists with nothing are left out; with nothing at all
 * going on it is one calm tile. A row opens its session; "Show all" — or the tile itself, while
 * it hides rows — opens its whole list over the board in the board's own frame. A pure picture
 * of its props.
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
  const [focus, setFocus] = useState<{
    key: HomeNowListKey;
    shown: number;
    whole: boolean;
  } | null>(null);
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

  const open = (key: HomeNowListKey, shown: number, whole: boolean) => {
    const current = motion.current;
    if (current && current.key === key && current.motion.closingNow) {
      // Turned around on the way back: it opens again from where it is.
      current.motion.reopen();
      setClosing(false);
      return;
    }
    if (current) settle(current.key);
    setFocus({ key, shown, whole });
    setClosing(false);
  };

  // Once the opened list is in the DOM, grow it out of the pressed tile.
  useLayoutEffect(() => {
    if (!focus || motion.current?.key === focus.key) return;
    const stage = stageRef.current;
    const board = boardRef.current;
    const frame = frameRef.current;
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
            onShowAll={() => open(item.key, item.shown, layout.columns.length === 1)}
            onOpenSession={onOpenSession}
          />
        );
    }
    return null;
  };
  const opened = focus != null && model[focus.key].total > 0 ? focus : null;
  return (
    <div
      ref={stageRef}
      data-testid="home-now"
      data-focus={opened?.key}
      {...stylex.props(styles.stage)}
    >
      <div
        ref={boardRef}
        inert={opened != null && !closing}
        {...stylex.props(
          styles.columns,
          layout.columns.length === 1 && styles.single,
          opened != null && !closing && styles.boardAway
        )}
      >
        {layout.columns.map((column, index) => (
          <div
            key={index}
            data-now-column={layout.columns.length === 1 ? 'whole' : index === 0 ? 'left' : 'right'}
            {...stylex.props(styles.column)}
          >
            {column.map(block)}
          </div>
        ))}
      </div>
      {opened ? (
        <NowFocus
          listKey={opened.key}
          list={model[opened.key]}
          shown={opened.shown}
          whole={opened.whole}
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
}

/**
 * What "now" says while its board is folded into the line: how many things need the person, how
 * many agents run, how many finished; or that all is quiet.
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
  ].filter((part) => part.count > 0);
  return (
    <span data-testid="home-now-summary" {...stylex.props(styles.summary)}>
      {parts.length === 0
        ? t('home.now.quiet', 'All quiet')
        : parts.map((part) => (
            <span key={part.key} data-summary={part.key} {...stylex.props(styles.summaryPart)}>
              {part.mark}
              <span {...stylex.props(tileStyles.srOnly)}>{part.label}</span>
              {part.count}
            </span>
          ))}
    </span>
  );
}
