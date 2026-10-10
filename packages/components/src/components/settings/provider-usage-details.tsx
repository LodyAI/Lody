import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { Progress } from '@lody/ui/progress';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { CodexResetForecastDialogHost } from '@/components/codex-reset/codex-reset-forecast-entry';
import {
  formatAgentRateLimitWindowLabel,
  formatRateLimitWindowShortLabel,
  type AgentRateLimitWindow,
} from '@/lib/session-usage';

const styles = stylex.create({
  overview: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2], minWidth: 0 },
  chevron: { width: '12px', height: '12px' },
  summary: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.captionSize,
  },
  muted: { color: colors.secondaryLabel },
  meter: { display: 'flex', alignItems: 'center', gap: space[1.5] },
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
    width: '28px',
    height: '4px',
    overflow: 'hidden',
    borderRadius: '9999px',
    backgroundColor: colors.gray5,
  },
  fill: { display: 'block', height: '100%', backgroundColor: colors.gray },
  fillWidth: (percent: number) => ({ width: `${percent}%` }),
  content: {
    width: '17rem',
    maxWidth: 'calc(100vw - 2rem)',
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
  },
  windows: { display: 'flex', flexDirection: 'column', gap: space[3] },
  detail: { display: 'flex', flexDirection: 'column', gap: space[1.5] },
  detailLine: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: space[3],
    fontSize: text.captionSize,
  },
  hint: { margin: 0, fontSize: text.captionSize, color: colors.secondaryLabel, lineHeight: 1.5 },
  forecast: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[2],
    paddingTop: space[3],
    borderTop: `1px solid ${colors.separator}`,
  },
});

/** Official remaining quota in the row; third-party forecasts live in its details. */
export function ProviderUsageDetails({
  name,
  windows,
  showResetForecast,
}: {
  name: string;
  windows: AgentRateLimitWindow[];
  showResetForecast: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [forecastOpen, setForecastOpen] = useState(false);
  const title = t('settings.agent.provider.quotaDetails', '{{name}} quota details', { name });
  const windowLabel = (window: AgentRateLimitWindow) =>
    formatAgentRateLimitWindowLabel(
      window,
      formatRateLimitWindowShortLabel(window.windowDurationSeconds),
      t
    );

  const summaryDescription = windows
    .map(
      (window) =>
        `${windowLabel(window)}: ${t('sessions.usage.remainingPercent', '{{percent}}% left', { percent: Math.round(window.remainingPercent) })}`
    )
    .join('; ');

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <div {...stylex.props(styles.overview)}>
          {windows.length > 0 ? (
            <span {...stylex.props(styles.summary)}>
              <span {...stylex.props(styles.muted)}>
                {t('sessions.contextWindow.remaining', 'Remaining')}
              </span>
              {windows.slice(0, 2).map((window, index) => (
                <span key={index} {...stylex.props(styles.meter)}>
                  <span {...stylex.props(styles.windowLabel)} title={windowLabel(window)}>
                    {windowLabel(window)}
                  </span>
                  <span {...stylex.props(styles.track)} aria-hidden="true">
                    <span
                      {...stylex.props(styles.fill, styles.fillWidth(window.remainingPercent))}
                    />
                  </span>
                  <span {...stylex.props(styles.percent)}>
                    {Math.round(window.remainingPercent)}%
                  </span>
                </span>
              ))}
              {windows.length > 2 ? (
                <span {...stylex.props(styles.muted)}>+{windows.length - 2}</span>
              ) : null}
            </span>
          ) : null}
          <Popover.Trigger
            render={
              <Button
                variant="secondary"
                size="mini"
                aria-label={title}
                aria-description={summaryDescription || undefined}
              />
            }
          >
            {t('settings.agent.provider.quota', 'Quota details')}
            <ChevronDown {...stylex.props(styles.chevron)} aria-hidden="true" />
          </Popover.Trigger>
        </div>
        <Popover.Content align="end">
          <div {...stylex.props(styles.content)}>
            <Popover.Header>
              <Popover.Title>{title}</Popover.Title>
              <Popover.Description>
                {t(
                  'settings.agent.provider.quotaHint',
                  'Remaining subscription quota reported by this provider.'
                )}
              </Popover.Description>
            </Popover.Header>
            <div {...stylex.props(styles.windows)}>
              {windows.length > 0 ? (
                windows.map((window, index) => {
                  const label = windowLabel(window);
                  const remaining = t('sessions.usage.remainingPercent', '{{percent}}% left', {
                    percent: Math.round(window.remainingPercent),
                  });
                  return (
                    <div key={index} {...stylex.props(styles.detail)}>
                      <div {...stylex.props(styles.detailLine)}>
                        <span>{label}</span>
                        <span {...stylex.props(styles.percent)}>{remaining}</span>
                      </div>
                      <Progress
                        value={window.remainingPercent}
                        tone="neutral"
                        aria-label={`${label}: ${remaining}`}
                      />
                    </div>
                  );
                })
              ) : (
                <p {...stylex.props(styles.hint)}>
                  {t(
                    'sessions.usage.unavailable',
                    'The provider did not report usage for this plan'
                  )}
                </p>
              )}
            </div>
            {showResetForecast ? (
              <div {...stylex.props(styles.forecast)}>
                <p {...stylex.props(styles.hint)}>
                  {t(
                    'settings.agent.provider.forecastHint',
                    'Third-party reset forecast from codex-resets.com. For reference only.'
                  )}
                </p>
                <Button
                  variant="ghost"
                  size="small"
                  aria-haspopup="dialog"
                  onClick={() => {
                    setOpen(false);
                    setForecastOpen(true);
                  }}
                >
                  {t('codexReset.entry', 'Reset forecast')}
                </Button>
              </div>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Root>
      {/* The dialog survives dismissal/unmounting of the quota popover. */}
      {showResetForecast ? (
        <CodexResetForecastDialogHost enabled open={forecastOpen} onOpenChange={setForecastOpen} />
      ) : null}
    </>
  );
}
