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
import { LANDING_STAGE_BREATHING_PX, useLandingRoom } from '../landing-stage';
import { morph, type MorphKind } from './morph';
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
   * control share one centre line. It is one phrase centred under the heading, open or folded,
   * and nothing in it changes width with the state: both segments always carry their summaries
   * and the control always follows them, so every press lands where the last one did.
   */
  line: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    minHeight: '28px',
  },
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
    flexShrink: 0,
    color: colors.secondaryLabel,
  },
  /* A hairline keeps the two summaries two phrases; beside the pill it is not needed, but it
     keeps its width so nothing after it moves. */
  divider: {
    flexShrink: 0,
    width: '1px',
    height: '12px',
    backgroundColor: colors.separator,
  },
  dividerHidden: { opacity: 0 },
});

/**
 * One row of a "now" list in pixels, for an interface font size: the row is 1.9em of the
 * footnote size (12/14 of the interface size) plus the 1px between rows. A tile's title is
 * about two rows (`homeNowBlockHeight`).
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
 * Keep up to two rows of air below a busy board when the stage has only just enough room for
 * more content. Twelve rows still hold the usage tile and one row from every non-empty list, so
 * the reserve never makes an otherwise viable board fold. Once the stage can hold the board's
 * natural maximum, this has no effect.
 */
const NOW_COMPACT_ROW_RESERVE = 2;
const NOW_COMPACT_MIN_ROWS = 12;

function compactNowRows(rows: number): number {
  if (rows <= NOW_COMPACT_MIN_ROWS) return rows;
  return Math.max(NOW_COMPACT_MIN_ROWS, rows - NOW_COMPACT_ROW_RESERVE);
}

/** The line itself: what the dashboard is, folded. */
const LINE_PX = 28;

/**
 * At most the share of an open board that hangs below what the stage centres. The rest lifts the
 * group: opening raises the heading and the line by half of it, so the heading does not jump by
 * half the board's height. None of it hanging read as far too much travel.
 */
export const HOME_BOARD_HANG_SHARE = 0.7;

/**
 * How much more space an open board may leave above the heading than under itself. Hanging the
 * whole share in a window of middling height sank the board onto the composer with every spare
 * pixel above the heading, and the page read as out of balance; so the board sits a little low,
 * never more than this. 1.5 held the board up so far that, with the folded page lifted
 * (`HOME_FOLDED_LIFT`), opening still carried the heading well above it.
 */
export const HOME_BOARD_MAX_TILT = 2.5;

/**
 * How much of an open board (`below`: the gap and the board's slot) hangs below what the stage
 * centres, in pixels. `free` is the dashboard's room on the stage (`useLandingRoom`): the stage
 * less the rest of the group and the breathing space. Centred whole, the open group would leave
 * `spare` above and below it together; hanging `hang` moves half of it from below to above. So
 * the hang is at most its share of the board, at most what keeps the space above within
 * `HOME_BOARD_MAX_TILT` of the space below, at most what keeps the breathing space under it, and
 * at most what leaves the heading where the folded page has it: opening never moves it down.
 */
function hangPx(free: number | null, below: number): number {
  if (free == null || below <= 0) return 0;
  // The stage's free space with the dashboard folded: the stage less the rest and the line.
  const span = free + LANDING_STAGE_BREATHING_PX - LINE_PX;
  const spare = span - below;
  const tilt = (spare * (HOME_BOARD_MAX_TILT - 1)) / (HOME_BOARD_MAX_TILT + 1);
  const fits = spare - LANDING_STAGE_BREATHING_PX;
  // The folded page keeps `foldedReservePx` under its line; hanging more than the board less
  // that would put the open heading below the folded one.
  const still = below - foldedReservePx(free);
  return Math.max(0, Math.floor(Math.min(below * HOME_BOARD_HANG_SHARE, tilt, fits, still)));
}

/**
 * How far the folded heading and line sit above the stage's middle, as a share of the stage's
 * free space: centred exactly, the folded page read a touch low.
 */
export const HOME_FOLDED_LIFT = 0.03;

/**
 * The space kept, unseen, under the folded line so the stage centres it `HOME_FOLDED_LIFT` higher
 * (twice the lift, since the stage splits it above and below). `free` is the dashboard's room on
 * the stage (`useLandingRoom`).
 */
function foldedReservePx(free: number | null): number {
  if (free == null) return 0;
  const span = free + LANDING_STAGE_BREATHING_PX - LINE_PX;
  return Math.max(0, Math.floor(2 * HOME_FOLDED_LIFT * span));
}

