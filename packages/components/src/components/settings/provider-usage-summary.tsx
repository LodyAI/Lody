import { radius as sharedRadius, space, text } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { CodexResetForecastDialogHost } from '@/components/codex-reset/codex-reset-forecast-entry';
import {
  formatAgentRateLimitWindowLabel,
  formatRateLimitWindowShortLabel,
  type AgentRateLimitWindow,
} from '@/lib/session-usage';

const LOW_REMAINING_PERCENT = 20;

const styles = stylex.create({
  overview: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: space[1.5],
    minWidth: 0,
    maxWidth: '100%',
  },
  // The mini ghost button is taller than the footnote line; its outer margins
  // pull that extra height back so the quota line keeps the row's pitch.
  forecastWrap: { display: 'inline-flex', alignItems: 'center', marginBlock: '-4px' },
  summary: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    alignItems: 'baseline',
    columnGap: space[3],
    minWidth: 0,
    maxWidth: '100%',
    fontSize: text.footnoteSize,
    lineHeight: 1,
  },
  muted: { color: colors.secondaryLabel },
  pairs: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space[3],
    rowGap: space[1.5],
    minWidth: 0,
  },
  // Two neighbouring windows wrap as one unit, so a narrow panel reads in
  // pairs rather than a ragged last meter dropping alone.
  pair: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space[3],
    rowGap: space[1.5],
    minWidth: 0,
  },
  meter: { display: 'flex', alignItems: 'baseline', gap: space[1.5] },
  windowLabel: {
    maxWidth: '6em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
  },
  percent: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontVariantNumeric: 'tabular-nums',
  },
  percentLow: { color: colors.warning },
  track: {
    alignSelf: 'center',
    width: '32px',
    height: '4px',
    overflow: 'hidden',
    borderRadius: sharedRadius.full,
    backgroundColor: colors.gray5,
  },
  fill: { display: 'block', height: '100%', backgroundColor: colors.gray },
  fillLow: { backgroundColor: colors.warning },
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
            <span {...stylex.props(styles.pairs)}>
              {Array.from({ length: Math.ceil(windows.length / 2) }, (_, pairIndex) => (
                <span key={pairIndex} {...stylex.props(styles.pair)}>
                  {windows.slice(pairIndex * 2, pairIndex * 2 + 2).map((window, index) => {
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
                        key={pairIndex * 2 + index}
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
                            {...stylex.props(
                              styles.fill,
                              window.remainingPercent <= LOW_REMAINING_PERCENT && styles.fillLow,
                              styles.fillWidth(window.remainingPercent)
                            )}
                          />
                        </span>
                        <span
                          {...stylex.props(
                            styles.percent,
                            window.remainingPercent <= LOW_REMAINING_PERCENT && styles.percentLow
                          )}
                        >
                          {percent}%
                        </span>
                      </span>
                    );
                  })}
                </span>
              ))}
            </span>
          </div>
        ) : null}
        {showResetForecast ? (
          <span {...stylex.props(styles.forecastWrap)}>
            <Button
              variant="ghost"
              size="mini"
              aria-haspopup="dialog"
              onClick={() => setForecastOpen(true)}
            >
              <span>{t('codexReset.entry', 'Reset forecast')}</span>
            </Button>
          </span>
        ) : null}
      </div>
      {showResetForecast ? (
        <CodexResetForecastDialogHost enabled open={forecastOpen} onOpenChange={setForecastOpen} />
      ) : null}
    </>
  );
}
