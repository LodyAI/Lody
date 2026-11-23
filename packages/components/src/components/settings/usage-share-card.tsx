import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import QRCode from 'qrcode';
import { space } from '@lody/ui/tokens/scales.stylex';
import { formatCompactNumber, formatUsdCompact, formatUsdTight } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { ensureShareThemeScopes } from '@/components/share-theme-scope';
import { ModelBrandIcon } from '@/components/icons/model-brand-icon';
import { Avatar } from '@lody/ui/avatar';
import { avatarPaletteTheme } from '@lody/ui/avatar/avatar.tokens.stylex';
import { productDarkPalette, productLightPalette } from '@/lib/vscode-theme/lody-ui-palette.stylex';
import lodyLogo from '@/assets/lody-icon.png';
import { createUsageHeatScale, type UsageCalendarModel } from './usage-calendar-model';
import type { UsageShareGraphic, UsageShareSlice, UsageShareStats } from './usage-share-stats';

/**
 * Feed formats, not free-form sizes. Portrait claims the largest area a social
 * feed grants; wide is the inline-preview shape for X and for embedding in a
 * README or a post. The exported PNG is exactly these pixels at 2x.
 */
export type UsageShareCardAspect = 'portrait' | 'wide';

/** Whose record the card is: the workspace as one body, or its members. */
export type UsageShareCardSubject = 'personal' | 'team';

/** Same gradient presets as the session share card, so both read as one product. */
export type UsageShareCardBackdrop = 'none' | 'lody' | 'aurora' | 'ocean' | 'sunset';

/**
 * Where the sign-off lives. `card` keeps it inside, under a rule. `canvas` moves it
 * onto the backdrop below the card, the way the session card's canvas footer does:
 * the only placement that *gives* the card height instead of taking it, since the
 * in-card band goes away entirely and the backdrop is otherwise empty pixels. It
 * needs a backdrop to sit on, so an unframed card falls back to `card`.
 */
export type UsageShareCardFooter = 'card' | 'canvas';

/**
 * These are the whole exported image, backdrop included — so a framed card is
 * 48px shorter than an unframed one, and the layout has to fit the framed case
 * because a backdrop is the default. Both were sized up until the framed
 * variant has real headroom rather than landing flush against its footer.
 */
export interface UsageShareCardProps {
  /** 53-week calendar, used when the range's graphic is the year. */
  calendar: UsageCalendarModel;
  stats: UsageShareStats;
  /** Which graphic this range draws; see `computeUsageShareGraphic`. */
  graphic: UsageShareGraphic;
  /** Model split for the range; empty hides the split block. */
  modelSlices: UsageShareSlice[];
  /** Member split for the range; only read when `subject` is `team`. */
  memberSlices: UsageShareSlice[];
  /** Human label for the range, e.g. "Last 30 days". */
  rangeLabel: string;
  workspaceName?: string;
  aspect?: UsageShareCardAspect;
  subject?: UsageShareCardSubject;
  backdrop?: UsageShareCardBackdrop;
  shareUrl?: string;
  showQr?: boolean;
  /** Sign-off placement; `canvas` needs a backdrop and falls back to `card` without one. */
  footer?: UsageShareCardFooter;
  /** Pins the exported palette instead of following the app's current theme. */
  theme?: 'light' | 'dark';
  className?: string;
  onAssetsReadyChange?: (ready: boolean) => void;
}

const DEFAULT_SHARE_URL = 'https://lody.ai';

