import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { cn } from '@/lib/utils';
import { formatCompactNumber, formatUsdAmount } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { ensureShareThemeScopes } from '@/components/share-theme-scope';
import { ModelBrandIcon } from '@/components/icons/model-brand-icon';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import lodyLogo from '@/assets/lody-icon.png';
import { createUsageHeatScale, type UsageCalendarModel } from './usage-calendar-model';
import type { UsageShareSlice, UsageShareStats } from './usage-share-stats';

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
 * These are the whole exported image, backdrop included — so a framed card is
 * 48px shorter than an unframed one, and the layout has to fit the framed case
 * because a backdrop is the default. Both were sized up until the framed
 * variant has real headroom rather than landing flush against its footer.
 */
const ASPECT_SIZE: Record<UsageShareCardAspect, { width: number; height: number }> = {
  portrait: { width: 576, height: 720 },
  wide: { width: 704, height: 396 },
};

export const USAGE_SHARE_BACKDROP_STYLES: Record<
  Exclude<UsageShareCardBackdrop, 'none'>,
  CSSProperties
> = {
  lody: {
    background:
      'radial-gradient(52% 38% at 18% 12%, rgba(53,200,176,0.45), transparent 70%),' +
      'radial-gradient(48% 36% at 86% 16%, rgba(47,119,191,0.5), transparent 70%),' +
      'radial-gradient(70% 55% at 68% 96%, rgba(31,79,127,0.65), transparent 75%),' +
      'radial-gradient(120% 100% at 50% 50%, transparent 55%, rgba(2,10,18,0.55) 100%),' +
      'linear-gradient(165deg, #0a1c2b 0%, #0c2438 55%, #081626 100%)',
  },
  aurora: { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 45%, #db2777 100%)' },
  ocean: { background: 'linear-gradient(135deg, #0369a1 0%, #0891b2 50%, #34d399 100%)' },
  sunset: { background: 'linear-gradient(135deg, #9a3412 0%, #ea580c 45%, #f59e0b 100%)' },
};

export interface UsageShareCardProps {
  /** 53-week calendar behind the heatmap. Always the full year, at every range. */
  calendar: UsageCalendarModel;
  stats: UsageShareStats;
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
  /**
   * Adds the range's USD spend beside the hero number. Off unless the user asks
   * for it: a workspace's spend is nobody else's business by default.
   */
  showCost?: boolean;
  shareUrl?: string;
  showQr?: boolean;
  /** Pins the exported palette instead of following the app's current theme. */
  theme?: 'light' | 'dark';
  className?: string;
  onAssetsReadyChange?: (ready: boolean) => void;
}

const DEFAULT_SHARE_URL = 'https://lody.ai';

/**
 * The card's whole type scale. Every text node picks a role from here rather
 * than an arbitrary size: an exported image has no hover state or tooltip to
 * recover a hierarchy that half-pixel steps blur away, and two cards taken a
 * month apart must set the same words at the same size.
 */
const TEXT = {
  /** The one number the card exists to deliver. */
  hero: 'text-[54px]',
  heroWide: 'text-[32px]',
  /** Headline cell values. */
  stat: 'text-[20px]',
  statWide: 'text-[15px]',
  /** Brand, unit, workspace — anything read before the details. */
  body: 'text-[13px]',
  /** Cell labels, legend rows, the range chip. */
  meta: 'text-[11px]',
  /** Month ticks and the heatmap caption. */
  micro: 'text-[10px]',
} as const;

/**
 * Horizontal padding is one value for every band including the footer, so the
 * brand mark, the hero, the heatmap and the workspace name all share a left
 * edge. Vertical padding differs by format because only the height budget does.
 */
const PAD_X = 'px-6';

/**
 * Vertical rhythm is the one thing the two formats may disagree about, because
 * only their height budget differs: 4:5 has room to breathe between bands, 16:9
 * has to fit the same five bands into 40% of the height. Declared here as two
 * rows rather than sprinkled per element, so "the wide card is tighter" stays a
 * single decision. Every value is on the same 4px grid.
 */
const RHYTHM: Record<
  UsageShareCardAspect,
  { band: string; padY: string; stack: string; split: string; rows: string; axis: string }
> = {
  portrait: {
    band: 'gap-5',
    padY: 'pt-6 pb-6',
    stack: 'space-y-2',
    // The 100% bar summarises the legend, so it needs a group-sized gap. At the
    // row gap it reads as the list's first item instead of its summary.
    split: 'space-y-4',
    rows: 'space-y-2',
    axis: 'mb-2',
  },
  wide: {
    band: 'gap-3',
    padY: 'pt-3 pb-3',
    stack: 'space-y-1',
    split: 'space-y-2',
    rows: 'space-y-1',
    axis: 'mb-1',
  },
};

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
  axisGap: string;
}) {
  const scale = createUsageHeatScale(calendar);
  const width = HEAT_COLUMNS * (HEAT_CELL + HEAT_GAP) - HEAT_GAP;
  const height = HEAT_ROWS * (HEAT_CELL + HEAT_GAP) - HEAT_GAP;
  return (
    <div>
      {/* Labels live in HTML, not in the SVG: the grid scales to its column and
          SVG text would scale with it, so the two formats would disagree. */}
      <div className={cn('relative h-[12px]', axisGap)}>
        {monthTicks(calendar, locale).map((tick) => (
          <span
            key={tick.column}
            className={cn('absolute top-0 leading-none text-muted-foreground/70', TEXT.micro)}
            style={{ left: `${(tick.column / HEAT_COLUMNS) * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full" role="presentation">
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

/**
 * The range's profile as plain bars. Rendered in HTML rather than SVG so the bars
 * keep square corners and exact gaps at any width — a stretched `viewBox` would
 * distort both. A quiet bucket keeps a stub so "no usage" stays distinguishable
 * from "a little usage" instead of vanishing into the baseline.
 */
function UsageShareRangeShape({ values }: { values: number[] }) {
  if (values.length === 0) return null;
  const max = Math.max(...values);
  if (max <= 0) return null;
  return (
    <div className="flex h-[64px] items-end gap-px border-b border-border/60 pb-px">
      {values.map((value, index) => (
        <div
          key={index}
          className="min-w-0 flex-1 rounded-t-[1px]"
          style={{
            height: value > 0 ? `${Math.max(6, (value / max) * 100)}%` : '2px',
            backgroundColor:
              value > 0 ? 'hsl(var(--chart-1) / 0.62)' : 'hsl(var(--muted-foreground) / 0.22)',
          }}
        />
      ))}
    </div>
  );
}

/** 100% bar + legend. One shape for models and members; only the mark differs. */
function UsageShareSplit({
  slices,
  subject,
  compact,
  locale,
  formatTokens,
  split,
  rows: rowGap,
}: {
  slices: UsageShareSlice[];
  subject: UsageShareCardSubject;
  compact: boolean;
  locale: string;
  formatTokens: (value: number) => string;
  /** Bar-to-legend gap and row-to-row gap, from the format's rhythm. */
  split: string;
  rows: string;
}) {
  if (slices.length === 0) return null;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const rows = compact ? slices.slice(0, 2) : slices;
  return (
    <div className={cn('shrink-0', split)}>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]">
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
      <div className={compact ? 'flex flex-wrap gap-x-4 gap-y-2' : rowGap}>
        {rows.map((slice, index) => (
          <div key={slice.id} className="flex min-w-0 items-center gap-2">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: `hsl(var(--chart-${(index % 5) + 1}))` }}
            />
            {subject === 'team' ? (
              <Avatar className="size-4 shrink-0">
                {slice.image ? <AvatarImage src={slice.image} alt="" /> : null}
                <AvatarFallback className="text-[8px]">
                  {slice.label.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            ) : (
              <ModelBrandIcon modelId={slice.id} className="size-3.5 shrink-0" />
            )}
            <span className={cn('min-w-0 truncate text-muted-foreground', TEXT.meta)}>
              {slice.label}
            </span>
            {/* Percent alone hides scale: 52% of a quiet week and of a heavy
                month are not the same fact, so the row carries both. */}
            {compact ? null : (
              <span
                className={cn('ml-auto shrink-0 tabular-nums text-muted-foreground/80', TEXT.meta)}
              >
                {formatTokens(slice.tokens)}
              </span>
            )}
            <span
              className={cn(
                'shrink-0 text-right font-semibold tabular-nums text-foreground',
                TEXT.meta,
                compact ? 'ml-auto' : 'ml-4 w-10'
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
    <div className="min-w-0">
      <div
        className={cn('truncate font-semibold leading-none tabular-nums text-foreground', TEXT.stat)}
      >
        {value}
      </div>
      <div className={cn('mt-1 truncate leading-tight text-muted-foreground', TEXT.meta)}>
        {label}
      </div>
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
  modelSlices,
  memberSlices,
  rangeLabel,
  workspaceName,
  aspect = 'portrait',
  subject = 'personal',
  backdrop = 'lody',
  showCost = false,
  shareUrl = DEFAULT_SHARE_URL,
  showQr = true,
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
  const size = ASPECT_SIZE[aspect];
  const rhythm = RHYTHM[aspect];
  const framed = backdrop !== 'none';
  const slices = subject === 'team' ? memberSlices : modelSlices;
  const compact = (value: number) => formatCompactNumber(value, locale);

  // Same four facts at every range, only the unit changes: how often, how
  // consistently, how much on a typical unit, how much at the best one.
  const allCells =
    stats.trio === 'interval'
      ? [
          { label: t('workspace.usage.skyline.activeIntervals'), value: String(stats.activeCount) },
          { label: t('workspace.usage.skyline.longestStreak'), value: String(stats.longestStreak) },
          {
            label: t('workspace.usage.skyline.averagePerInterval'),
            value: compact(stats.average),
          },
          { label: t('workspace.usage.skyline.peakInterval'), value: compact(stats.peak) },
        ]
      : [
          { label: t('workspace.usage.skyline.activeDays'), value: String(stats.activeCount) },
          { label: t('workspace.usage.skyline.longestStreak'), value: String(stats.longestStreak) },
          { label: t('workspace.usage.skyline.dailyAverage'), value: compact(stats.average) },
          { label: t('workspace.usage.skyline.peakDay'), value: compact(stats.peak) },
        ];
  // 16:9 puts the cells on the hero's baseline, where a fourth would not fit.
  const trioCells = wide ? allCells.slice(0, 3) : allCells;

  const heroValue = (
    <span
      className={cn(
        'whitespace-nowrap font-bold leading-none tracking-tight tabular-nums text-foreground',
        wide ? TEXT.heroWide : TEXT.hero
      )}
    >
      {compact(stats.totalTokens)}
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

  const heroUnits = (
    <>
      <span className={cn('font-medium text-muted-foreground', TEXT.body)}>
        {t('workspace.usage.tokens')}
      </span>
      {showCost ? (
        <span className={cn('font-semibold tabular-nums text-foreground/80', TEXT.body)}>
          {formatUsdAmount(stats.totalCostUSD, locale, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </span>
      ) : null}
    </>
  );

  // Portrait stacks the unit under the number; wide sets it on the same
  // baseline, because 16:9 pays for every row of height.
  const hero = wide ? (
    <div className="flex min-w-0 items-baseline gap-2">
      {heroValue}
      {heroUnits}
    </div>
  ) : (
    <div className="min-w-0">
      {heroValue}
      <div className="mt-2 flex items-baseline gap-2">{heroUnits}</div>
      <div className={cn('mt-2 tabular-nums text-muted-foreground/80', TEXT.meta)}>
        {periodDates}
      </div>
    </div>
  );

  const header = (
    <div className="flex shrink-0 items-center gap-2">
      <img src={lodyLogo} alt="" className="size-4 scale-[1.64] rounded-md" />
      <span className={cn('font-semibold text-foreground', TEXT.body)}>Lody</span>
      <span
        className={cn(
          'ml-auto rounded-full border border-border/70 px-2 py-1 font-medium leading-none text-muted-foreground',
          TEXT.meta
        )}
      >
        {rangeLabel}
      </span>
    </div>
  );

  const heatmap = (
    <div className={cn('shrink-0', rhythm.stack)}>
      <UsageShareHeatmap
        calendar={calendar}
        lit={stats.litDayStartMs}
        locale={locale}
        axisGap={rhythm.axis}
      />
      <div
        className={cn(
          'flex items-center justify-between text-muted-foreground/80',
          TEXT.micro
        )}
      >
        <span>{t('workspace.usage.shareImage.calendarCaption')}</span>
        {stats.litDayStartMs ? (
          <span>{t('workspace.usage.shareImage.windowLit', { range: rangeLabel })}</span>
        ) : null}
      </div>
    </div>
  );

  const footer = (
    <div
      className={cn(
        'relative mt-auto flex items-center gap-2 border-t py-3',
        PAD_X,
        framed
          ? 'border-border bg-white dark:bg-white/[0.04]'
          : 'border-black/[0.06] dark:border-white/[0.08]'
      )}
    >
      <img src={lodyLogo} alt="" className="size-5 scale-[1.64] rounded-md" />
      <div className={cn('min-w-0 truncate font-semibold text-foreground', TEXT.body)}>
        {workspaceName?.trim() || 'Lody'}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className={cn('font-medium text-muted-foreground', TEXT.meta)}>lody.ai</span>
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt={t('chatShareCard.qrAlt')}
            className="size-8 rounded-[3px] bg-white p-1 dark:bg-white/90"
          />
        ) : null}
      </div>
    </div>
  );

  const card = (
    <div
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden text-card-foreground',
        framed
          ? 'rounded-2xl border border-black/[0.06] bg-card shadow-[0_24px_64px_-16px_rgba(0,0,0,0.45)] dark:border-white/10'
          : 'border border-black/[0.08] bg-card dark:border-white/[0.09]'
      )}
    >
      {wide ? (
        // Two columns: the number and its trio read as one headline on the
        // left, the year and the split as one graphic on the right. Stacking
        // all five blocks vertically does not fit 16:9 without shrinking the
        // heatmap past the point where a single day is still a square.
        <div
          className={cn(
            'relative flex min-h-0 flex-1 flex-col justify-between',
            rhythm.band,
            rhythm.padY,
            PAD_X
          )}
        >
          {header}
          <div className="flex items-baseline gap-4">
            {hero}
            <div className="ml-auto flex shrink-0 items-baseline gap-4">
              {trioCells.map((cell) => (
                <div key={cell.label} className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'font-semibold leading-none tabular-nums text-foreground',
                      TEXT.statWide
                    )}
                  >
                    {cell.value}
                  </span>
                  <span className={cn('text-muted-foreground', TEXT.meta)}>{cell.label}</span>
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
            formatTokens={compact}
            split={rhythm.split}
            rows={rhythm.rows}
          />
        </div>
      ) : (
        <div className={cn('relative flex min-h-0 flex-1 flex-col', rhythm.band, rhythm.padY, PAD_X)}>
          {header}
          {/* The headline and the shape of what it counts, side by side. The
              profile takes the void beside the number rather than a decoration
              standing in for content. */}
          <div className="my-auto flex items-end gap-6">
            {hero}
            <div className="min-w-0 flex-1">
              <UsageShareRangeShape values={stats.shape} />
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-4 gap-4 border-y border-border/60 py-3">
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
            formatTokens={compact}
            split={rhythm.split}
            rows={rhythm.rows}
          />
        </div>
      )}
      {footer}
    </div>
  );

  return (
    <div
      className={cn('flex', themeScopeClass, framed ? 'p-6' : '', className)}
      style={{ width: size.width, height: size.height, ...(framed ? USAGE_SHARE_BACKDROP_STYLES[backdrop] : {}) }}
    >
      {card}
    </div>
  );
}
