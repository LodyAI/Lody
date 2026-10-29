import { memo, useCallback, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeftRight } from 'lucide-react';
import { space } from '@lody/ui/tokens/scales.stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { useTranslation } from 'react-i18next';
import { formatDistance, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import { getServerNow, type AgentConfigId, type SessionContextWindowUsage } from '@lody/shared';
import { Spinner } from '@lody/ui/spinner';

import { Button } from '@lody/ui/button';
import {
  CodexResetForecastDialogHost,
  CodexResetForecastUsageRow,
} from '@/components/codex-reset/codex-reset-forecast-entry';
import { Popover } from '@lody/ui/popover';
import { Progress } from '@lody/ui/progress';
import { Separator } from '@lody/ui/separator';
import { formatCompactNumber } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { cn } from '@/lib/utils';
import {
  FIVE_HOUR_WINDOW_SECONDS,
  SEVEN_DAY_WINDOW_SECONDS,
  formatAgentRateLimitWindowLabel,
  formatRateLimitWindowShortLabel,
  getAgentRateLimitWindows,
  getContextWindowUsageData,
  resolveAgentRateLimitForModel,
  type MachineRateLimits,
} from '@/lib/session-usage';

export type SessionUsagePopoverProps = {
  onRefreshQuota?: () => void;
  contextWindowUsage?: SessionContextWindowUsage | null;
  rateLimits?: MachineRateLimits | null;
  agentType: string;
  agentConfigId?: AgentConfigId | null;
  modelId?: string | null;
  modelLabel?: string | null;
  isContextCompacting?: boolean;
  showRateLimitWithoutContext?: boolean;
  /**
   * Eligibility for the third-party Codex reset forecast, decided by the caller
   * from `canShowCodexResetForecast` with the provider's full config. False
   * keeps the row unmounted, so a non-Codex composer makes no request and pays
   * for no clock tick.
   */
  showCodexResetForecast?: boolean;
  className?: string;
};

export const SessionUsagePopover = memo(function SessionUsagePopover({
  onRefreshQuota,
  contextWindowUsage,
  rateLimits,
  agentType,
  agentConfigId,
  modelId,
  modelLabel,
  isContextCompacting = false,
  showRateLimitWithoutContext = false,
  showCodexResetForecast = false,
  className,
}: SessionUsagePopoverProps) {
  const { t, i18n } = useTranslation();
  const [isForecastOpen, setIsForecastOpen] = useState(false);
  const intlLocale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const context = getContextWindowUsageData(contextWindowUsage);
  const rateLimit = resolveAgentRateLimitForModel({
    rateLimits,
    agentType,
    agentConfigId,
    modelId,
  });
  const rateLimitWindows = rateLimit
    ? getAgentRateLimitWindows(rateLimit.limits).sort(
        (left, right) => (right.windowDurationSeconds ?? 0) - (left.windowDurationSeconds ?? 0)
      )
    : [];
  const hasRateLimit = rateLimitWindows.length > 0;
  const wallet = rateLimit?.limits.wallet ?? null;
  const hasRateLimitDetails = rateLimit !== null;
  const triggerRateLimitWindow =
    rateLimitWindows.find((window) => window.windowDurationSeconds === FIVE_HOUR_WINDOW_SECONDS) ??
    rateLimitWindows[0];
  const triggerValue =
    context?.usedPercentage ??
    (showRateLimitWithoutContext ? triggerRateLimitWindow?.usedPercent : undefined);
  const resolvedModelLabel =
    modelLabel?.trim() ||
    rateLimit?.limits.limitName?.trim() ||
    modelId?.trim() ||
    t('sessions.usage.modelFallback', 'Model usage');

  const formatWindowLabel = useCallback(
    (windowDurationSeconds: number | null): string => {
      if (windowDurationSeconds === SEVEN_DAY_WINDOW_SECONDS) {
        return t('sessions.usage.weekly', 'Weekly');
      }
      if (windowDurationSeconds === FIVE_HOUR_WINDOW_SECONDS) {
        return t('sessions.usage.fiveHour', '5 hours');
      }
      if (windowDurationSeconds === null) {
        return t('sessions.usage.limit', 'Usage');
      }
      return formatRateLimitWindowShortLabel(windowDurationSeconds);
    },
    [t]
  );

  if (!isContextCompacting && triggerValue === undefined) return null;

  const roundedTriggerValue = Math.round(triggerValue ?? 0);
  const triggerLabel = isContextCompacting
    ? t('sessions.usage.compactingContext', 'Compacting context')
    : t('sessions.usage.openWithUsed', 'Open usage details, {{percent}}% used', {
        percent: roundedTriggerValue,
      });

  return (
    <>
      <Popover.Root
        onOpenChange={(open) => {
          if (open) onRefreshQuota?.();
        }}
      >
        <Popover.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="small"
              className={cn(
                stylex.props(styles.trigger).className,
                'focus-visible:ring-1 focus-visible:ring-ring',
                className
              )}
              aria-label={triggerLabel}
              title={triggerLabel}
            >
              {isContextCompacting ? (
                <>
                  <Spinner diameter="calc(var(--spacing) * 3.5)" aria-hidden="true" />
                  <span {...stylex.props(styles.tiny)}>
                    {t('sessions.usage.compacting', 'Compacting')}
                  </span>
                </>
              ) : (
                <>
                  <UsageRing value={triggerValue ?? 0} />
                  <span {...stylex.props(styles.mono, styles.tiny)}>{roundedTriggerValue}%</span>
                </>
              )}
            </Button>
          }
        />
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          aria-label={t('sessions.usage.title', 'Usage')}
          className={cn(stylex.props(styles.content).className, 'rounded-xl p-3 shadow-lg')}
        >
          {isContextCompacting ? (
            <div>
              <div {...stylex.props(styles.sectionLabel, styles.stack2)}>
                {t('sessions.usage.context', 'Context')}
              </div>
              <div {...stylex.props(styles.compacting)}>
                <Spinner diameter="calc(var(--spacing) * 3.5)" className="text-muted-foreground" />
                <span>{t('sessions.usage.compactingContext', 'Compacting context')}</span>
              </div>
            </div>
          ) : context ? (
            <UsageMeter
              label={t('sessions.usage.context', 'Context')}
              value={context.usedPercentage}
              detail={`${formatCompactNumber(context.usedTokens, intlLocale)} / ${formatCompactNumber(
                context.contextWindow,
                intlLocale
              )}`}
            />
          ) : null}

          {(context || isContextCompacting) && hasRateLimitDetails ? (
            <Separator {...stylex.props(styles.separator)} />
          ) : null}

          {hasRateLimitDetails ? (
            <div>
              <div {...stylex.props(styles.sectionLabel, styles.truncate, styles.stack25)}>
                {resolvedModelLabel}
              </div>
              {hasRateLimit ? (
                rateLimitWindows.map((window, index) => (
                  <UsageMeter
                    key={`${window.windowDurationSeconds ?? 'unknown'}-${index}`}
                    className={stylex.props(styles.stack25).className}
                    label={formatAgentRateLimitWindowLabel(
                      window,
                      formatWindowLabel(window.windowDurationSeconds),
                      t
                    )}
                    value={window.usedPercent}
                    detail={
                      window.resetsAtEpochSeconds ? (
                        <ResetTime epochSeconds={window.resetsAtEpochSeconds} />
                      ) : null
                    }
                  />
                ))
              ) : (
                <div {...stylex.props(styles.unavailable, styles.stack25)}>
                  {t(
                    'sessions.usage.unavailable',
                    'The provider did not report usage for this plan'
                  )}
                </div>
              )}
              {wallet ? (
                <div {...stylex.props(styles.wallet, styles.stack25)}>
                  <div {...stylex.props(styles.walletRow, styles.stack1)}>
                    <span {...stylex.props(styles.muted)}>
                      {t('sessions.usage.extraBalance', 'Extra usage balance')}
                    </span>
                    <span {...stylex.props(styles.mono)}>
                      {formatMoney(wallet.balanceCents, wallet.currency, i18n.language)}
                    </span>
                  </div>
                  <div {...stylex.props(styles.walletRow, styles.stack1)}>
                    <span {...stylex.props(styles.muted)}>
                      {t('sessions.usage.monthlySpend', 'Monthly spend')}
                    </span>
                    <span {...stylex.props(styles.mono)}>
                      {formatMoney(wallet.monthlyUsedCents, wallet.currency, i18n.language)}
                      {wallet.monthlyChargeLimitEnabled
                        ? ` / ${formatMoney(
                            wallet.monthlyChargeLimitCents,
                            wallet.currency,
                            i18n.language
                          )}`
                        : ''}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Codex only, and only while a forecast is in force: why the limits
            above may reset sooner than their own countdown suggests. */}
          <CodexResetForecastUsageRow
            enabled={showCodexResetForecast}
            onOpen={() => setIsForecastOpen(true)}
          />
        </Popover.Content>
      </Popover.Root>
      {/* Hosted outside the popover on purpose: opening the dialog dismisses the
          popover, which would unmount a dialog rendered inside its content. */}
      <CodexResetForecastDialogHost
        enabled={showCodexResetForecast}
        open={isForecastOpen}
        onOpenChange={setIsForecastOpen}
      />
    </>
  );
});

function formatMoney(cents: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency || 'USD',
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || 'USD'}`;
  }
}

function UsageRing({ value }: { value: number }) {
  const percentage = Math.min(100, Math.max(0, value));
  const radius = 5;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      {...stylex.props(styles.shrink)}
    >
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        {...stylex.props(styles.ringTrack)}
      />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percentage / 100)}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

function UsageMeter({
  label,
  value,
  detail,
  className,
}: {
  className?: string;
  label: string;
  value: number;
  detail?: ReactNode;
}) {
  const { t } = useTranslation();
  const roundedValue = Math.round(value);
  const valueLabel = t('sessions.usage.usedPercent', '{{percent}}% used', {
    percent: roundedValue,
  });

  return (
    <div className={cn(stylex.props(styles.meter).className, className)}>
      <div {...stylex.props(styles.meterRow)}>
        <span {...stylex.props(styles.meterLabel)}>{label}</span>
        <span {...stylex.props(styles.shrink, styles.mono, styles.muted)}>{valueLabel}</span>
      </div>
      <Progress
        value={value}
        tone="neutral"
        aria-label={`${label}: ${valueLabel}`}
        {...stylex.props(styles.progress)}
      />
      {detail ? <div {...stylex.props(styles.detail)}>{detail}</div> : null}
    </div>
  );
}

const styles = stylex.create({
  trigger: { userSelect: 'none' },
  content: { width: 'min(17rem, calc(100vw - 1rem))' },
  tiny: { fontSize: '11px' },
  mono: {
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontVariantNumeric: 'tabular-nums',
  },
  muted: { color: themeColors.mutedForeground },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stack1: {
    marginBlockStart: { default: null, ':not(:last-child)': 0 },
    marginBlockEnd: { default: null, ':not(:last-child)': themeSpace[1] },
  },
  stack2: {
    marginBlockStart: { default: null, ':not(:last-child)': 0 },
    marginBlockEnd: { default: null, ':not(:last-child)': themeSpace[2] },
  },
  stack25: {
    marginBlockStart: { default: null, ':not(:last-child)': 0 },
    marginBlockEnd: { default: null, ':not(:last-child)': themeSpace[2.5] },
  },
  sectionLabel: {
    fontSize: '11px',
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
  },
  compacting: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.foreground,
  },
  separator: { marginBlock: themeSpace[2.5] },
  unavailable: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  wallet: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.6)',
    paddingTop: themeSpace[2],
    fontSize: '11px',
  },
  walletRow: { display: 'flex', justifyContent: 'space-between', gap: themeSpace[3] },
  shrink: { flexShrink: 0 },
  ringTrack: { opacity: 0.2 },
  meter: { minWidth: 0 },
  meterRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: themeSpace[3],
    fontSize: '11px',
    lineHeight: themeSpace[4],
  },
  meterLabel: { fontWeight: themeFontWeight.medium, color: 'hsl(var(--foreground) / 0.85)' },
  progress: { marginTop: themeSpace[1] },
  detail: {
    marginTop: themeSpace[1],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '10px',
    lineHeight: themeSpace[3.5],
    color: 'hsl(var(--muted-foreground) / 0.75)',
  },
});
const resetTimeStyles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[1],
  },
  text: {
    minWidth: 0,
    whiteSpace: 'normal',
  },
});

function ResetTime({ epochSeconds }: { epochSeconds: number }) {
  const { t, i18n } = useTranslation();
  const [absolute, setAbsolute] = useState(false);
  const locale: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const date = new Date(epochSeconds * 1_000);
  const time = absolute
    ? new Intl.DateTimeFormat(toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
    : formatDistance(date, new Date(getServerNow()), { addSuffix: true, locale });
  const resetTime = locale === zhCN && /^\d/.test(time) ? ` ${time}` : time;
  const toggleLabel = absolute
    ? t('sessions.usage.showRelativeTime', 'Show relative time')
    : t('sessions.usage.showAbsoluteTime', 'Show absolute time');

  return (
    <div {...stylex.props(resetTimeStyles.row)}>
      <span {...stylex.props(resetTimeStyles.text)}>
        {t('machines.rateLimits.resetsAt', 'Resets {{time}}', { time: resetTime })}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="mini"
        icon
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={() => setAbsolute((value) => !value)}
      >
        <ArrowLeftRight size={12} aria-hidden="true" />
      </Button>
    </div>
  );
}