const DARK_THEME =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  backdropLody: {
    backgroundImage:
      'radial-gradient(52% 38% at 18% 12%, rgba(53,200,176,0.45), transparent 70%), radial-gradient(48% 36% at 86% 16%, rgba(47,119,191,0.5), transparent 70%), radial-gradient(70% 55% at 68% 96%, rgba(31,79,127,0.65), transparent 75%), radial-gradient(120% 100% at 50% 50%, transparent 55%, rgba(2,10,18,0.55) 100%), linear-gradient(165deg, #0a1c2b 0%, #0c2438 55%, #081626 100%)',
  },
  backdropAurora: {
    backgroundImage: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 45%, #db2777 100%)',
  },
  backdropOcean: {
    backgroundImage: 'linear-gradient(135deg, #0369a1 0%, #0891b2 50%, #34d399 100%)',
  },
  backdropSunset: {
    backgroundImage: 'linear-gradient(135deg, #9a3412 0%, #ea580c 45%, #f59e0b 100%)',
  },
  textHero: { fontSize: '54px', lineHeight: 1.45 },
  textHeroWide: { fontSize: '32px', lineHeight: 1.45 },
  textStat: { fontSize: '20px', lineHeight: 1.45 },
  textStatWide: { fontSize: '15px', lineHeight: 1.45 },
  textBody: { fontSize: '13px', lineHeight: 1.45 },
  textMeta: { fontSize: '11px', lineHeight: 1.45 },
  textMicro: { fontSize: '10px', lineHeight: 1.45 },
  padX: { paddingInline: space[6] },
  bandPortrait: { gap: '20px' },
  bandWide: { gap: space[3] },
  padPortrait: { paddingBlock: space[6] },
  padWide: { paddingBlock: space[3] },
  stackPortrait: { display: 'flex', flexDirection: 'column', gap: space[2] },
  stackWide: { display: 'flex', flexDirection: 'column', gap: space[1] },
  splitPortrait: { display: 'flex', flexDirection: 'column', gap: space[4] },
  splitWide: { display: 'flex', flexDirection: 'column', gap: space[2] },
  rowsPortrait: { display: 'flex', flexDirection: 'column', gap: space[2] },
  rowsWide: { display: 'flex', flexDirection: 'column', gap: space[1] },
  axisPortrait: { marginBlockEnd: space[2] },
  axisWide: { marginBlockEnd: space[1] },
  graphic: { height: '58px' },
  axis: { position: 'relative', height: '12px' },
  axisLabel: {
    position: 'absolute',
    insetBlockStart: 0,
    lineHeight: 1,
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)',
  },
  svg: { display: 'block', width: '100%', height: 'auto' },
  hourBars: { display: 'flex', alignItems: 'flex-end', columnGap: '1px' },
  hourBar: {
    minWidth: 0,
    flex: '1 1 0%',
    borderStartStartRadius: '1px',
    borderStartEndRadius: '1px',
  },
  weekRows: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between' },
  weekRow: { display: 'flex', flex: '1 1 0%', alignItems: 'center' },
  weekLine: { display: 'flex', flex: '1 1 0%', alignItems: 'center', columnGap: '1px' },
  weekCell: { display: 'flex', minWidth: 0, flex: '1 1 0%', justifyContent: 'center' },
  split: { flexShrink: 0 },
  splitBar: {
    display: 'flex',
    height: '6px',
    overflow: 'hidden',
    borderRadius: '9999px',
    backgroundColor: 'color-mix(in oklab, hsl(var(--foreground)) 7%, transparent)',
  },
  splitRows: { display: 'flex', flexWrap: 'wrap', columnGap: space[4], rowGap: space[2] },
  splitRow: { display: 'flex', minWidth: 0, alignItems: 'center', gap: space[2] },
  splitMark: { width: '6px', height: '6px', flexShrink: 0, borderRadius: '9999px' },
  splitLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'hsl(var(--muted-foreground))',
  },
  splitValue: {
    marginInlineStart: 'auto',
    flexShrink: 0,
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
  },
  splitPercent: {
    flexShrink: 0,
    textAlign: 'right',
    fontWeight: 400,
    color: 'hsl(var(--foreground))',
  },
  splitPercentFull: { marginInlineStart: space[4], width: '40px' },
  splitPercentCompact: { marginInlineStart: 'auto' },
  modelIcon: { width: '14px', height: '14px', flexShrink: 0 },
  statCell: { minWidth: 0 },
  statValue: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 400,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--foreground))',
  },
  statLabel: {
    marginBlockStart: space[1],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    lineHeight: 1.25,
    color: 'hsl(var(--muted-foreground))',
  },
  heroValue: {
    whiteSpace: 'nowrap',
    fontWeight: 400,
    lineHeight: 1,
    letterSpacing: '-0.025em',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--foreground))',
  },
  heroUnits: { fontWeight: 400, color: 'hsl(var(--muted-foreground))' },
  heroWide: { display: 'flex', minWidth: 0, alignItems: 'baseline', gap: space[2] },
  heroPortrait: { minWidth: 0 },
  heroUnitLine: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    marginBlockStart: space[2],
  },
  period: {
    marginBlockStart: space[2],
    fontVariantNumeric: 'tabular-nums',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
  },
  header: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[2] },
  logoSmall: { width: '16px', height: '16px', transform: 'scale(1.64)', borderRadius: '6px' },
  logoMedium: { width: '20px', height: '20px', transform: 'scale(1.64)', borderRadius: '6px' },
  logoLarge: { width: '24px', height: '24px', transform: 'scale(1.64)', borderRadius: '6px' },
  brand: { fontWeight: 400, color: 'hsl(var(--foreground))' },
  range: {
    marginInlineStart: 'auto',
    borderRadius: '9999px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    paddingBlock: '4px',
    paddingInline: '8px',
    fontWeight: 400,
    lineHeight: 1,
    color: 'hsl(var(--muted-foreground))',
  },
  heatmap: { flexShrink: 0 },
  heatCaption: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
  },
  footer: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    marginBlockStart: 'auto',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border))',
    backgroundColor: 'hsl(var(--card))',
    paddingInline: space[6],
  },
  footerWide: { gap: space[2], paddingBlock: space[3] },
  footerPortrait: { gap: space[3], paddingBlock: space[4] },
  footerFramed: {
    backgroundColor: {
      default: 'white',
      [DARK_THEME]: 'color-mix(in oklab, white 4%, transparent)',
    },
  },
  footerUnframed: {
    borderColor: {
      default: 'color-mix(in oklab, black 6%, transparent)',
      [DARK_THEME]: 'color-mix(in oklab, white 8%, transparent)',
    },
  },
  footerWorkspace: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 400,
    color: 'hsl(var(--foreground))',
  },
  footerFlex: { minWidth: 0, flex: '1 1 0%' },
  footerHost: {
    marginBlockStart: '2px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    lineHeight: 1.25,
    color: 'hsl(var(--muted-foreground))',
  },
  footerDomain: {
    marginInlineStart: 'auto',
    fontWeight: 400,
    color: 'hsl(var(--muted-foreground))',
  },
  qr: {
    flexShrink: 0,
    borderRadius: '3px',
    backgroundColor: {
      default: 'white',
      [DARK_THEME]: 'color-mix(in oklab, white 90%, transparent)',
    },
    padding: space[1],
  },
  qrWide: { marginInlineStart: space[2], width: '32px', height: '32px' },
  qrPortrait: { width: '40px', height: '40px' },
  card: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    overflow: 'hidden',
    color: 'hsl(var(--card-foreground))',
    backgroundColor: 'hsl(var(--card))',
  },
  cardFramed: {
    borderRadius: '16px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: 'color-mix(in oklab, black 6%, transparent)',
      [DARK_THEME]: 'color-mix(in oklab, white 10%, transparent)',
    },
    boxShadow: '0 24px 64px -16px rgb(0 0 0 / 45%)',
  },
  cardUnframed: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: 'color-mix(in oklab, black 8%, transparent)',
      [DARK_THEME]: 'color-mix(in oklab, white 9%, transparent)',
    },
  },
  cardBand: {
    position: 'relative',
    display: 'flex',
    minHeight: 0,
    flex: '1 1 0%',
    flexDirection: 'column',
  },
  cardBandWide: { justifyContent: 'space-between' },
  heroBand: { display: 'flex', alignItems: 'baseline', gap: space[4] },
  statGroup: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'baseline',
    gap: space[4],
    marginInlineStart: 'auto',
  },
  statInline: { display: 'flex', alignItems: 'baseline', gap: space[2] },
  cardHeroCenter: { marginBlock: 'auto' },
  statGrid: {
    display: 'grid',
    flexShrink: 0,
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: space[4],
    borderBlockWidth: '1px',
    borderBlockStyle: 'solid',
    borderBlockColor: 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    paddingBlock: space[3],
  },
  canvasSignOff: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '10px',
    marginBlockStart: space[4],
  },
  canvasWorkspace: { fontWeight: 400, letterSpacing: '0.025em', color: 'rgb(255 255 255 / 90%)' },
  canvasDomain: { fontWeight: 400, color: 'rgb(255 255 255 / 60%)' },
  canvasQr: {
    marginInlineStart: 'auto',
    width: '36px',
    height: '36px',
    borderRadius: '3px',
    backgroundColor: 'white',
    padding: space[1],
    boxShadow: '0 2px 10px rgb(0 0 0 / 25%)',
  },
  root: { display: 'flex', flexDirection: 'column', padding: space[6] },
  rootNoFrame: { padding: 0 },
  rootOnCanvas: { paddingBlockEnd: '20px' },
  rootPortrait: { width: '576px', height: '720px' },
  rootWide: { width: '704px', height: '396px' },
  content: { display: 'flex', minHeight: 0, flex: '1 1 0%' },
});