/**
 * The new-chat page above the composer: a line with one segment per board, and under it the
 * open board, either what the agents are doing now or the last seven days. Pressing the other
 * segment swaps them; pressing the open one, or the control at the end, folds it into the line,
 * where every segment shows its summary. A pure picture of its props (the open board is
 * controlled when `board` is passed); `HomeDashboardHost` supplies the real ones.
 *
 * On the landing stage an open board has a slot under the line, and the slot is the board's own
 * measured height: an expanded board is exactly as tall as what it shows. The slot used to
 * reserve the tallest board the lists could make, which left a band of nothing between the tiles
 * and the composer and pushed the heading up by it; the rows are still capped by the room the
 * stage has (`useLandingRoom`), so the board never grows past what the window can hold. The
 * board hangs from the line and only its own height changes.
 *
 * Folding and unfolding move the group less than centring would: part of an open board is not
 * part of what the stage centres, but hangs below the line toward the composer (its height taken
 * back with a negative bottom margin, `hangPx`), and the rest lifts the heading and the line.
 * The hang is at most a share of the board (`HOME_BOARD_HANG_SHARE`) and at most what keeps the
 * page in balance (`HOME_BOARD_MAX_TILT`), so the board sits a little low, never sunk onto the
 * composer. Centring the whole open board moved the heading by half the board's height at every
 * fold, far too much travel; hanging all of it, or 70% of it with no balance limit, sat the
 * board too low; keeping the slot while folded left a band of nothing under a one-line page.
 * Folded, the heading and the line sit a little above the stage's middle (`HOME_FOLDED_LIFT`),
 * which also leaves opening less to travel.
 *
 * The "now" board is given the rows the room holds, and when even one row per list does not fit
 * it shows folded into the line without changing the remembered board. Opening it from the line
 * then shows it anyway, and the stage scrolls: the person asked for it.
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
  const lineRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const dashboardRoom = useLandingRoom(sectionRef);
  const room = dashboardRoom == null ? null : Math.max(0, dashboardRoom - LINE_AND_GAP_PX);
  const [uiFontPx, setUiFontPx] = useState(14);
  // The rows a column may show: what the window's room allows. The board's own height is
  // measured, so the room (not a reserved tallest board) is what caps the rows.
  const rowsRoom =
    room == null ? null : Math.floor((room - NOW_COLUMN_GAPS_PX) / nowRowPx(uiFontPx));
  // The board's height, measured: the slot holds the board's own box, so an open board is
  // exactly as tall as what it shows. Reserving the tallest board the lists could make left
  // the rest of the space empty under the tiles — a band of nothing between the board and the
  // composer, and the heading pushed up by it.
  const [boardHeight, setBoardHeight] = useState<number | null>(null);
  const slot = boardHeight;
  // Rows taken back after the board was measured taller than its room (the row arithmetic is
  // close, not exact), for the room they were measured in.
  const [slack, setSlack] = useState({ room, rows: 0 });
  const slackRows = slack.room === room ? slack.rows : 0;
  // A short stage should not turn every spare pixel into another session row. Keep a small
  // reserve below the board once the minimum busy layout fits; taller stages still reach the
  // same natural row budget because the board itself tops out before the available room does.
  const preferredRows = rowsRoom == null ? null : compactNowRows(rowsRoom);
  const maxRows = preferredRows == null ? undefined : Math.max(0, preferredRows - slackRows);
  const nowFits = layoutHomeNow(homeNowTotals(now), usage.usage != null, maxRows).fits;
  // Opened from the line although it does not fit: shown anyway until it fits again.
  const [forced, setForced] = useState(false);
  if (forced && nowFits) setForced(false);
  const shown = open === 'now' && !nowFits && !forced ? null : open;
  // The open board's gap and slot, hung below what the stage centres where there is room.
  const below = shown && slot != null ? LINE_AND_GAP_PX - LINE_PX + slot : 0;
  const hang = hangPx(dashboardRoom, below);
  // Open, part of the board hangs out of what the stage centres; folded, space is kept under the
  // line so the page sits a little high. Both are the section's bottom margin.
  const margin = shown ? -hang : foldedReservePx(dashboardRoom);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const size = Number.parseFloat(getComputedStyle(section).getPropertyValue('--ui-font-size'));
    if (Number.isFinite(size) && size > 0) setUiFontPx(size);
    const height = boardRef.current?.offsetHeight ?? 0;
    if (height > 0 && height !== boardHeight) setBoardHeight(height);
    if (shown === 'now' && nowFits && room != null && height > room) {
      setSlack({ room, rows: slackRows + 1 });
    }
  }, [room, shown, nowFits, slackRows, maxRows, boardHeight]);

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
    const order: HomeBoard[] = ['now', 'week'];
    const kind: MorphKind =
      next == null
        ? 'fold'
        : shown == null
          ? 'unfold'
          : order.indexOf(next) > order.indexOf(shown)
            ? 'next'
            : 'previous';
    morph(
      kind,
      () => {
        if (next) setLastOpen(next);
        setForced(next === 'now' && !nowFits);
        if (board === undefined) setOwnBoard(next);
        onBoardChange?.(next);
      },
      lineRef.current
    );
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
      style={margin !== 0 ? { marginBottom: margin } : undefined}
    >
      <div ref={lineRef} data-testid="home-dashboard-line" {...stylex.props(styles.line)}>
        {segments.map((segment, index) => {
          const isOpen = shown === segment.id;
          return (
            <Fragment key={segment.id}>
              {index > 0 ? (
                <i
                  aria-hidden="true"
                  {...stylex.props(styles.divider, shown != null && styles.dividerHidden)}
                />
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
                {/* Open or folded, the summary stays, so the segments never change width. */}
                {segment.summary}
              </button>
            </Fragment>
          );
        })}
        <span
          data-testid="home-dashboard-fold-slot"
          style={{ viewTransitionName: 'home-fold' }}
          {...stylex.props(styles.end)}
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

      {/* The slot keeps one height for either board, so switching never re-centres the stage. */}
      {shown ? (
        <div
          data-testid="home-dashboard-slot"
          style={slot == null ? undefined : { minHeight: slot }}
        >
          <div
            id={boardId}
            ref={boardRef}
            data-testid="home-dashboard-board"
            style={{ viewTransitionName: 'home-board' }}
          >
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
        </div>
      ) : null}
    </section>
  );
}
