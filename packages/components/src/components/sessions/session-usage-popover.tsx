import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDistance, type Locale } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import { getServerNow, type SessionContextWindowUsage } from '@lody/shared';
import { Loader2 } from 'lucide-react';

import { Button } from '@/ui/button';
import {
  CodexResetForecastDialogHost,
  CodexResetForecastUsageRow,
} from '@/components/codex-reset/codex-reset-forecast-entry';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Progress } from '@/ui/progress';
import { Separator } from '@/ui/separator';
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
  contextWindowUsage?: SessionContextWindowUsage | null;
  rateLimits?: MachineRateLimits | null;
  agentType: string;
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
  contextWindowUsage,
  rateLimits,
  agentType,
  modelId,
  modelLabel,
  isContextCompacting = false,
  showRateLimitWithoutContext = false,
  showCodexResetForecast = false,
  className,
}: SessionUsagePopoverProps) {
  const { t, i18n } = useTranslation();
  const [isForecastOpen, setIsForecastOpen] = useState(false);
  const locale: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const intlLocale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const context = getContextWindowUsageData(contextWindowUsage);
  const rateLimit = resolveAgentRateLimitForModel({ rateLimits, agentType, modelId });
  const rateLimitWindows = rateLimit
    ? getAgentRateLimitWindows(rateLimit.limits).sort(
        (left, right) => (right.windowDurationSeconds ?? 0) - (left.windowDurationSeconds ?? 0)
      )
    : [];
  const hasRateLimit = rateLimitWindows.length > 0;
  const wallet = rateLimit?.limits.wallet ?? null;
  const hasRateLimitDetails = rateLimit !== null;
  const triggerValue =
    context?.usedPercentage ??
    (showRateLimitWithoutContext ? rateLimitWindows[0]?.usedPercent : undefined);
  const resolvedModelLabel =
    modelLabel?.trim() ||
    rateLimit?.limits.limitName?.trim() ||
    modelId?.trim() ||
    t('sessions.usage.modelFallback', 'Model usage');

  const formatReset = useCallback(
    (resetAtEpochSeconds: number | null | undefined): string | null => {
      if (!resetAtEpochSeconds) return null;
      const epochMs = resetAtEpochSeconds * 1_000;
      const distance = formatDistance(new Date(epochMs), new Date(getServerNow()), {
        addSuffix: true,
        locale,
      });
      return t('machines.rateLimits.resetsAt', 'Resets {{time}}', { time: distance });
    },
    [locale, t]
  );

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
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 select-none gap-1 rounded-md px-1.5 font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
              className
            )}
            aria-label={triggerLabel}
            title={triggerLabel}
          >
            {isContextCompacting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                <span className="text-[11px]">{t('sessions.usage.compacting', 'Compacting')}</span>
              </>
            ) : (
              <>
                <UsageRing value={triggerValue ?? 0} />
                <span className="font-mono text-[11px] tabular-nums">{roundedTriggerValue}%</span>
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          aria-label={t('sessions.usage.title', 'Usage')}
          className="w-[min(17rem,calc(100vw-1rem))] rounded-xl p-3 shadow-lg"
        >
          {isContextCompacting ? (
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t('sessions.usage.context', 'Context')}
              </div>
              <div className="flex items-center gap-2 text-xs text-foreground">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
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
            <Separator className="my-2.5 bg-border/60" />
          ) : null}

          {hasRateLimitDetails ? (
            <div className="space-y-2.5">
              <div className="truncate text-[11px] font-medium text-muted-foreground">
                {resolvedModelLabel}
              </div>
              {hasRateLimit ? (
                rateLimitWindows.map((window, index) => (
                  <UsageMeter
                    key={`${window.windowDurationSeconds ?? 'unknown'}-${index}`}
                    label={formatAgentRateLimitWindowLabel(
                      window,
                      formatWindowLabel(window.windowDurationSeconds),
                      t
                    )}
                    value={window.usedPercent}
                    detail={formatReset(window.resetsAtEpochSeconds)}
                  />
                ))
              ) : (
                <div className="text-xs text-muted-foreground">
                  {t(
                    'sessions.usage.unavailable',
                    'The provider did not report usage for this plan'
                  )}
                </div>
              )}
              {wallet ? (
                <div className="space-y-1 border-t border-border/60 pt-2 text-[11px]">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">
                      {t('sessions.usage.extraBalance', 'Extra usage balance')}
                    </span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(wallet.balanceCents, wallet.currency, i18n.language)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">
                      {t('sessions.usage.monthlySpend', 'Monthly spend')}
                    </span>
                    <span className="font-mono tabular-nums">
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
        </PopoverContent>
      </Popover>
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
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" className="shrink-0">
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="opacity-20"
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
}: {
  label: string;
  value: number;
  detail?: string | null;
}) {
  const { t } = useTranslation();
  const roundedValue = Math.round(value);
  const valueLabel = t('sessions.usage.usedPercent', '{{percent}}% used', {
    percent: roundedValue,
  });

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-[11px] leading-4">
        <span className="font-medium text-foreground/85">{label}</span>
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{valueLabel}</span>
      </div>
      <Progress
        value={value}
        aria-label={`${label}: ${valueLabel}`}
        className="mt-1 h-1 bg-foreground/10 [&>div]:bg-foreground/55"
      />
      {detail ? (
        <div className="mt-1 truncate text-[10px] leading-3.5 text-muted-foreground/75">
          {detail}
        </div>
      ) : null}
    </div>
  );
}