export const USAGE_SHARE_BACKDROP_STYLES = {
  lody: styles.backdropLody,
  aurora: styles.backdropAurora,
  ocean: styles.backdropOcean,
  sunset: styles.backdropSunset,
};

/**
 * The card's whole type scale. Every text node picks a role from here rather
 * than an arbitrary size: an exported image has no hover state or tooltip to
 * recover a hierarchy that half-pixel steps blur away, and two cards taken a
 * month apart must set the same words at the same size.
 */
const TEXT = {
  /** The one number the card exists to deliver. */
  hero: styles.textHero,
  heroWide: styles.textHeroWide,
  /** Headline cell values. */
  stat: styles.textStat,
  statWide: styles.textStatWide,
  /** Brand, unit, workspace — anything read before the details. */
  body: styles.textBody,
  /** Cell labels, legend rows, the range chip. */
  meta: styles.textMeta,
  /** Month ticks and the heatmap caption. */
  micro: styles.textMicro,
} as const;

/**
 * Horizontal padding is one value for every band including the footer, so the
 * brand mark, the hero, the heatmap and the workspace name all share a left
 * edge. Vertical padding differs by format because only the height budget does.
 */
const PAD_X = styles.padX;

/**
 * Vertical rhythm is the one thing the two formats may disagree about, because
 * only their height budget differs: 4:5 has room to breathe between bands, 16:9
 * has to fit the same five bands into 40% of the height. Declared here as two
 * rows rather than sprinkled per element, so "the wide card is tighter" stays a
 * single decision. Every value is on the same 4px grid.
 */
