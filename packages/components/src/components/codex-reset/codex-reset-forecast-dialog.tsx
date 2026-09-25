import { useCallback, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatDistance, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import { AlertTriangle, ExternalLink, TimerReset } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import {
  corner,
  duration,
  ease,
  focus,
  radius,
  space,
  text as textStep,
} from '@lody/ui/tokens/scales.stylex';
import { Spinner } from '@lody/ui/spinner';

import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { openExternalUrl } from '@/lib/native-browser';
import {
  type CodexResetSource,
  type CodexResetStatus,
  type CodexResetWatch,
  formatCodexResetExpiry,
} from '@/lib/codex-reset-forecast';
import type { CodexResetForecastState } from '@/lib/codex-reset-forecast-store';

const CODEX_RESETS_ATTRIBUTION_URL = 'https://codex-resets.com/?utm_source=lody';

/** A block inside the panel is the region rung: a fill with no edge. */
const REGION = `color-mix(in oklab, transparent, ${colors.label} 3%)`;

const styles = stylex.create({
  title: { display: 'flex', alignItems: 'center', gap: space[2] },
  titleMark: { flexShrink: 0, width: '16px', height: '16px', color: colors.secondaryLabel },
  body: { display: 'flex', flexDirection: 'column', gap: space[4] },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    margin: 0,
    paddingBlock: space[1],
    fontSize: textStep.bodySize,
    lineHeight: textStep.bodyLeading,
    color: colors.secondaryLabel,
  },
  unavailable: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '10px',
    paddingBlock: space[1],
  },
  prose: {
    margin: 0,
    fontSize: textStep.bodySize,
    lineHeight: textStep.bodyLeading,
    color: colors.secondaryLabel,
  },
  /** A failed refresh under a forecast still on screen: a tint and a mark. */
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingInlineStart: space[3],
    paddingInlineEnd: space[1.5],
    paddingBlock: space[1.5],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.warning} 10%)`,
  },
  noticeMark: { flexShrink: 0, width: '14px', height: '14px', color: colors.warning },
  noticeText: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    fontSize: textStep.footnoteSize,
    lineHeight: textStep.footnoteLeading,
    color: colors.label,
  },
  /** Fine print: the attribution under everything else. */
  finePrint: {
    display: 'block',
    fontSize: textStep.footnoteSize,
    lineHeight: 1.625,
    color: colors.secondaryLabel,
  },

  stack: { display: 'flex', flexDirection: 'column', gap: space[4] },
  headline: { display: 'flex', flexDirection: 'column', gap: '10px' },
  headlineRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space[3],
  },
  statement: {
    margin: 0,
    fontSize: textStep.headlineSize,
    lineHeight: 1.25,
    fontWeight: 500,
    color: colors.label,
  },
  chance: { display: 'flex', alignItems: 'baseline', gap: space[1.5], margin: 0 },
  chanceValue: {
    fontSize: '36px',
    lineHeight: 1,
    fontWeight: 600,
    letterSpacing: '-0.025em',
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  chanceLabel: { fontSize: textStep.bodySize, color: colors.secondaryLabel },
  meter: {
    width: '100%',
    height: '6px',
    overflow: 'hidden',
    borderRadius: radius.full,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 15%)`,
  },
  meterFill: {
    height: '100%',
    borderRadius: radius.full,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 40%)`,
  },
  meterFillStrong: { backgroundColor: colors.warning },
  meterWidth: (width: string) => ({ width }),
  region: {
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: REGION,
    paddingInline: space[3],
  },
  expiry: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space[2],
    rowGap: '2px',
    paddingBlock: space[2],
  },
  expiryLabel: { fontSize: textStep.footnoteSize, color: colors.secondaryLabel },
  expiryValue: {
    fontSize: textStep.bodySize,
    lineHeight: textStep.bodyLeading,
    fontWeight: 500,
    color: colors.label,
  },
  facts: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[1.5],
    margin: 0,
    fontSize: textStep.footnoteSize,
    lineHeight: textStep.footnoteLeading,
    color: colors.secondaryLabel,
  },

  none: { display: 'flex', flexDirection: 'column', gap: space[3] },
  noneText: { display: 'flex', flexDirection: 'column', gap: space[1] },
  hint: {
    margin: 0,
    fontSize: textStep.footnoteSize,
    lineHeight: 1.625,
    color: colors.secondaryLabel,
  },
  latestReset: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingBlock: '10px',
  },
  caption: {
    margin: 0,
    fontSize: textStep.footnoteSize,
    lineHeight: textStep.footnoteLeading,
    color: colors.secondaryLabel,
  },

  source: { display: 'flex', flexDirection: 'column', gap: space[1.5], margin: 0 },
  /** The quoted post, set off by the quotation mark a blockquote carries. */
  quote: {
    margin: 0,
    paddingInlineStart: space[3],
    borderInlineStartWidth: '2px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: colors.separator,
    fontSize: textStep.footnoteSize,
    lineHeight: 1.625,
    color: colors.secondaryLabel,
  },

  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    width: 'fit-content',
    borderRadius: radius.mini,
    fontSize: textStep.footnoteSize,
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    textDecorationLine: { default: 'none', ':hover': 'underline' },
    textUnderlineOffset: '2px',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
    outlineStyle: 'none',
    transitionProperty: 'color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** In running prose the link is marked by its underline at rest. */
  linkInline: {
    verticalAlign: 'baseline',
    textDecorationLine: { default: 'underline', ':hover': 'underline' },
    textDecorationColor: `color-mix(in oklab, transparent, ${colors.secondaryLabel} 50%)`,
  },
  linkMark: { flexShrink: 0, width: '12px', height: '12px' },
});

export type CodexResetForecastDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Render above an already-open dialog, such as the desktop settings modal. */
  nestedInDialog?: boolean;
  state: CodexResetForecastState;
  /** The still-valid forecast, already selected against `nowMs` by the caller. */
  watch: CodexResetWatch | null;
  isExpired: boolean;
  nowMs: number;
  onRetry: () => void;
};

/**
 * Presentational dialog for the third-party Codex reset forecast. It takes the
 * already-selected watch and the caller's clock, so it renders deterministically
 * and never re-derives "is this still valid" on its own.
 *
 * The layout is a single column ordered by how much the reader cares: the
 * probability, then the window it applies to, then the post it came from, then
 * the clock facts, then the attribution. Nothing else competes for attention.
 */
export function CodexResetForecastDialog({
  open,
  onOpenChange,
  nestedInDialog = false,
  state,
  watch,
  isExpired,
  nowMs,
  onRetry,
}: CodexResetForecastDialogProps) {
  const { t, i18n } = useTranslation();
  const locale: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;

  const relative = useCallback(
    (epochMs: number) =>
      formatDistance(new Date(epochMs), new Date(nowMs), {
        addSuffix: true,
        locale,
      }),
    [locale, nowMs]
  );

  const isInitialLoading = state.status === 'loading' && state.data === null;
  const hasLoadError = state.status === 'error';
  // With nothing cached the failure IS the content, so it carries the retry.
  // With a forecast on screen it is a footnote that must not displace it.
  const hasNothingToShow = hasLoadError && state.data === null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        // Restacks the backdrop over the settings dialog (codex-reset/AGENTS.md).
        backdropClassName={nestedInDialog ? 'z-[var(--z-dialog)] bg-black/20' : undefined}
      >
        <Dialog.Header>
          <Dialog.Title>
            <span {...stylex.props(styles.title)}>
              <TimerReset {...stylex.props(styles.titleMark)} aria-hidden="true" />
              {t('codexReset.title', 'Codex reset forecast')}
            </span>
          </Dialog.Title>
        </Dialog.Header>

        <div {...stylex.props(styles.body)}>
          {isInitialLoading ? (
            <p {...stylex.props(styles.loading)}>
              <Spinner size="small" aria-hidden="true" />
              {t('codexReset.loading', 'Loading the latest forecast…')}
            </p>
          ) : watch ? (
            <ActiveForecast watch={watch} relative={relative} nowMs={nowMs} />
          ) : hasNothingToShow ? (
            <div {...stylex.props(styles.unavailable)}>
              <p {...stylex.props(styles.prose)}>
                {t('codexReset.unavailable', 'The reset forecast could not be loaded.')}
              </p>
              <RetryButton onRetry={onRetry} />
            </div>
          ) : (
            <NoForecast status={state.data} isExpired={isExpired} relative={relative} />
          )}

          {hasLoadError && !hasNothingToShow ? (
            <div {...stylex.props(styles.notice)}>
              <AlertTriangle {...stylex.props(styles.noticeMark)} aria-hidden="true" />
              <p {...stylex.props(styles.noticeText)}>
                {t('codexReset.refreshFailed', 'Could not refresh the forecast.')}
              </p>
              <RetryButton onRetry={onRetry} />
            </div>
          ) : null}
        </div>

        <Dialog.Description>
          <span {...stylex.props(styles.finePrint)}>
            <Trans
              i18nKey="codexReset.disclaimer"
              defaults="Third-party forecast from <website>codex-resets.com</website>. For reference only."
              components={{
                website: <ExternalTextLink url={CODEX_RESETS_ATTRIBUTION_URL} inline />,
              }}
            />
          </span>
        </Dialog.Description>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <Button variant="secondary" size="small" onClick={onRetry}>
      {t('codexReset.retry', 'Try again')}
    </Button>
  );
}

function ActiveForecast({
  watch,
  relative,
  nowMs,
}: {
  watch: CodexResetWatch;
  relative: (epochMs: number) => string;
  nowMs: number;
}) {
  const { t, i18n } = useTranslation();
  const percent = watch.chancePercent;
  const meterPercent = percent === null ? null : Math.max(0, Math.min(100, percent));
  const localExpiry = formatCodexResetExpiry(
    watch.expiresAtMs,
    nowMs,
    i18n.resolvedLanguage ?? i18n.language
  );

  return (
    <div {...stylex.props(styles.stack)}>
      {/* The probability is the headline; the level qualifies it from the side. */}
      <div {...stylex.props(styles.headline)}>
        <div {...stylex.props(styles.headlineRow)}>
          {percent === null ? (
            <p {...stylex.props(styles.statement)}>
              {t('codexReset.chanceUnknown', 'Reset watch in effect')}
            </p>
          ) : (
            <p {...stylex.props(styles.chance)}>
              <span {...stylex.props(styles.chanceValue)}>{percent}%</span>{' '}
              <span {...stylex.props(styles.chanceLabel)}>
                {t('codexReset.chanceLabel', 'chance of a reset')}
              </span>
            </p>
          )}
          {watch.level ? (
            <Badge tone={watch.level === 'strong' ? 'warning' : 'neutral'}>
              {watch.level === 'strong'
                ? t('codexReset.levelStrong', 'Strong signal')
                : t('codexReset.levelElevated', 'Elevated signal')}
            </Badge>
          ) : null}
        </div>

        {meterPercent === null ? null : (
          <div {...stylex.props(styles.meter)} aria-hidden="true">
            <div
              {...stylex.props(
                styles.meterFill,
                watch.level === 'strong' && styles.meterFillStrong,
                styles.meterWidth(`${meterPercent}%`)
              )}
            />
          </div>
        )}
      </div>

      {/* `expires_at` is an absolute UTC instant. Intl converts it to a semantic
          time such as "Tomorrow 2:00 PM" in the browser/OS time zone. */}
      <div {...stylex.props(styles.region, styles.expiry)}>
        <span {...stylex.props(styles.expiryLabel)}>
          {t('codexReset.window', 'Forecast valid until')}
        </span>
        <time {...stylex.props(styles.expiryValue)} dateTime={watch.expiresAtIso}>
          {localExpiry}
        </time>
      </div>

      <SourceBlock text={watch.text} source={watch.source} />

      <p {...stylex.props(styles.facts)}>
        <span>
          {t('codexReset.observed', 'Observed')}{' '}
          <time dateTime={watch.observedAtIso}>{relative(watch.observedAtMs)}</time>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {t('codexReset.expires', 'Forecast expires')}{' '}
          <time dateTime={watch.expiresAtIso}>{relative(watch.expiresAtMs)}</time>
        </span>
      </p>
    </div>
  );
}

function NoForecast({
  status,
  isExpired,
  relative,
}: {
  status: CodexResetStatus | null;
  isExpired: boolean;
  relative: (epochMs: number) => string;
}) {
  const { t } = useTranslation();
  const latestReset = status?.latestReset ?? null;

  return (
    <div {...stylex.props(styles.none)}>
      <div {...stylex.props(styles.noneText)}>
        <p {...stylex.props(styles.statement)}>
          {isExpired
            ? t('codexReset.expired', 'The last forecast has expired.')
            : t('codexReset.none', 'No reset forecast right now.')}
        </p>
        <p {...stylex.props(styles.hint)}>
          {t(
            'codexReset.noneHint',
            'A forecast appears only when there is a signal worth watching.'
          )}
        </p>
      </div>
      {latestReset ? (
        <div {...stylex.props(styles.region, styles.latestReset)}>
          <p {...stylex.props(styles.caption)}>
            {t('codexReset.latestReset', 'Last reset announced')}{' '}
            <time dateTime={latestReset.announcedAtIso}>{relative(latestReset.announcedAtMs)}</time>
          </p>
          <SourceBlock text={latestReset.text} source={latestReset.source} />
        </div>
      ) : null}
    </div>
  );
}

function SourceBlock({ text, source }: { text: string; source: CodexResetSource | null }) {
  const { t } = useTranslation();
  const trimmed = text.trim();

  if (!trimmed && !source) return null;

  return (
    <figure {...stylex.props(styles.source)}>
      {trimmed ? <blockquote {...stylex.props(styles.quote)}>{trimmed}</blockquote> : null}
      {source ? (
        <figcaption>
          <ExternalTextLink url={source.url}>
            {t('codexReset.viewSource', 'View the source post by @{{author}}', {
              author: source.author,
            })}
          </ExternalTextLink>
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * A real anchor so the URL is visible, copyable, and keyboard/middle-click
 * friendly, with `noopener noreferrer`. The click is still routed through
 * `openExternalUrl` so Electron hands it to the system browser.
 */
function ExternalTextLink({
  url,
  children,
  inline = false,
}: {
  url: string;
  children?: ReactNode;
  /** Inside running prose: underlined at rest, on the text's baseline. */
  inline?: boolean;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.button !== 0) return;
        event.preventDefault();
        void openExternalUrl(url);
      }}
      {...stylex.props(styles.link, inline && styles.linkInline)}
    >
      {children}
      <ExternalLink {...stylex.props(styles.linkMark)} aria-hidden="true" />
    </a>
  );
}
