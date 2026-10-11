import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { CodexResetForecastDialogHost } from '@/components/codex-reset/codex-reset-forecast-entry';
import {
  formatAgentRateLimitWindowLabel,
  formatRateLimitWindowShortLabel,
  type AgentRateLimitWindow,
} from '@/lib/session-usage';

const styles = stylex.create({
  overview: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: space[2],
    minWidth: 0,
    maxWidth: '100%',
  },
  summary: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: space[2],
    minWidth: 0,
    maxWidth: '100%',
    fontSize: text.footnoteSize,
    lineHeight: 1,
  },
  muted: { color: colors.secondaryLabel },
  meter: { display: 'flex', alignItems: 'baseline', gap: space[1.5] },
  windowLabel: {
    maxWidth: '6em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  percent: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontVariantNumeric: 'tabular-nums',
  },
  track: {
    alignSelf: 'center',
    width: '28px',
    height: '4px',
    overflow: 'hidden',
    borderRadius: '9999px',
    backgroundColor: colors.gray5,
  },
  fill: { display: 'block', height: '100%', backgroundColor: colors.gray },
  fillWidth: (percent: number) => ({ width: `${percent}%` }),
});

/** Quota is read-only; the separate forecast action opens its dialog directly. */
export function ProviderUsageSummary({
  name,
  windows,
  showResetForecast,
}: {
  name: string;
  windows: AgentRateLimitWindow[];
  showResetForecast: boolean;
}) {
  const { t } = useTranslation();
  const [forecastOpen, setForecastOpen] = useState(false);

  return (
    <>
      <div {...stylex.props(styles.overview)}>
        {windows.length > 0 ? (
          <div
            role="group"
            aria-label={t('settings.agent.provider.remainingQuota', '{{name}} remaining quota', {
              name,
            })}
            {...stylex.props(styles.summary)}
          >
            <span {...stylex.props(styles.muted)}>
              {t('sessions.contextWindow.remaining', 'Remaining')}
            </span>
            {windows.map((window, index) => {
              const label = formatAgentRateLimitWindowLabel(
                window,
                formatRateLimitWindowShortLabel(window.windowDurationSeconds),
                t
              );
              const percent = Math.round(window.remainingPercent);
              const remaining = t('sessions.usage.remainingPercent', '{{percent}}% left', {
                percent,
              });
              return (
                <span
                  key={index}
                  role="meter"
                  aria-label={`${label}: ${remaining}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={window.remainingPercent}
                  {...stylex.props(styles.meter)}
                >
                  <span {...stylex.props(styles.windowLabel)} title={label}>
                    {label}
                  </span>
                  <span {...stylex.props(styles.track)} aria-hidden="true">
                    <span
                      {...stylex.props(styles.fill, styles.fillWidth(window.remainingPercent))}
                    />
                  </span>
                  <span {...stylex.props(styles.percent)}>{percent}%</span>
                </span>
              );
            })}
          </div>
        ) : null}
        {showResetForecast ? (
          <Button
            variant="ghost"
            size="mini"
            aria-haspopup="dialog"
            onClick={() => setForecastOpen(true)}
          >
            <span>{t('codexReset.entry', 'Reset forecast')}</span>
          </Button>
        ) : null}
      </div>
      {showResetForecast ? (
        <CodexResetForecastDialogHost enabled open={forecastOpen} onOpenChange={setForecastOpen} />
      ) : null}
    </>
  );
}
