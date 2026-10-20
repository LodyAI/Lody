import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Flame } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  HOME_WEEK_WALL_ROWS,
  type HomeWeekAgent,
  type HomeWeekModel,
  type HomeWeekWallLevel,
} from '@/lib/home-week';
import { Count, Tile, gridRows, tileStyles, toIntlLocale, type AgentIconRenderer } from './tiles';

// Local, not imported: StyleX evaluates `stylex.create` at compile time and can only follow
// imports into `.stylex.ts` files.
const MOTION = '@media (prefers-reduced-motion: no-preference)';

/* The wall's cell, in `em` of the tile's text, and the gap between cells. The weeks shown are as
   many as fit the width; the leftover is under one cell and is shared out by the columns. */
const WALL_CELL_EM = 0.7;
const WALL_GAP_PX = 3;
const WALL_MIN_WEEKS = 8;
/** Before the width is known (first paint, tests without layout). */
const WALL_FALLBACK_WEEKS = 14;

/*
 * The wall's shades, solid on the tile: a quiet day is a neutral step toward ink, and only activity
 * is blue, so "blue means something happened" holds. The lightest blue sits well clear of the
 * quiet gray (a translucent 22% blue over a translucent gray read as the same colour).
 */
const WALL_QUIET = `color-mix(in oklab, ${colors.secondaryBackground}, ${colors.label} 8%)`;
const wallShade = (percent: number) =>
  `color-mix(in oklab, ${colors.accent} ${percent}%, ${colors.secondaryBackground})`;

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

/*
 * Placed by hand so the bento stays uneven and cannot shift with the source order:
 *   code   code   repo   repo
 *   code   code   prs    streak
 *   agents agents agents agents
 * Code shipped is two rows tall, and beside it sit tiles whose heights add up to about its own
 * (the repository's three lines, then the two short figures), so neither side is stretched into
 * an empty band. A taller code tile beside a three-tile stack left a gap above the wall.
 */
const AREA = {
  code: { column: '1 / span 2', row: '1 / span 2' },
  repo: { column: '3 / span 2', row: '1' },
  prs: { column: '3 / span 1', row: '2' },
  streak: { column: '4 / span 1', row: '2' },
  agents: { column: '1 / span 4', row: '3' },
} as const;
const ROWS = gridRows([5.6, 4.3, 5.6]);

const styles = stylex.create({
  icons: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    flexShrink: 0,
    color: colors.secondaryLabel,
  },
  /* The one large number in the card: everything else is a step down, so the eye lands here first. */
  heroValue: { fontSize: text.titleSize, lineHeight: text.titleLeading, letterSpacing: '-0.01em' },
  /* The label, the figure and what the lines were stay together at the top, in one left edge; the
     activity wall takes everything below, edge to edge. */
  heroTop: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  heroFoot: {
    display: 'flex',
    flex: '1 1 auto',
    alignItems: 'flex-end',
    minWidth: 0,
    paddingTop: space[2],
  },
  heroHead: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: space[3],
    rowGap: space[1],
  },
  heroDelta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    maxWidth: '100%',
    minWidth: 0,
  },
  /* The change as a soft pill: a hue only when it is up, because up is an outcome; down is
     just a quieter pill, not an alarm. */
  delta: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    whiteSpace: 'nowrap',
    paddingBlock: '1px',
    paddingInline: space[2],
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.trayBackground,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  deltaUp: {
    backgroundColor: `color-mix(in srgb, ${colors.success} 14%, transparent)`,
    color: colors.success,
  },
  deltaVs: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  /* What the lines were, as a diffstat under the number: the two counts, then five squares split
     between green and red by share, as on a pull request. Hue because they are outcomes, as the
     diff counts elsewhere. The words are read aloud, not shown. */
  changes: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  change: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
  },
  changeAdded: { color: colors.success },
  changeRemoved: { color: colors.destructive },
  changeStat: { display: 'inline-flex', gap: '2px', flexShrink: 0 },
  changeSquare: {
    width: '8px',
    height: '8px',
    borderRadius: '2px',
    backgroundColor: colors.trayBackground,
  },
  changeSquareAdded: { backgroundColor: colors.success },
  changeSquareRemoved: { backgroundColor: colors.destructive },
  /* An activity wall, like a contribution graph: a column per week (oldest on the left, today at
     the bottom of the last), a row per workday from Monday to Friday, one cell per day. Every cell
     is the same size and the same gap from the next, so it is one surface; a day's shade says how
     much happened on it (blue), over a neutral gray for quiet days. It runs the tile's whole
     width: the cells keep their size and the wall shows as many weeks as fit (`useWallWeeks`). */
  wall: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: 'minmax(0, 1fr)',
    flex: '1 1 0%',
    minWidth: 0,
    gap: `${WALL_GAP_PX}px`,
    animationName: fadeIn,
    animationDuration: { default: '0s', [MOTION]: '400ms' },
    animationTimingFunction: 'ease-out',
    animationFillMode: 'backwards',
  },
  /* Plump, not sharp: a pebble per day. */
  cell: {
    aspectRatio: '1',
    borderRadius: '3px',
    cornerShape: corner.shape,
    backgroundColor: WALL_QUIET,
  },
  level1: { backgroundColor: wallShade(38) },
  level2: { backgroundColor: wallShade(58) },
  level3: { backgroundColor: wallShade(80) },
  level4: { backgroundColor: colors.accent },
  mix: { display: 'flex', flex: '1 1 0%', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  agentList: { display: 'flex', gap: space[4], minWidth: 0 },
  names: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.label,
    fontVariantNumeric: 'tabular-nums',
  },
  /** A name in a value slot (a repository): the same size, trimmed to the tile. */
  textValue: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  stack: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  /* The summary on the line: the week in seven pebbles, the wall's language at a glyph's size. */
  summary: { display: 'inline-flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  miniWeek: {
    display: 'inline-grid',
    gridTemplateColumns: 'repeat(7, 5px)',
    gap: '2px',
    flexShrink: 0,
  },
  miniCell: {
    width: '5px',
    height: '5px',
    borderRadius: '1.5px',
    backgroundColor: WALL_QUIET,
  },
  summaryUnit: { fontWeight: 400, color: colors.secondaryLabel },
  summaryGlyph: { flexShrink: 0, width: '14px', height: '14px', color: colors.secondaryLabel },
  summaryPart: { display: 'inline-flex', alignItems: 'center', gap: '3px' },
});

