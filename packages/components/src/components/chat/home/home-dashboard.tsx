import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { DEFAULT_HOME_BOARD, type HomeBoard } from '@/lib/home-board';
import type { HomeNowModel } from '@/lib/home-now';
import { layoutHomeNow } from '@/lib/home-now-layout';
import type { HomeWeekAgent, HomeWeekModel } from '@/lib/home-week';
import { useLandingRoom } from '../landing-stage';
import { morph } from './morph';
import { NowBoard, NowSummary, homeNowTotals } from './now-board';
import type { AgentIconRenderer, UsageProps } from './tiles';
import { WeekBento, WeekSummary } from './week-bento';

const styles = stylex.create({
  dashboard: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    width: '100%',
    margin: 0,
    padding: 0,
  },
  /*
   * The line: one segment per board and the control that folds the open one away. Every item is
   * a box of the same height with its content centred, so the labels, the figures and the
   * control share one centre line.
   */
  line: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    minHeight: '28px',
  },
  /* Alone under the centred heading (everything folded), the line centres as one phrase. */
  lineAlone: { justifyContent: 'center', flexWrap: 'wrap' },
  segment: {
    position: 'relative',
    isolation: 'isolate',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    height: '28px',
    margin: 0,
    paddingInline: '10px',
    borderWidth: 0,
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 2px ${colors.accent}` },
    outlineStyle: 'none',
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    lineHeight: 1,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    color: colors.label,
    cursor: 'pointer',
    ':focus-visible': { boxShadow: `none` },
  },
  /* The open board's segment sits on a pill in the tiles' own material: the tab the board hangs
     from. There is one pill, and switching glides it to the other segment. */
  segmentOpen: { backgroundColor: { default: 'transparent', ':hover': 'transparent' } },
  pill: {
    position: 'absolute',
    inset: 0,
    zIndex: -1,
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.secondaryBackground,
  },
  segmentLabel: { color: colors.secondaryLabel },
  segmentLabelOpen: { color: colors.label },
  end: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '28px',
    marginInlineStart: 'auto',
    flexShrink: 0,
    color: colors.secondaryLabel,
  },
  /*
   * Folded, the control steps back until the line is pointed at or focused: pressing a segment
   * already unfolds its board, and a resting chevron read as one more mark in the phrase. Without
   * a hover (touch) it stays.
   */
  endAlone: {
    marginInlineStart: 0,
    transitionProperty: 'opacity',
    transitionDuration: { default: '120ms', '@media (prefers-reduced-motion: reduce)': '0s' },
    '@media (hover: hover)': {
      opacity: {
        default: 0,
        [stylex.when.ancestor(':hover')]: 1,
        ':focus-within': 1,
      },
    },
  },
  /* Folded, a hairline keeps the two summaries two phrases. */
  divider: {
    flexShrink: 0,
    width: '1px',
    height: '12px',
    backgroundColor: colors.separator,
  },
});

/**
 * One row of a "now" list in pixels, for an interface font size: the row is 1.9em of the
 * footnote size (12/14 of the interface size) plus the 1px between rows. A tile's title and its
 * "Show all" line are about two rows and one (`homeNowBlockHeight`).
 */
function nowRowPx(uiFontPx: number): number {
  return (uiFontPx * 12 * 1.9) / 14 + 1;
}

/** The gaps between the tiles of one column, which `homeNowBlockHeight` does not count. */
const NOW_COLUMN_GAPS_PX = 3 * 6;
/**
 * The line and the gap under it: fixed, so the board's room is the same whether or not it is
 * shown (measuring the board itself would hand a folded board the gap and fold it again).
 */
const LINE_AND_GAP_PX = 28 + 6;

/**
 * The new-chat page above the composer: a line with one segment per board, and under it the
 * open board, either what the agents are doing now or the last seven days. Pressing the other
 * segment swaps them; pressing the open one, or the control at the end, folds it into the line,
 * where every segment shows its summary. A pure picture of its props (the open board is
 * controlled when `board` is passed); `HomeDashboardHost` supplies the real ones.
 *
 * On the landing stage the "now" board fits the window: it is given the rows the stage has room
 * for (`useLandingRoom`), and when even one row per list does not fit it shows folded into the
 * line without changing the remembered board. Opening it from the line then shows it anyway, and
 * the stage scrolls: the person asked for it.
 */
export function HomeDashboard({
  board,
  defaultBoard = DEFAULT_HOME_BOARD,
  onBoardChange,
  now,
  week,
  agentLabel,
  agentIcon,
  nowMs,
  onOpenSession,
  animate = true,
  ...usage
}: UsageProps & {
  /** The open board, or `null` with everything folded. Passed, it is the caller's. */
  board?: HomeBoard | null;
  defaultBoard?: HomeBoard | null;
  onBoardChange?: (board: HomeBoard | null) => void;
  now: HomeNowModel;
  week: HomeWeekModel;
  agentLabel: (agent: HomeWeekAgent) => string;
  agentIcon?: AgentIconRenderer;
  /** The moment ages and resets are counted from. */
  nowMs: number;
  onOpenSession?: (sessionId: string) => void;
  /** Roll the week's numbers up on first show. Off for tests and for a still frame. */
  animate?: boolean;
}) {
  const { t } = useTranslation();
  const boardId = useId();
  const [ownBoard, setOwnBoard] = useState<HomeBoard | null>(defaultBoard);
  const open = board === undefined ? ownBoard : board;
  // What the control at the end unfolds: the board that was open last.
  const [lastOpen, setLastOpen] = useState<HomeBoard>(open ?? DEFAULT_HOME_BOARD);

  const sectionRef = useRef<HTMLElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const dashboardRoom = useLandingRoom(sectionRef);
  const room = dashboardRoom == null ? null : Math.max(0, dashboardRoom - LINE_AND_GAP_PX);
  const [uiFontPx, setUiFontPx] = useState(14);
  // Rows taken back after the board was measured taller than its room (the row arithmetic is
  // close, not exact), for the room they were measured in.
  const [slack, setSlack] = useState({ room, rows: 0 });
  const slackRows = slack.room === room ? slack.rows : 0;
  const maxRows =
    room == null
      ? undefined
      : Math.floor((room - NOW_COLUMN_GAPS_PX) / nowRowPx(uiFontPx)) - slackRows;
  const nowFits = layoutHomeNow(homeNowTotals(now), usage.usage != null, maxRows).fits;
  // Opened from the line although it does not fit: shown anyway until it fits again.
  const [forced, setForced] = useState(false);
  if (forced && nowFits) setForced(false);
  const shown = open === 'now' && !nowFits && !forced ? null : open;

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section || room == null) return;
    const size = Number.parseFloat(getComputedStyle(section).getPropertyValue('--ui-font-size'));
    if (Number.isFinite(size) && size > 0) setUiFontPx(size);
    const height = boardRef.current?.offsetHeight ?? 0;
    if (shown === 'now' && nowFits && height > room) {
      setSlack({ room, rows: slackRows + 1 });
    }
  }, [room, shown, nowFits, slackRows, maxRows]);

  // What the line showed when the last render committed, one commit behind
  // `shown`. The pill keeps its own transition name only while it continues
  // across one: a board switch has it on both sides, so its snapshot glides
  // between the segments. Unfolding or folding it is new or gone, so an own
  // name lands it settled in place; leaving it unnamed it rides its segment's
  // snapshot, which already moves with the board.
  const lastShown = useRef<HomeBoard | null>(null);
  useLayoutEffect(() => {
    lastShown.current = shown;
  });
  const pillTravels = shown != null && lastShown.current != null;

  const show = (next: HomeBoard | null) => {
    if (next == null) {
      // Folding: take the pill's own name off before the transition captures
      // the open state, so it isn't a snapshot of its own fading away where the
      // open board was; it leaves as part of its segment, which travels home.
      const pill = sectionRef.current?.querySelector<HTMLElement>('[data-home-pill]');
      if (pill) pill.style.viewTransitionName = 'none';
    }
    morph(() => {
      if (next) setLastOpen(next);
      setForced(next === 'now' && !nowFits);
      if (board === undefined) setOwnBoard(next);
      onBoardChange?.(next);
    });
  };

  // Escape folds the open board from wherever the landing's focus then sits:
  // the board is a transient surface raised by one press, so one press takes
  // it back. Text fields keep their own Escape, an open dialog or menu stops
  // it before the window sees it, and the "now" board's drill-down has
  // already taken it (prevented) to fold back one level, not away.
  const showRef = useRef(show);
  useLayoutEffect(() => {
    showRef.current = show;
  });
  useEffect(() => {
    if (shown == null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'
        )
      ) {
        return;
      }
      const section = sectionRef.current;
      // The line keeps its own focus; a held focus ring would only repaint.
      // When the fold removes the focused element with the board (a "now"
      // row), rescue it onto the fold control, which does outlive the board.
      const focusLost = boardRef.current?.contains(document.activeElement) === true;
      event.preventDefault();
      showRef.current(null);
      if (focusLost) {
        section
          ?.querySelector<HTMLButtonElement>('[data-testid="home-dashboard-fold"]')
          ?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shown]);

  const segments: { id: HomeBoard; label: string; summary: ReactNode }[] = [
    { id: 'now', label: t('home.board.now', 'Now'), summary: <NowSummary model={now} /> },
    {
      id: 'week',
      label: t('home.board.week', 'Last 7 days'),
      summary: <WeekSummary model={week} />,
    },
  ];
  const endAction = shown
    ? t('home.board.fold', 'Fold into one line')
    : t('home.board.unfold', 'Unfold');

  return (
    <section
      ref={sectionRef}
      aria-label={t('home.board.title', 'Your agents at a glance')}
      data-testid="home-dashboard"
      data-auto-folded={(open != null && shown == null) || undefined}
      {...stylex.props(styles.dashboard)}
    >
      <div
        data-testid="home-dashboard-line"
        data-alone={shown == null || undefined}
        {...stylex.props(styles.line, shown == null && [stylex.defaultMarker(), styles.lineAlone])}
      >
        {segments.map((segment, index) => {
          const isOpen = shown === segment.id;
          return (
            <Fragment key={segment.id}>
              {shown == null && index > 0 ? (
                <i aria-hidden="true" {...stylex.props(styles.divider)} />
              ) : null}
              <button
                type="button"
                data-segment={segment.id}
                aria-expanded={isOpen}
                aria-controls={isOpen ? boardId : undefined}
                onClick={() => show(isOpen ? null : segment.id)}
                style={{ viewTransitionName: `home-${segment.id}-segment` }}
                {...stylex.props(styles.segment, isOpen && styles.segmentOpen)}
              >
                {isOpen ? (
                  <span
                    aria-hidden="true"
                    data-home-pill=""
                    {...stylex.props(styles.pill)}
                    style={{ viewTransitionName: pillTravels ? 'home-pill' : undefined }}
                  />
                ) : null}
                <span
                  style={{ viewTransitionName: `home-${segment.id}-label` }}
                  {...stylex.props(styles.segmentLabel, isOpen && styles.segmentLabelOpen)}
                >
                  {segment.label}
                </span>
                {/* A folded board lives on as its summary. */}
                {isOpen ? null : segment.summary}
              </button>
            </Fragment>
          );
        })}
        <span
          style={{ viewTransitionName: 'home-fold' }}
          {...stylex.props(styles.end, shown == null && styles.endAlone)}
        >
          <Tooltip.Root>
            <Tooltip.Trigger
              data-testid="home-dashboard-fold"
              aria-label={endAction}
              aria-expanded={shown != null}
              aria-controls={shown ? boardId : undefined}
              onClick={() => show(shown ? null : lastOpen)}
              render={<Button variant="ghost" size="mini" icon />}
            >
              {shown ? (
                <ChevronsDownUp aria-hidden="true" />
              ) : (
                <ChevronsUpDown aria-hidden="true" />
              )}
            </Tooltip.Trigger>
            <Tooltip.Content side="top">{endAction}</Tooltip.Content>
          </Tooltip.Root>
        </span>
      </div>

      {shown ? (
        <div id={boardId} ref={boardRef} style={{ viewTransitionName: 'home-board' }}>
          {shown === 'now' ? (
            <NowBoard
              model={now}
              agentIcon={agentIcon}
              nowMs={nowMs}
              maxRows={forced ? undefined : maxRows}
              onOpenSession={onOpenSession}
              {...usage}
            />
          ) : (
            <WeekBento
              model={week}
              agentLabel={agentLabel}
              agentIcon={agentIcon}
              animate={animate}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}