type CardRhythm = {
  band: typeof styles.bandPortrait | typeof styles.bandWide;
  padY: typeof styles.padPortrait | typeof styles.padWide;
  stack: typeof styles.stackPortrait | typeof styles.stackWide;
  split: typeof styles.splitPortrait | typeof styles.splitWide;
  rows: typeof styles.rowsPortrait | typeof styles.rowsWide;
  axis: typeof styles.axisPortrait | typeof styles.axisWide;
};

const RHYTHM: Record<UsageShareCardAspect, CardRhythm> = {
  portrait: {
    band: styles.bandPortrait,
    padY: styles.padPortrait,
    stack: styles.stackPortrait,
    // The 100% bar summarises the legend, so it needs a group-sized gap. At the
    // row gap it reads as the list's first item instead of its summary.
    split: styles.splitPortrait,
    rows: styles.rowsPortrait,
    axis: styles.axisPortrait,
  },
  wide: {
    band: styles.bandWide,
    padY: styles.padWide,
    stack: styles.stackWide,
    split: styles.splitWide,
    rows: styles.rowsWide,
    axis: styles.axisWide,
  },
};

/**
 * Every range's graphic occupies the same box, so the card's height never depends
 * on which range it describes — the whole point of a fixed format. It matches what
 * the 53-week grid renders at (its aspect ratio against the content width), and the
 * hourly graphics fit themselves to it rather than the other way round.
 */
const GRAPHIC_H = styles.graphic;

/** Heatmap geometry in SVG units; the SVG scales to whatever column holds it. */
const HEAT_CELL = 10;
const HEAT_GAP = 2.6;
const HEAT_COLUMNS = 53;
const HEAT_ROWS = 7;

function heatFill(intensity: number, lit: boolean): string {
  if (intensity <= 0) return 'hsl(var(--muted-foreground) / 0.13)';
  // Days outside the shared range stay legible but recede, so the range the
  // headline number describes is the part the eye lands on.
  return `hsl(var(--chart-1) / ${(lit ? intensity : intensity * 0.4).toFixed(3)})`;
}

/**
 * Month ticks for the 53-week grid. Without them the heatmap is a texture with no
 * time scale — the reader can see a burst but not when it happened. Ticks land on
 * the first column of each month and thin out to keep the row legible.
 */
function monthTicks(
  calendar: UsageCalendarModel,
  locale: string
): Array<{ column: number; label: string }> {
  const format = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const ticks: Array<{ column: number; label: string }> = [];
  let previousMonth = -1;
  for (const week of calendar.weeks) {
    const cell = week.find((candidate) => !candidate.isFuture);
    if (!cell) continue;
    const month = new Date(cell.dayStartMs).getUTCMonth();
    if (month === previousMonth) continue;
    previousMonth = month;
    // Skip the first column: its label would be clipped by the card padding.
    if (cell.column < 1) continue;
    const last = ticks.at(-1);
    if (last && cell.column - last.column < 4) continue;
    ticks.push({ column: cell.column, label: format.format(new Date(cell.dayStartMs)) });
  }
  // The final tick would collide with the right edge.
  return ticks.filter((tick) => tick.column <= HEAT_COLUMNS - 3);
}