const wallLevelStyle = (level: HomeWeekWallLevel) =>
  level === 0
    ? null
    : level === 1
      ? styles.level1
      : level === 2
        ? styles.level2
        : level === 3
          ? styles.level3
          : styles.level4;

/** Five squares split by share, as a pull request's diffstat: a side that has any lines keeps at
 *  least one square, and no lines at all leaves them all neutral. */
function diffStatSquares(added: number, removed: number): ('added' | 'removed' | 'none')[] {
  const total = added + removed;
  if (total <= 0) return Array.from({ length: 5 }, () => 'none');
  let addedSquares = Math.round((added / total) * 5);
  if (added > 0 && removed > 0) addedSquares = Math.min(4, Math.max(1, addedSquares));
  return Array.from({ length: 5 }, (_, index) => (index < addedSquares ? 'added' : 'removed'));
}

/** What the wall's tooltip is about: the cell under the pointer and its day. */
type WallTip = { element: HTMLElement; day: string; count: number };

/** A wall cell's `yyyy-mm-dd` read back as that local day. */
function parseDayKey(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!);
}

/** How many of the wall's weeks fit the element's width, newest kept. */
function useWallWeeks(available: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const width = element.clientWidth;
      if (width <= 0) return;
      const fontSize = Number.parseFloat(getComputedStyle(element).fontSize) || 14;
      const cell = fontSize * WALL_CELL_EM;
      setFit(Math.floor((width + WALL_GAP_PX) / (cell + WALL_GAP_PX)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const weeks = Math.min(available, Math.max(WALL_MIN_WEEKS, fit ?? WALL_FALLBACK_WEEKS));
  return { ref, weeks };
}

/** The repository's own name; the owner is the same on nearly every row. */
function repoName(repo: string): string {
  return repo.split('/').filter(Boolean).pop() ?? repo;
}

/**
 * The last seven days as five quiet tiles in a deliberately uneven bento: code shipped (the tall
 * tile on the left, with the page's one chart), and beside it merged PRs and the active streak,
 * the agents that did the work, and the most-used repository. A pure picture of its props; a
 * quiet week shows zeros.
 */
export function WeekBento({
  model,
  agentLabel,
  agentIcon,
  animate = true,
}: {
  model: HomeWeekModel;
  agentLabel: (agent: HomeWeekAgent) => string;
  /** The agent's mark, shown at the top right of the agents tile; injected so the tiles stay light. */
  agentIcon?: AgentIconRenderer;
  /** Roll the numbers up on first show. Off for tests and for a still frame. */
  animate?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = toIntlLocale(i18n.language);
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const formatNumber = (value: number) => numberFormat.format(value);

  const { ref: wallRef, weeks: wallWeeks } = useWallWeeks(model.wall.length);
  // One tooltip for the whole wall, anchored to the cell under the pointer: a tooltip per cell
  // would mount a hundred and fifty of them. The tip outlives the pointer so it can fade out.
  const [wallTip, setWallTip] = useState<WallTip | null>(null);
  const [wallTipOpen, setWallTipOpen] = useState(false);
  const dayFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    [locale]
  );
  const pointOverWall = (event: PointerEvent<HTMLDivElement>) => {
    const element = (event.target as Element).closest<HTMLElement>('[data-day]');
    if (!element || !event.currentTarget.contains(element)) return;
    setWallTip({ element, day: element.dataset.day!, count: Number(element.dataset.wallCount) });
    setWallTipOpen(true);
  };
  const wall = model.wall.slice(-wallWeeks);
  const activityLabel = t('home.week.activity', 'Active workdays, last {{count}} weeks', {
    count: wall.length,
  });

  return (
    <div
      data-testid="home-week"
      {...stylex.props(tileStyles.grid)}
      style={{ gridTemplateRows: ROWS }}
    >
      <Tile area={AREA.code}>
        <div {...stylex.props(styles.heroTop)}>
          <p {...stylex.props(tileStyles.label)}>
            {t('home.week.lines', 'Code shipped, last 7 days')}
          </p>
          <div {...stylex.props(styles.heroHead)}>
            <p {...stylex.props(tileStyles.value, styles.heroValue)}>
              <Count value={model.lines} animate={animate} format={formatNumber} />
              <span {...stylex.props(tileStyles.unit)}>
                {t('home.week.linesUnit', 'lines', { count: model.lines })}
              </span>
            </p>
            {model.delta != null && model.delta !== 0 ? (
              <span {...stylex.props(styles.heroDelta)}>
                <span {...stylex.props(styles.delta, model.delta > 0 && styles.deltaUp)}>
                  {model.delta > 0
                    ? t('home.week.deltaUp', '↑ {{percent}}%', { percent: model.delta })
                    : t('home.week.deltaDown', '↓ {{percent}}%', {
                        percent: Math.abs(model.delta),
                      })}
                </span>
                <span {...stylex.props(styles.deltaVs)}>
                  {t('home.week.deltaVs', 'vs the week before')}
                </span>
              </span>
            ) : null}
          </div>
          <div {...stylex.props(styles.changes)}>
            <p {...stylex.props(styles.change, styles.changeAdded)}>
              +{formatNumber(model.added)}
              <span {...stylex.props(tileStyles.srOnly)}>{t('home.week.added', 'added')}</span>
            </p>
            <p {...stylex.props(styles.change, styles.changeRemoved)}>
              −{formatNumber(model.removed)}
              <span {...stylex.props(tileStyles.srOnly)}>{t('home.week.removed', 'removed')}</span>
            </p>
            <span aria-hidden="true" {...stylex.props(styles.changeStat)}>
              {diffStatSquares(model.added, model.removed).map((kind, index) => (
                <i
                  key={index}
                  data-kind={kind}
                  {...stylex.props(
                    styles.changeSquare,
                    kind === 'added' && styles.changeSquareAdded,
                    kind === 'removed' && styles.changeSquareRemoved
                  )}
                />
              ))}
            </span>
          </div>
        </div>
        <div {...stylex.props(styles.heroFoot)}>
          <div
            ref={wallRef}
            role="img"
            aria-label={activityLabel}
            onPointerOver={pointOverWall}
            onPointerLeave={() => setWallTipOpen(false)}
            {...stylex.props(styles.wall)}
            style={{ gridTemplateRows: `repeat(${HOME_WEEK_WALL_ROWS}, auto)` }}
          >
            {wall.flatMap((week, weekIndex) =>
              week.map(({ day, count, level }, row) => (
                <i
                  key={`${weekIndex}:${row}`}
                  data-level={level}
                  data-day={day}
                  data-wall-count={count}
                  {...stylex.props(styles.cell, wallLevelStyle(level))}
                />
              ))
            )}
          </div>
          <Tooltip.Root open={wallTipOpen}>
            {wallTip ? (
              <Tooltip.Content side="top" anchor={wallTip.element}>
                {wallTip.count > 0
                  ? t('home.week.wallDay', '{{date}} · {{count}} session events', {
                      date: dayFormat.format(parseDayKey(wallTip.day)),
                      count: wallTip.count,
                    })
                  : t('home.week.wallQuiet', '{{date}} · No activity', {
                      date: dayFormat.format(parseDayKey(wallTip.day)),
                    })}
              </Tooltip.Content>
            ) : null}
          </Tooltip.Root>
        </div>
      </Tile>

      <Tile area={AREA.repo}>
        <p {...stylex.props(tileStyles.label)}>{t('home.week.repo', 'Most-used repository')}</p>
        {model.topRepo ? (
          <div {...stylex.props(styles.stack)}>
            <p {...stylex.props(tileStyles.value)}>
              <span data-repo={model.topRepo.repo} {...stylex.props(styles.textValue)}>
                {repoName(model.topRepo.repo)}
              </span>
            </p>
            <p {...stylex.props(tileStyles.note)}>
              {t('home.week.repoShare', '{{percent}}% of your sessions', {
                percent: model.topRepo.percent,
              })}
            </p>
          </div>
        ) : (
          <p {...stylex.props(tileStyles.value)}>–</p>
        )}
      </Tile>

      <Tile area={AREA.prs}>
        <p {...stylex.props(tileStyles.label)}>{t('home.week.prs', 'PRs merged')}</p>
        <p {...stylex.props(tileStyles.value)}>
          <Count value={model.mergedPrs} animate={animate} format={formatNumber} />
        </p>
      </Tile>

      <Tile area={AREA.streak}>
        <p {...stylex.props(tileStyles.label)}>{t('home.week.streak', 'Active streak')}</p>
        <p {...stylex.props(tileStyles.value)}>
          <Count value={model.streak} animate={animate} format={formatNumber} />
          <span {...stylex.props(tileStyles.unit)}>
            {t('home.week.streakUnit', 'days', { count: model.streak })}
          </span>
        </p>
      </Tile>

      <Tile area={AREA.agents}>
        <div {...stylex.props(tileStyles.head)}>
          <p {...stylex.props(tileStyles.label)}>{t('home.week.agents', 'Agents')}</p>
          {agentIcon && model.agents.length > 0 ? (
            <span aria-hidden="true" {...stylex.props(styles.icons)}>
              {model.agents.map((agent) => (
                <span key={`${agent.cliType}:${agent.agentType}`}>{agentIcon(agent)}</span>
              ))}
            </span>
          ) : null}
        </div>
        {model.agents.length > 0 ? (
          <div {...stylex.props(styles.agentList)}>
            {model.agents.map((agent, index) => {
              const percent = Math.round((agent.count / model.sessions) * 100);
              return (
                <div key={`${agent.cliType}:${agent.agentType}`} {...stylex.props(styles.mix)}>
                  <p {...stylex.props(styles.names)}>
                    <span {...stylex.props(tileStyles.name)}>
                      {t('home.week.agentShare', '{{name}} {{percent}}%', {
                        name: agentLabel(agent),
                        percent,
                      })}
                    </span>
                  </p>
                  <div aria-hidden="true" {...stylex.props(tileStyles.track)}>
                    <i
                      data-testid={index === 0 ? 'home-week-mix' : undefined}
                      {...stylex.props(tileStyles.fill)}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p {...stylex.props(tileStyles.value)}>–</p>
        )}
      </Tile>
    </div>
  );
}

/**
 * What the week says while its board is folded into the line: seven pebbles (the last seven days
 * of lines, shaded like the wall) with the line count, and the streak.
 */
export function WeekSummary({ model }: { model: HomeWeekModel }) {
  const { t, i18n } = useTranslation();
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(toIntlLocale(i18n.language)),
    [i18n.language]
  );
  const busiest = Math.max(0, ...model.daily);
  return (
    <span data-testid="home-week-summary" {...stylex.props(styles.summary)}>
      <span aria-hidden="true" {...stylex.props(styles.miniWeek)}>
        {model.daily.map((lines, index) => {
          const level = (busiest > 0 ? Math.ceil((lines / busiest) * 4) : 0) as HomeWeekWallLevel;
          return <i key={index} {...stylex.props(styles.miniCell, wallLevelStyle(level))} />;
        })}
      </span>
      <span>
        {numberFormat.format(model.lines)}{' '}
        <span {...stylex.props(styles.summaryUnit)}>
          {t('home.week.linesUnit', 'lines', { count: model.lines })}
        </span>
      </span>
      <span {...stylex.props(styles.summaryPart)}>
        <Flame aria-hidden="true" {...stylex.props(styles.summaryGlyph)} />
        <span {...stylex.props(tileStyles.srOnly)}>{t('home.week.streak', 'Active streak')}</span>
        {numberFormat.format(model.streak)}{' '}
        <span {...stylex.props(styles.summaryUnit)}>
          {t('home.week.streakUnit', 'days', { count: model.streak })}
        </span>
      </span>
    </span>
  );
}
