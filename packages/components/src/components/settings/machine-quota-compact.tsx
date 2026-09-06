import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineViewMeta } from '@lody/shared';
import {
  CODEX_SPARK_LIMIT_ID,
  normalizePersistedRateLimit,
  parseRateLimitEntryKey,
} from '@lody/shared';
import { formatDistanceToNow, type Locale } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import { AnthropicIcon } from '@/components/icons/anthropic-icon';
import { OpenAIIcon } from '@/components/icons/openai-icon';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
import {
  FIVE_HOUR_WINDOW_SECONDS,
  SEVEN_DAY_WINDOW_SECONDS,
  formatAgentRateLimitWindowLabel,
  formatRateLimitWindowShortLabel,
  getAgentRateLimitWindows,
} from '@/lib/session-usage';

type MachineUsageData = MachineViewMeta['raceLimits'][string];

export type MachineQuotaCompactProps = {
  raceLimits: Record<string, MachineUsageData> | undefined;
  /** Filter to a specific cliType, e.g. 'claude' or 'codex'. Omitted shows all. */
  filterCliType?: string;
};

export function MachineQuotaCompact({ raceLimits, filterCliType }: MachineQuotaCompactProps) {
  const { t, i18n } = useTranslation();
  const localeObj: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const entries = useMemo(
    () =>
      Object.entries(raceLimits ?? {})
        .flatMap(([rawKey, value]) => {
          const parsed = parseRateLimitEntryKey(rawKey);
          const limits = normalizePersistedRateLimit(parsed.cliType, parsed.limitId, value);
          return limits
            ? [
                {
                  rawKey,
                  limits,
                  parsed,
                  windows: getAgentRateLimitWindows(limits),
                },
              ]
            : [];
        })
        .filter((entry) => !filterCliType || entry.parsed.cliType === filterCliType)
        .filter((entry) => entry.windows.length > 0)
        .sort((a, b) => {
          if (a.parsed.cliType !== b.parsed.cliType) {
            return a.parsed.cliType.localeCompare(b.parsed.cliType);
          }
          if (a.rawKey === b.rawKey) return 0;
          return a.rawKey.localeCompare(b.rawKey);
        }),
    [raceLimits, filterCliType]
  );

  const formatResetDistance = useCallback(
    (resetAtEpochSeconds: number | null | undefined): string => {
      if (!resetAtEpochSeconds) return t('machines.rateLimits.resetUnknown');
      const epochMs = resetAtEpochSeconds * 1_000;
      return t('machines.rateLimits.resetsAt', {
        time: formatDistanceToNow(new Date(epochMs), {
          addSuffix: true,
          locale: localeObj,
        }),
      });
    },
    [localeObj, t]
  );

  if (entries.length === 0) return null;

  return (
    <div className="w-full space-y-2">
      {entries.map(({ rawKey, parsed, windows }) => {
        const isCodexSpark = parsed.limitId === CODEX_SPARK_LIMIT_ID;
        const tierLabel = isCodexSpark ? t('machines.rateLimits.codexSpark') : null;
        const cliTypeLabel =
          parsed.cliType === 'codex'
            ? 'Codex'
            : parsed.cliType === 'claude'
              ? 'Claude'
              : parsed.cliType;
        const cliIcon =
          parsed.cliType === 'codex' ? (
            <OpenAIIcon className="h-3 w-3 text-foreground/80" />
          ) : parsed.cliType === 'claude' ? (
            <AnthropicIcon className="h-3 w-3 text-foreground/80" />
          ) : null;

        const tierBadge = tierLabel ? (
          <Badge
            variant="secondary"
            className="max-w-[180px] truncate px-1.5 py-0 text-[10px]"
            title={tierLabel}
          >
            {tierLabel}
          </Badge>
        ) : null;

        const windowMeters = (
          <div
            className={cn(
              'grid gap-x-4 gap-y-1',
              windows.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
            )}
          >
            {windows.map((window, index) => {
              const shortLabel = formatRateLimitWindowShortLabel(window.windowDurationSeconds);
              const fullLabel =
                window.windowDurationSeconds === FIVE_HOUR_WINDOW_SECONDS
                  ? t('machines.rateLimits.fiveHour')
                  : window.windowDurationSeconds === SEVEN_DAY_WINDOW_SECONDS
                    ? t('machines.rateLimits.sevenDay')
                    : shortLabel;
              return (
                <UsageQuotaWindow
                  key={`${window.windowDurationSeconds ?? 'unknown'}-${index}`}
                  shortLabel={formatAgentRateLimitWindowLabel(window, shortLabel, t)}
                  fullLabel={formatAgentRateLimitWindowLabel(window, fullLabel, t)}
                  percent={window.usedPercent}
                  resetText={formatResetDistance(window.resetsAtEpochSeconds)}
                  disabled={false}
                />
              );
            })}
          </div>
        );

        // Per-provider (filtered): the parent provider row already supplies the
        // card chrome, so render a flat, compact block — no extra border/bg.
        if (filterCliType) {
          return (
            <div key={rawKey} className="space-y-1.5">
              {tierBadge}
              {windowMeters}
            </div>
          );
        }

        // Aggregated (machine settings): keep a light card + cliType header so
        // multiple providers stay visually grouped.
        return (
          <div
            key={rawKey}
            className="rounded-lg border border-border/70 bg-background/80 px-2.5 py-2"
          >
            <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                {cliIcon}
                {cliTypeLabel}
              </span>
              {tierBadge}
            </div>
            {windowMeters}
          </div>
        );
      })}
    </div>
  );
}

function UsageQuotaWindow({
  shortLabel,
  fullLabel,
  percent,
  resetText,
  disabled,
}: {
  shortLabel: string;
  fullLabel: string;
  percent: number | null;
  resetText: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const percentText =
    percent == null
      ? t('machines.rateLimits.notAvailable')
      : t('machines.rateLimits.usedPercent', '{{percent}}% used', {
          percent: Math.round(percent),
        });

  return (
    <div className="min-w-0" title={`${fullLabel}: ${percentText}, ${resetText}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{shortLabel}</span>
        <span className="font-mono text-[11px] text-foreground">{percentText}</span>
      </div>
      <div className="mt-1">
        <UsageProgressBar value={percent ?? 0} disabled={disabled || percent == null} />
      </div>
      <span
        className="mt-0.5 block truncate text-[10px] text-muted-foreground/80"
        title={resetText}
      >
        {resetText}
      </span>
    </div>
  );
}

function UsageProgressBar({ value, disabled }: { value: number; disabled: boolean }) {
  const pct = Math.min(100, Math.max(0, value));

  return (
    <div
      role="progressbar"
      aria-valuenow={disabled ? undefined : pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        'relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10',
        disabled && 'opacity-60'
      )}
    >
      <div
        className="h-full rounded-full bg-muted-foreground/60 transition-[width] duration-300 ease-out"
        style={{
          width: `${disabled ? 0 : pct}%`,
          minWidth: !disabled && pct > 0 ? 2 : undefined,
        }}
      />
    </div>
  );
}