function UsageShareHeatmap({
  calendar,
  lit,
  locale,
  axisGap,
}: {
  calendar: UsageCalendarModel;
  lit: UsageShareStats['litDayStartMs'];
  locale: string;
  axisGap: CardRhythm['axis'];
}) {
  const scale = createUsageHeatScale(calendar);
  const width = HEAT_COLUMNS * (HEAT_CELL + HEAT_GAP) - HEAT_GAP;
  const height = HEAT_ROWS * (HEAT_CELL + HEAT_GAP) - HEAT_GAP;
  return (
    <div>
      {/* Labels live in HTML, not in the SVG: the grid scales to its column and
          SVG text would scale with it, so the two formats would disagree. */}
      <div {...stylex.props(styles.axis, axisGap)}>
        {monthTicks(calendar, locale).map((tick) => (
          <span
            key={tick.column}
            {...stylex.props(styles.axisLabel, TEXT.micro)}
            style={{ left: `${(tick.column / HEAT_COLUMNS) * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} {...stylex.props(styles.svg)} role="presentation">
        {calendar.cells.map((cell) => {
          const inWindow = !lit || (cell.dayStartMs >= lit.fromMs && cell.dayStartMs <= lit.toMs);
          return (
            <rect
              key={`${cell.column}-${cell.row}`}
              x={cell.column * (HEAT_CELL + HEAT_GAP)}
              y={cell.row * (HEAT_CELL + HEAT_GAP)}
              width={HEAT_CELL}
              height={HEAT_CELL}
              rx={2.4}
              fill={
                cell.isFuture
                  ? 'hsl(var(--muted-foreground) / 0.05)'
                  : heatFill(scale.intensity(cell.tokens), inWindow)
              }
            />
          );
        })}
      </svg>
    </div>
  );
}

/** Hour ticks under an hourly graphic, the axis counterpart of the month ticks. */
function HourAxis({ gap }: { gap: CardRhythm['axis'] }) {
  return (
    <div {...stylex.props(styles.axis, gap)}>
      {[0, 6, 12, 18].map((hour) => (
        <span
          key={hour}
          {...stylex.props(styles.axisLabel, TEXT.micro)}
          style={{ left: `${(hour / 24) * 100}%` }}
        >
          {String(hour).padStart(2, '0')}
        </span>
      ))}
    </div>
  );
}

/**
 * 24h: one flat bar per hour standing on a baseline — the Usage screen's own hour
 * skyline. Height carries magnitude; the fill lightens with share of the peak, so
 * a quiet hour still reads as present rather than as a gap.
 */
function UsageShareHours({ values, axisGap }: { values: number[]; axisGap: CardRhythm['axis'] }) {
  const max = Math.max(...values, 0);
  return (
    <div>
      <HourAxis gap={axisGap} />
      <div {...stylex.props(styles.hourBars, GRAPHIC_H)}>
        {values.map((value, index) => {
          const share = max > 0 ? value / max : 0;
          return (
            <div
              key={index}
              {...stylex.props(styles.hourBar)}
              style={{
                height: value > 0 ? `${Math.max(7, share * 100)}%` : '2px',
                backgroundColor:
                  value > 0
                    ? `hsl(var(--chart-1) / ${(0.35 + share * 0.55).toFixed(3)})`
                    : 'hsl(var(--muted-foreground) / 0.16)',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * 7d: the same 24 hour tracks stacked seven deep, as dots rather than tiles. A
 * circle that grows and brightens with its hour keeps a quiet week readable as
 * texture, where a full-bleed grid turns into a wall.
 */
function UsageShareWeekHours({
  rows,
  axisGap,
}: {
  rows: Array<{ dayStartMs: number; values: number[] }>;
  axisGap: CardRhythm['axis'];
}) {
  const max = Math.max(0, ...rows.flatMap((row) => row.values));
  return (
    <div>
      <HourAxis gap={axisGap} />
      {/* Rows divide the shared box, so a week fits the same height as a year.
          They carry no per-day label on purpose: eight rows in this box leave 7px
          each, which cannot hold any size on the card's type scale — the first
          attempt used an off-scale 8px and read as a squeezed column. Rows run
          oldest to newest, and the headline already names the span. */}
      <div {...stylex.props(styles.weekRows, GRAPHIC_H)}>
        {rows.map((row) => (
          <div key={row.dayStartMs} {...stylex.props(styles.weekRow)}>
            <div {...stylex.props(styles.weekLine)}>
              {row.values.map((value, hour) => {
                const share = max > 0 ? value / max : 0;
                const size = value > 0 ? 2.5 + share * 4.5 : 2;
                return (
                  <div key={hour} {...stylex.props(styles.weekCell)}>
                    <div
                      {...stylex.props(styles.splitMark)}
                      style={{
                        width: `${size}px`,
                        height: `${size}px`,
                        backgroundColor:
                          value > 0
                            ? `hsl(var(--chart-1) / ${(0.35 + share * 0.55).toFixed(3)})`
                            : 'hsl(var(--muted-foreground) / 0.16)',
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 100% bar + legend. One shape for models and members; only the mark differs. */
function UsageShareSplit({
  slices,
  subject,
  compact,
  locale,
  formatValue,
  split,
  rows: rowGap,
}: {
  slices: UsageShareSlice[];
  subject: UsageShareCardSubject;
  compact: boolean;
  locale: string;
  formatValue: (value: number) => string;
  /** Bar-to-legend gap and row-to-row gap, from the format's rhythm. */
  split: CardRhythm['split'];
  rows: CardRhythm['rows'];
}) {
  if (slices.length === 0) return null;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const rows = compact ? slices.slice(0, 2) : slices;
  return (
    <div {...stylex.props(styles.split, split)}>
      <div {...stylex.props(styles.splitBar)}>
        {slices.map((slice, index) => (
          <div
            key={slice.id}
            style={{
              width: `${Math.max(1, slice.share * 100)}%`,
              backgroundColor: `hsl(var(--chart-${(index % 5) + 1}))`,
            }}
          />
        ))}
      </div>
      <div {...stylex.props(compact ? styles.splitRows : rowGap)}>
        {rows.map((slice, index) => (
          <div key={slice.id} {...stylex.props(styles.splitRow)}>
            <span
              {...stylex.props(styles.splitMark)}
              style={{ backgroundColor: `hsl(var(--chart-${(index % 5) + 1}))` }}
            />
            {subject === 'team' ? (
              <Avatar.Root size="mini">
                {slice.image ? <Avatar.Image src={slice.image} alt="" /> : null}
                <Avatar.Fallback>{slice.label.slice(0, 2).toUpperCase()}</Avatar.Fallback>
              </Avatar.Root>
            ) : (
              <ModelBrandIcon
                modelId={slice.id}
                className={stylex.props(styles.modelIcon).className}
              />
            )}
            <span {...stylex.props(styles.splitLabel, TEXT.meta)}>{slice.label}</span>
            {/* Percent alone hides scale: 52% of a quiet week and of a heavy
                month are not the same fact, so the row carries both. */}
            {compact ? null : (
              <span {...stylex.props(styles.splitValue, TEXT.meta)}>
                {formatValue(slice.value)}
              </span>
            )}
            <span
              {...stylex.props(
                styles.splitPercent,
                TEXT.meta,
                compact ? styles.splitPercentCompact : styles.splitPercentFull
              )}
            >
              {percent.format(slice.share)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div {...stylex.props(styles.statCell)}>
      <div {...stylex.props(styles.statValue, TEXT.stat)}>{value}</div>
      <div {...stylex.props(styles.statLabel, TEXT.meta)}>{label}</div>
    </div>
  );
}

/**
 * Fixed-format poster for a workspace's usage over one range. Unlike the session
 * share card — which is an editor for content of unpredictable shape — this is a
 * generator for a report of fixed shape: same blocks every time, only the numbers
 * move, so two months' cards can be laid side by side and compared.
 *
 * Blocks, top to bottom: brand + range, the hero token total, three headline
 * cells, the 53-week heatmap with the range's window lit, the model (or member)
 * split, and an EXIF-style footer that matches the session card's grammar.
 */
export function UsageShareCard({
  calendar,
  stats,
  graphic,
  modelSlices,
  memberSlices,
  rangeLabel,
  workspaceName,
  aspect = 'portrait',
  subject = 'personal',
  backdrop = 'lody',
  shareUrl = DEFAULT_SHARE_URL,
  showQr = true,
  footer: footerPlacement = 'card',
  theme,
  className,
  onAssetsReadyChange,
}: UsageShareCardProps) {
  const { t, i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Injects the scoped theme rules before first paint; idempotent no-op after.
  ensureShareThemeScopes();
  const themeScopeClass =
    theme === 'light' ? 'light-scope' : theme === 'dark' ? 'dark-scope' : undefined;

  useEffect(() => {
    onAssetsReadyChange?.(!showQr || qrDataUrl !== null);
  }, [showQr, qrDataUrl, onAssetsReadyChange]);

  useEffect(() => {
    if (!showQr) {
      setQrDataUrl(null);
      return undefined;
    }
    let cancelled = false;
    QRCode.toDataURL(shareUrl, {
      margin: 0,
      width: 160,
      errorCorrectionLevel: 'M',
      color: { dark: '#101828', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shareUrl, showQr]);

  const wide = aspect === 'wide';
  const rhythm = RHYTHM[aspect];
  const framed = backdrop !== 'none';
  // Without a backdrop there is nothing to print the sign-off on.
  const onCanvas = footerPlacement === 'canvas' && framed;
  // The unit comes with the numbers, so the card cannot be told one thing and
  // handed another.
  const { metric } = stats;
  const slices = subject === 'team' ? memberSlices : modelSlices;
  // Every number on the card goes through this, so a cost card can never print a
  // token count beside a dollar figure.
  /**
   * The headline is the subject and gets the metric's own language: compact for
   * tokens, digits-to-a-billion for money.
   */
  const formatHeadline = (value: number) =>
    metric === 'tokens' ? formatCompactNumber(value, locale) : formatUsdCompact(value, locale);
  /**
   * A stat cell has a quarter of the headline's width and a legend row less than
   * that, so those always compact. Letting the fuller form through and relying on
   * `truncate` produced `$42,040…` — an ellipsis on a number is a wrong number,
   * which is worse than a rounded one.
   */
  const formatTight = (value: number) =>
    metric === 'tokens' ? formatCompactNumber(value, locale) : formatUsdTight(value, locale);

  // Same four facts at every range, only the unit changes: how often, how
  // consistently, how much on a typical unit, how much at the best one.
  const allCells =
    stats.trio === 'interval'
      ? [
          { label: t('workspace.usage.skyline.activeIntervals'), value: String(stats.activeCount) },
          { label: t('workspace.usage.skyline.longestStreak'), value: String(stats.longestStreak) },
          {
            label: t('workspace.usage.skyline.averagePerInterval'),
            value: formatTight(stats.average),
          },
          { label: t('workspace.usage.skyline.peakInterval'), value: formatTight(stats.peak) },
        ]
      : [
          { label: t('workspace.usage.skyline.activeDays'), value: String(stats.activeCount) },
          { label: t('workspace.usage.skyline.longestStreak'), value: String(stats.longestStreak) },
          { label: t('workspace.usage.skyline.dailyAverage'), value: formatTight(stats.average) },
          { label: t('workspace.usage.skyline.peakDay'), value: formatTight(stats.peak) },
        ];
  // 16:9 puts the cells on the hero's baseline, where a fourth would not fit.
  const trioCells = wide ? allCells.slice(0, 3) : allCells;

  const heroValue = (
    <span {...stylex.props(styles.heroValue, wide ? TEXT.heroWide : TEXT.hero)}>
      {formatHeadline(stats.total)}
    </span>
  );
  const dayFormat = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const periodDates = `${dayFormat.format(new Date(stats.periodMs.fromMs))} – ${dayFormat.format(
    new Date(stats.periodMs.toMs)
  )}`;

  // The unit is named once, by the caption. A card denominated in dollars must not
  // also print a token count somewhere, or the reader has to guess which is the
  // subject.
  const heroUnits = (
    <span {...stylex.props(styles.heroUnits, TEXT.body)}>
      {metric === 'tokens' ? t('workspace.usage.tokens') : t('workspace.usage.cost')}
    </span>
  );

  // Portrait stacks the unit under the number; wide sets it on the same
  // baseline, because 16:9 pays for every row of height.
  const hero = wide ? (
    <div {...stylex.props(styles.heroWide)}>
      {heroValue}
      {heroUnits}
    </div>
  ) : (
    <div {...stylex.props(styles.heroPortrait)}>
      {heroValue}
      <div {...stylex.props(styles.heroUnitLine)}>{heroUnits}</div>
      <div {...stylex.props(styles.period, TEXT.meta)}>{periodDates}</div>
    </div>
  );

  const header = (
    <div {...stylex.props(styles.header)}>
      <img src={lodyLogo} alt="" {...stylex.props(styles.logoSmall)} />
      <span {...stylex.props(styles.brand, TEXT.body)}>Lody</span>
      <span {...stylex.props(styles.range, TEXT.meta)}>{rangeLabel}</span>
    </div>
  );

  // One slot, three visual languages — the same split the Usage screen makes, so a
  // 24h card is an hour skyline rather than a year with one cell lit.
  const heatmap = (
    <div {...stylex.props(styles.heatmap, rhythm.stack)}>
      {graphic.kind === 'hours' ? (
        <UsageShareHours values={graphic.values} axisGap={rhythm.axis} />
      ) : graphic.kind === 'weekHours' ? (
        <UsageShareWeekHours rows={graphic.rows} axisGap={rhythm.axis} />
      ) : (
        <UsageShareHeatmap
          calendar={calendar}
          lit={stats.litDayStartMs}
          locale={locale}
          axisGap={rhythm.axis}
        />
      )}
      <div {...stylex.props(styles.heatCaption, TEXT.micro)}>
        <span>
          {graphic.kind === 'hours'
            ? t('workspace.usage.shareImage.hoursCaption')
            : graphic.kind === 'weekHours'
              ? t('workspace.usage.shareImage.weekCaption')
              : t('workspace.usage.shareImage.calendarCaption')}
        </span>
        {graphic.kind === 'calendar' && stats.litDayStartMs ? (
          <span>{t('workspace.usage.shareImage.windowLit', { range: rangeLabel })}</span>
        ) : null}
      </div>
    </div>
  );

  /**
   * A sign-off, not a status bar. It borrows the session card's identity-plus-sub
   * structure — who this is, then where it came from — without that card's EXIF
   * parameter line, which would only repeat numbers the bands above already carry.
   * 4:5 stacks the two lines and takes a full-size QR; 16:9 has no height to spare
   * and keeps the single row.
   */
  const footer = (
    <div
      {...stylex.props(
        styles.footer,
        wide ? styles.footerWide : styles.footerPortrait,
        framed ? styles.footerFramed : styles.footerUnframed,
        PAD_X
      )}
    >
      <img src={lodyLogo} alt="" {...stylex.props(wide ? styles.logoMedium : styles.logoLarge)} />
      {wide ? (
        <>
          <div {...stylex.props(styles.footerWorkspace, TEXT.body)}>
            {workspaceName?.trim() || 'Lody'}
          </div>
          <span {...stylex.props(styles.footerDomain, TEXT.meta)}>lody.ai</span>
        </>
      ) : (
        <div {...stylex.props(styles.footerFlex)}>
          <div {...stylex.props(styles.footerWorkspace, TEXT.body)}>
            {workspaceName?.trim() || 'Lody'}
          </div>
          <div {...stylex.props(styles.footerHost, TEXT.meta)}>lody.ai</div>
        </div>
      )}
      {qrDataUrl ? (
        <img
          src={qrDataUrl}
          alt={t('chatShareCard.qrAlt')}
          {...stylex.props(styles.qr, wide ? styles.qrWide : styles.qrPortrait)}
        />
      ) : null}
    </div>
  );

  const card = (
    <div {...stylex.props(styles.card, framed ? styles.cardFramed : styles.cardUnframed)}>
      {wide ? (
        // Two columns: the number and its trio read as one headline on the
        // left, the year and the split as one graphic on the right. Stacking
        // all five blocks vertically does not fit 16:9 without shrinking the
        // heatmap past the point where a single day is still a square.
        <div
          {...stylex.props(styles.cardBand, styles.cardBandWide, rhythm.band, rhythm.padY, PAD_X)}
        >
          {header}
          <div {...stylex.props(styles.heroBand)}>
            {hero}
            <div {...stylex.props(styles.statGroup)}>
              {trioCells.map((cell) => (
                <div key={cell.label} {...stylex.props(styles.statInline)}>
                  <span {...stylex.props(styles.statValue, TEXT.statWide)}>{cell.value}</span>
                  <span {...stylex.props(styles.splitLabel, TEXT.meta)}>{cell.label}</span>
                </div>
              ))}
            </div>
          </div>
          {heatmap}
          <UsageShareSplit
            slices={slices}
            subject={subject}
            compact
            locale={locale}
            formatValue={formatTight}
            split={rhythm.split}
            rows={rhythm.rows}
          />
        </div>
      ) : (
        <div {...stylex.props(styles.cardBand, rhythm.band, rhythm.padY, PAD_X)}>
          {header}
          {/* The headline owns this band alone. The space beside and around it is
              deliberate: see the AGENTS note before filling it with anything. */}
          <div {...stylex.props(styles.cardHeroCenter)}>{hero}</div>
          <div {...stylex.props(styles.statGrid)}>
            {trioCells.map((cell) => (
              <StatCell key={cell.label} {...cell} />
            ))}
          </div>
          {heatmap}
          <UsageShareSplit
            slices={slices}
            subject={subject}
            compact={false}
            locale={locale}
            formatValue={formatTight}
            split={rhythm.split}
            rows={rhythm.rows}
          />
        </div>
      )}
      {onCanvas ? null : footer}
    </div>
  );

  /**
   * The canvas sign-off, printed on the backdrop under the card. Its colours are
   * fixed rather than themed: it sits on a gradient, not on the card surface, so
   * the card's light/dark tokens do not describe what is behind it.
   */
  const canvasSignOff = (
    <div {...stylex.props(styles.canvasSignOff)}>
      <img src={lodyLogo} alt="" {...stylex.props(styles.logoMedium)} />
      <span {...stylex.props(styles.canvasWorkspace, TEXT.body)}>
        {workspaceName?.trim() || 'Lody'}
      </span>
      <span {...stylex.props(styles.canvasDomain, TEXT.meta)}>lody.ai</span>
      {qrDataUrl ? (
        <img src={qrDataUrl} alt={t('chatShareCard.qrAlt')} {...stylex.props(styles.canvasQr)} />
      ) : null}
    </div>
  );

  const rootStyles = stylex.props(
    theme === 'light' ? productLightPalette : theme === 'dark' ? productDarkPalette : undefined,
    theme !== undefined && avatarPaletteTheme,
    styles.root,
    !framed && styles.rootNoFrame,
    onCanvas && styles.rootOnCanvas,
    wide ? styles.rootWide : styles.rootPortrait,
    backdrop !== 'none' && USAGE_SHARE_BACKDROP_STYLES[backdrop]
  );

  return (
    <div
      {...rootStyles}
      className={[rootStyles.className, themeScopeClass, className].filter(Boolean).join(' ')}
    >
      <div {...stylex.props(styles.content)}>{card}</div>
      {onCanvas ? canvasSignOff : null}
    </div>
  );
}
