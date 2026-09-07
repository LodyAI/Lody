import { useCallback, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatDistance, type Locale } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import { ExternalLink, Loader2, TimerReset } from 'lucide-react';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { openExternalUrl } from '@/lib/native-browser';
import { cn } from '@/lib/utils';
import {
  type CodexResetSource,
  type CodexResetStatus,
  type CodexResetWatch,
  formatCodexResetExpiry,
} from '@/lib/codex-reset-forecast';
import type { CodexResetForecastState } from '@/lib/codex-reset-forecast-store';

/**
 * One recessed field style for both themes. `muted` is nearly the panel color in a
 * dark theme, so a tint of the foreground plus a hairline is what actually reads.
 */
const SUBTLE_FIELD = 'rounded-md border border-border/60 bg-foreground/[0.03]';
const CODEX_RESETS_ATTRIBUTION_URL = 'https://codex-resets.com/?utm_source=lody';

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName={nestedInDialog ? 'z-[var(--z-dialog)] bg-black/20' : undefined}
        className="gap-4 sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <TimerReset className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {t('codexReset.title', 'Codex reset forecast')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {isInitialLoading ? (
            <p className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('codexReset.loading', 'Loading the latest forecast…')}
            </p>
          ) : watch ? (
            <ActiveForecast watch={watch} relative={relative} nowMs={nowMs} />
          ) : hasNothingToShow ? (
            <div className="flex flex-col items-start gap-2.5 py-1">
              <p className="text-sm text-muted-foreground">
                {t('codexReset.unavailable', 'The reset forecast could not be loaded.')}
              </p>
              <RetryButton onRetry={onRetry} />
            </div>
          ) : (
            <NoForecast status={state.data} isExpired={isExpired} relative={relative} />
          )}

          {hasLoadError && !hasNothingToShow ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5">
              <p className="text-xs text-muted-foreground">
                {t('codexReset.refreshFailed', 'Could not refresh the forecast.')}
              </p>
              <RetryButton onRetry={onRetry} />
            </div>
          ) : null}
        </div>

        <DialogDescription className="-mt-1 border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
          <Trans
            i18nKey="codexReset.disclaimer"
            defaults="Third-party forecast from <website>codex-resets.com</website>. For reference only."
            components={{
              website: (
                <ExternalTextLink
                  url={CODEX_RESETS_ATTRIBUTION_URL}
                  className="align-baseline underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
                />
              ),
            }}
          />
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <Button variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={onRetry}>
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
    <div className="flex flex-col gap-4">
      {/* The probability is the headline; the level qualifies it from the side. */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-start justify-between gap-3">
          {percent === null ? (
            <p className="text-base font-medium leading-tight">
              {t('codexReset.chanceUnknown', 'Reset watch in effect')}
            </p>
          ) : (
            <p className="flex items-baseline gap-1.5">
              <span className="text-[2.25rem] font-semibold leading-none tracking-tight tabular-nums">
                {percent}%
              </span>{' '}
              <span className="text-sm text-muted-foreground">
                {t('codexReset.chanceLabel', 'chance of a reset')}
              </span>
            </p>
          )}
          {watch.level ? (
            <Badge
              variant={watch.level === 'strong' ? 'warning' : 'secondary'}
              className="shrink-0 font-normal"
            >
              {watch.level === 'strong'
                ? t('codexReset.levelStrong', 'Strong signal')
                : t('codexReset.levelElevated', 'Elevated signal')}
            </Badge>
          ) : null}
        </div>

        {meterPercent === null ? null : (
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/15"
            aria-hidden="true"
          >
            <div
              className={cn(
                'h-full rounded-full',
                watch.level === 'strong' ? 'bg-status-warning' : 'bg-foreground/40'
              )}
              style={{ width: `${meterPercent}%` }}
            />
          </div>
        )}
      </div>

      {/* `expires_at` is an absolute UTC instant. Intl converts it to a semantic
          time such as "Tomorrow 2:00 PM" in the browser/OS time zone. */}
      <div
        className={cn(SUBTLE_FIELD, 'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2')}
      >
        <span className="text-xs text-muted-foreground">
          {t('codexReset.window', 'Forecast valid until')}
        </span>
        <time className="text-sm font-medium" dateTime={watch.expiresAtIso}>
          {localExpiry}
        </time>
      </div>

      <SourceBlock text={watch.text} source={watch.source} />

      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium leading-tight">
          {isExpired
            ? t('codexReset.expired', 'The last forecast has expired.')
            : t('codexReset.none', 'No reset forecast right now.')}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            'codexReset.noneHint',
            'A forecast appears only when there is a signal worth watching.'
          )}
        </p>
      </div>
      {latestReset ? (
        <div className={cn(SUBTLE_FIELD, 'flex flex-col gap-2 px-3 py-2.5')}>
          <p className="text-xs text-muted-foreground">
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
    <figure className="flex flex-col gap-1.5">
      {trimmed ? (
        <blockquote className="border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
          {trimmed}
        </blockquote>
      ) : null}
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
  className,
}: {
  url: string;
  children?: ReactNode;
  className?: string;
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
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className
      )}
    >
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}
