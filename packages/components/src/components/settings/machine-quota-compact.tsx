import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineViewMeta } from '@lody/shared';
import {
  CODEX_SPARK_LIMIT_ID,
  normalizePersistedRateLimit,
  parseRateLimitEntryKey,
} from '@lody/shared';
import { formatDistanceToNow, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import { AnthropicIcon } from '@/components/icons/anthropic-icon';
import { OpenAIIcon } from '@/components/icons/openai-icon';
import * as stylex from '@stylexjs/stylex';
import { Badge } from '@lody/ui/badge';
import { Progress } from '@lody/ui/progress';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsSurface as surface } from './surface';
import {
  FIVE_HOUR_WINDOW_SECONDS,
  SEVEN_DAY_WINDOW_SECONDS,
  formatAgentRateLimitWindowLabel,
  formatRateLimitWindowShortLabel,
  getAgentRateLimitWindows,
} from '@/lib/session-usage';
import { settingsType as type } from './type.stylex';

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
    <div {...stylex.props(styles.list)}>
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
            <OpenAIIcon {...stylex.props(styles.cliIcon)} />
          ) : parsed.cliType === 'claude' ? (
            <AnthropicIcon {...stylex.props(styles.cliIcon)} />
          ) : null;

        const tierBadge = tierLabel ? (
          <Badge title={tierLabel} {...stylex.props(styles.tierBadge)}>
            {tierLabel}
          </Badge>
        ) : null;

        const windowMeters = (
          <div {...stylex.props(styles.windows, windows.length > 1 && styles.windowsPaired)}>
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
        // card, so the meters sit on it with nothing around them.
        if (filterCliType) {
          return (
            <div key={rawKey} {...stylex.props(styles.flatEntry)}>
              {tierBadge}
              {windowMeters}
            </div>
          );
        }

        // Aggregated (machine settings): each provider is a block inside the
        // machine's card — a region fill with its cliType heading, never a card.
        return (
          <div key={rawKey} {...stylex.props(surface.formBlock)}>
            <div {...stylex.props(styles.entryHeader)}>
              <span {...stylex.props(styles.cliLabel)}>
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
    <div {...stylex.props(styles.window)} title={`${fullLabel}: ${percentText}, ${resetText}`}>
      <div {...stylex.props(styles.windowHeader)}>
        <span {...stylex.props(styles.windowLabel)}>{shortLabel}</span>
        <span {...stylex.props(styles.windowValue)}>{percentText}</span>
      </div>
      {/* A quota measures something rather than progressing through it, so the
          bar takes the neutral tone and gives the accent back to live state. */}
      <Progress
        tone="neutral"
        value={disabled || percent == null ? 0 : Math.min(100, Math.max(0, percent))}
      />
      <span {...stylex.props(styles.reset)} title={resetText}>
        {resetText}
      </span>
    </div>
  );
}

const styles = stylex.create({
  list: { display: 'flex', flexDirection: 'column', gap: space[2], width: '100%' },
  flatEntry: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[1.5],
  },
  entryHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minWidth: 0,
    marginBottom: space[2],
  },
  cliLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: type.caption,
    fontWeight: 400,
    color: colors.label,
  },
  cliIcon: { width: '12px', height: '12px', color: colors.secondaryLabel },
  /** A long tier name ends in an ellipsis: the surface caps its badge. */
  tierBadge: { maxWidth: '180px' },
  windows: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    columnGap: space[4],
    rowGap: space[1],
    alignSelf: 'stretch',
  },
  windowsPaired: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  window: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  windowHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[2],
  },
  windowLabel: { fontSize: '11px', color: colors.secondaryLabel },
  windowValue: {
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  reset: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '10px',
    color: colors.secondaryLabel,
  },
});
