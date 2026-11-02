import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronsUpDown, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Menu } from '@lody/ui/menu';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { formatDistance, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import type { HomeWeekForecast, HomeWeekUsage, HomeWeekUsageSource } from '@/lib/home-week-usage';
import {
  formatAgentRateLimitWindowLabel,
  formatRateLimitWindowDurationLabel,
  type AgentRateLimitWindow,
} from '@/lib/session-usage';

/*
 * What the new-chat page's two boards share: the flat tile in the well material, its label,
 * figure and note, the rolling count, and the plan usage with the Codex reset beside it. Each
 * board places its tiles by hand (`TileArea`), never by auto-flow, so the bento stays uneven.
 */

const MOTION = '@media (prefers-reduced-motion: no-preference)';
const COUNT_UP_MS = 600;

const growAcross = stylex.keyframes({
  from: { transform: 'scaleX(0)' },
  to: { transform: 'scaleX(1)' },
});

export const tileStyles = stylex.create({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: space[1.5],
    width: '100%',
    margin: 0,
    padding: 0,
  },
  tile: {
    display: 'flex',
    boxSizing: 'border-box',
    flexDirection: 'column',
    justifyContent: 'space-between',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    padding: '10px',
    borderRadius: radius.large,
    backgroundColor: colors.secondaryBackground,
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space[2],
    minWidth: 0,
    marginBottom: space[2],
  },
  // Tile text is `label` or `secondaryLabel`, never `tertiaryLabel`: on the well it is too faint.
  label: {
    margin: 0,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  value: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[1],
    margin: 0,
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  unit: {
    fontSize: text.footnoteSize,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  note: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.captionSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  track: {
    display: 'flex',
    height: '3px',
    borderRadius: '99px',
    backgroundColor: colors.trayBackground,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: colors.accent,
    transformOrigin: 'left',
    animationName: growAcross,
    animationDuration: { default: '0s', [MOTION]: '500ms' },
    animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    animationFillMode: 'backwards',
  },
  name: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  /** Read aloud, not shown. */
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
  /** Whose plan this is: an outlined control, so it reads as a choice and not as a label. */
  source: {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    flexShrink: 0,
    minWidth: 0,
    maxWidth: '75%',
    margin: 0,
    // paddingBlock: '2px',
    // paddingInline: space[2],
    // borderWidth: 1,
    // borderStyle: 'solid',
    // borderColor: { default: colors.separator, ':hover': colors.tertiaryLabel },
    // borderRadius: radius.small,
    backgroundColor: 'transparent',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 2px ${colors.accent}` },
    outlineStyle: 'none',
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    color: colors.label,
    cursor: 'pointer',
  },
  sourceStatic: {
    cursor: 'default',
    borderColor: { default: colors.separator, ':hover': colors.separator },
  },
  sourceName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sourceChevron: { flexShrink: 0, width: '12px', height: '12px', color: colors.secondaryLabel },
  sourceIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    color: colors.secondaryLabel,
    width: '12px',
    height: '12px',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The small mark that says where the reset data comes from. */
  info: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: 'transparent',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 2px ${colors.accent}` },
    outlineStyle: 'none',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    cursor: 'help',
  },
  infoGlyph: { width: '13px', height: '13px' },
  /** One window. A plain column: the tile's space-between sets it on the tile's floor. */
  meter: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  meterHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[2],
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  meterUsed: { flexShrink: 0, color: colors.label },
});

/** Grid lines for one tile, written by its board. */
export type TileArea = { column: string; row: string };

/** A board's row floors, in multiples of the interface font size: minimums, never heights. */
export function gridRows(floors: readonly number[]): string {
  return floors
    .map((floor) => `minmax(calc(var(--ui-font-size, 14px) * ${floor}), auto)`)
    .join(' ');
}

/** A tile at its grid cell, or, without `area`, wherever its parent puts it (a stacked column). */
export function Tile({
  area,
  testId,
  children,
  onPress,
  pressProps,
}: {
  area?: TileArea;
  testId?: string;
  children: ReactNode;
  /** The whole tile as one press, for a tile that opens something (the "now" lists). */
  onPress?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Looks beside the press, e.g. the pointer cursor on a tile that can open. */
  pressProps?: stylex.StyleXStyles | false | null;
}) {
  const { className, style } = stylex.props(tileStyles.tile, pressProps);
  return (
    <div
      data-testid={testId}
      data-column={area?.column}
      data-row={area?.row}
      onClick={onPress}
      className={className}
      style={area ? { ...style, gridColumn: area.column, gridRow: area.row } : style}
    >
      {children}
    </div>
  );
}

/** `zh_CN` is the app's language tag; `Intl` wants `zh-CN`. */
export function toIntlLocale(language: string): string {
  return language.replace('_', '-');
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * Counts a number up from zero the first time it is shown, and again when real data
 * arrives after zeros (the metadata loads after the page). Live changes after that move
 * the number without rolling it; reduced motion, or `animate` off, shows the value at once.
 */
function useCountUp(target: number, animate: boolean): number {
  const [shown, setShown] = useState(animate ? 0 : target);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    const rolls =
      (previous.current === null || previous.current === 0) &&
      target > 0 &&
      animate &&
      !prefersReducedMotion();
    previous.current = target;
    if (!rolls) {
      setShown(target);
      return undefined;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      setShown(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, animate]);

  return shown;
}

export function Count({
  value,
  animate,
  format,
}: {
  value: number;
  animate: boolean;
  format: (value: number) => string;
}) {
  return <span data-count={value}>{format(useCountUp(value, animate))}</span>;
}

/** "Resets in about 2 hours", counted from `nowMs`. */
export function useFormatReset(nowMs: number) {
  const { t, i18n } = useTranslation();
  const dateLocale: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  return (resetsAtEpochSeconds: number | null): string | null =>
    resetsAtEpochSeconds
      ? t('machines.rateLimits.resetsAt', 'Resets {{time}}', {
          time: formatDistance(new Date(resetsAtEpochSeconds * 1_000), new Date(nowMs), {
            addSuffix: true,
            locale: dateLocale,
          }),
        })
      : null;
}

function UsageMeter({
  window,
  formatReset,
}: {
  window: AgentRateLimitWindow;
  formatReset: (resetsAtEpochSeconds: number | null) => string | null;
}) {
  const { t } = useTranslation();
  const used = t('sessions.usage.usedPercent', '{{percent}}% used', {
    percent: Math.round(window.usedPercent),
  });
  const name = formatAgentRateLimitWindowLabel(
    window,
    formatRateLimitWindowDurationLabel(window.windowDurationSeconds, t),
    t
  );
  return (
    <div {...stylex.props(tileStyles.meter)}>
      <p {...stylex.props(tileStyles.meterHead)}>
        <span {...stylex.props(tileStyles.name)}>{name}</span>
        <span {...stylex.props(tileStyles.meterUsed)}>{used}</span>
      </p>
      <div role="img" aria-label={`${name}: ${used}`} {...stylex.props(tileStyles.track)}>
        <i
          data-usage-fill={0}
          {...stylex.props(tileStyles.fill)}
          style={{ width: `${Math.round(window.usedPercent)}%` }}
        />
      </div>
      <p {...stylex.props(tileStyles.note)}>{formatReset(window.resetsAtEpochSeconds)}</p>
    </div>
  );
}

export type AgentIconRenderer = (agent: { cliType: string; agentType: string }) => ReactNode;

/**
 * Whose plan the usage tile shows: the provider's mark and name in an outlined control. With
 * several providers on the machine it opens a list to pick another; with one it is the same
 * outline, minus the chevron and the menu, so the tile always says whose plan it is.
 */
function UsageSourcePicker({
  sources,
  source,
  agentIcon,
  onChange,
}: {
  sources: readonly HomeWeekUsageSource[];
  source: HomeWeekUsageSource;
  agentIcon?: AgentIconRenderer;
  onChange?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const face = (
    <>
      {agentIcon ? (
        <span aria-hidden="true" {...stylex.props(tileStyles.sourceIcon)}>
          {agentIcon(source)}
        </span>
      ) : null}
      <span {...stylex.props(tileStyles.sourceName)}>{source.name}</span>
    </>
  );
  if (sources.length < 2 || !onChange) {
    return (
      <span
        data-testid="home-week-usage-source"
        {...stylex.props(tileStyles.source, tileStyles.sourceStatic)}
      >
        {face}
      </span>
    );
  }
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="home-week-usage-source"
        aria-label={t('home.week.usageSource', 'Show plan usage for')}
        render={<button type="button" {...stylex.props(tileStyles.source)} />}
      >
        {face}
        <ChevronsUpDown aria-hidden="true" {...stylex.props(tileStyles.sourceChevron)} />
      </Menu.Trigger>
      <Menu.Content align="start" width="compact">
        <Menu.RadioGroup value={source.id} onValueChange={(value) => onChange(String(value))}>
          {sources.map((candidate) => (
            <Menu.RadioItem
              key={candidate.id}
              value={candidate.id}
              closeOnClick
              icon={agentIcon ? agentIcon(candidate) : undefined}
              indicator="check"
              indicatorSide="end"
            >
              {candidate.name}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}

/** The plan usage a board shows, and how to pick whose. */
export type UsageProps = {
  /** The chosen provider's subscription windows; only the shortest is drawn. */
  usage?: HomeWeekUsage | null;
  usageSources?: readonly HomeWeekUsageSource[];
  usageSourceId?: string | null;
  onUsageSourceChange?: (id: string) => void;
  /** A Codex reset that is forecast or scheduled, in a tile of its own beside the usage. */
  forecast?: HomeWeekForecast | null;
};

/**
 * The chosen provider's shortest window, and beside it, when the forecast knows one, the Codex
 * reset as a tile of its own (never squeezed into the usage). Without a reset the usage takes
 * `wide`. Renders nothing without usage: the board decides what takes the space.
 */
export function UsageTiles({
  usage = null,
  usageSources = [],
  usageSourceId = null,
  onUsageSourceChange,
  forecast = null,
  agentIcon,
  nowMs,
  areas,
}: UsageProps & {
  agentIcon?: AgentIconRenderer;
  nowMs: number;
  areas: { usage: TileArea; side: TileArea; wide: TileArea };
}) {
  const { t } = useTranslation();
  const formatReset = useFormatReset(nowMs);
  if (!usage) return null;
  const hasSide = forecast != null;
  const usageSource = usageSources.find((candidate) => candidate.id === usageSourceId) ?? null;
  const forecastSource = t(
    'home.week.forecastSource',
    'Third-party forecast from codex-resets.com, loaded when this page opens. No account data is sent. For reference only.'
  );
  return (
    <>
      <Tile area={hasSide ? areas.usage : areas.wide} testId="home-week-usage">
        <div {...stylex.props(tileStyles.head)}>
          {usageSource ? (
            <UsageSourcePicker
              sources={usageSources}
              source={usageSource}
              agentIcon={agentIcon}
              onChange={onUsageSourceChange}
            />
          ) : null}
          {!usageSource || !hasSide ? (
            <p {...stylex.props(tileStyles.label)}>
              {usage.name
                ? t('home.week.usageNamed', 'Plan usage · {{name}}', { name: usage.name })
                : t('home.week.usage', 'Plan usage')}
            </p>
          ) : null}
        </div>
        <UsageMeter window={usage.windows[0]!} formatReset={formatReset} />
      </Tile>

      {forecast ? (
        <Tile area={areas.side} testId="home-week-forecast">
          <div {...stylex.props(tileStyles.head)}>
            <p {...stylex.props(tileStyles.label)}>{forecast.title}</p>
            <Tooltip.Root>
              <Tooltip.Trigger
                data-testid="home-week-forecast-source"
                aria-label={forecastSource}
                render={<button type="button" {...stylex.props(tileStyles.info)} />}
              >
                <Info aria-hidden="true" {...stylex.props(tileStyles.infoGlyph)} />
              </Tooltip.Trigger>
              <Tooltip.Content side="top">{forecastSource}</Tooltip.Content>
            </Tooltip.Root>
          </div>
          {forecast.chancePercent != null ? (
            <p {...stylex.props(tileStyles.value)}>
              {forecast.chancePercent}%
              <span {...stylex.props(tileStyles.unit)}>
                {t('home.week.forecastChance', 'chance')}
              </span>
            </p>
          ) : null}
          <p {...stylex.props(tileStyles.note)}>{forecast.when}</p>
        </Tile>
      ) : null}
    </>
  );
}
