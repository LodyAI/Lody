import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TimerReset } from 'lucide-react';

import { useIsMobile } from '@/hooks/use-mobile';
import { useCodexResetForecast } from '@/hooks/use-codex-reset-forecast';
import { formatCodexResetExpiry } from '@/lib/codex-reset-forecast';
import { CodexResetForecastDialog } from './codex-reset-forecast-dialog';

/**
 * Entry points to the Codex reset forecast dialog. Both call sites gate on
 * `canShowCodexResetForecast` themselves, so `enabled` is what decides whether
 * this component may fetch anything at all.
 *
 * NOTHING here loads on mount. The forecast is fetched from the interaction
 * that reveals it — opening the dialog from the provider row, or opening the
 * usage popover in the composer — so a workspace nobody asks never requests it.
 */

export type CodexResetForecastChipProps = {
  enabled: boolean;
};

/**
 * Provider-list entry: always present for a first-party Codex provider, sitting
 * just before the rate-limit meters. Its label carries the probability only once
 * something has loaded it; the dialog owns the empty / loading / error stories.
 */
export function CodexResetForecastChip({ enabled }: CodexResetForecastChipProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const forecast = useCodexResetForecast(enabled);

  if (!enabled) return null;

  const label =
    forecast.watch?.chancePercent != null
      ? t('codexReset.entryWithChance', 'Reset forecast {{percent}}%', {
          percent: forecast.watch.chancePercent,
        })
      : t('codexReset.entry', 'Reset forecast');

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          // The click IS the load: settings renders one row per provider, and
          // none of them should reach the network just by being listed.
          forecast.revalidate();
          setOpen(true);
        }}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        <TimerReset className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="whitespace-nowrap">{label}</span>
      </button>
      <CodexResetForecastDialog
        open={open}
        onOpenChange={setOpen}
        // Desktop settings already owns the full-page /80 veil. Lift this
        // later overlay above that dialog and dim it only lightly.
        nestedInDialog={!isMobile}
        state={forecast.state}
        watch={forecast.watch}
        isExpired={forecast.isExpired}
        nowMs={forecast.nowMs}
        onRetry={forecast.refresh}
      />
    </>
  );
}

export type CodexResetForecastUsageRowProps = {
  enabled: boolean;
  onOpen: () => void;
};

/**
 * Usage-popover row, shaped like the rate-limit meters it sits under: label and
 * probability on one baseline, the locally formatted forecast expiry underneath. It renders
 * nothing unless a forecast is in force.
 *
 * This component is mounted by the popover's CONTENT, which Radix only renders
 * while the popover is open — so mounting it is exactly the "user opened the
 * rate limits" moment, and that is where the load belongs.
 *
 * It deliberately does NOT own the dialog. Opening a Radix Dialog from inside a
 * Popover dismisses the popover, which would unmount the dialog with it, so the
 * caller hosts `CodexResetForecastDialogHost` outside the popover instead.
 */
export function CodexResetForecastUsageRow({ enabled, onOpen }: CodexResetForecastUsageRowProps) {
  const { t, i18n } = useTranslation();
  const forecast = useCodexResetForecast(enabled);
  const watch = forecast.watch;
  const { revalidate } = forecast;

  useEffect(() => {
    revalidate();
  }, [revalidate]);

  if (!enabled || !watch) return null;

  return (
    <div className="mt-2.5 border-t border-border/60 pt-2">
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="-mx-1 block w-[calc(100%+0.5rem)] rounded-md px-1 py-1 text-left transition-colors hover:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        {/* Same two-line shape as the meters above: label and value on one
            baseline, the quieter detail underneath. */}
        <span className="flex items-baseline justify-between gap-3 text-[11px] leading-4">
          {/* No icon: the meters above carry none, and an inline SVG would take
              over this row's baseline and misalign the value beside it. */}
          <span className="min-w-0 truncate font-medium text-foreground/85">
            {t('codexReset.entry', 'Reset forecast')}
          </span>
          {watch.chancePercent === null ? null : (
            // "65%" alone would read as "65% used" beside the meters above.
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
              {t('codexReset.rowChance', '{{percent}}% chance', {
                percent: watch.chancePercent,
              })}
            </span>
          )}
        </span>
        {/* The API instant is formatted semantically in the browser/OS time zone. */}
        <span className="mt-0.5 block truncate text-[10px] leading-3.5 text-muted-foreground/75">
          {formatCodexResetExpiry(
            watch.expiresAtMs,
            forecast.nowMs,
            i18n.resolvedLanguage ?? i18n.language
          )}
        </span>
      </button>
    </div>
  );
}

export type CodexResetForecastDialogHostProps = {
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The dialog on its own, for a surface whose trigger cannot host it (see
 * `CodexResetForecastUsageRow`). Mount it as a sibling of that surface.
 *
 * It stays mounted so the close animation can run, which is why it loads on
 * OPEN rather than on mount — the composer must not fetch a forecast nobody
 * asked to see.
 */
export function CodexResetForecastDialogHost({
  enabled,
  open,
  onOpenChange,
}: CodexResetForecastDialogHostProps) {
  const forecast = useCodexResetForecast(enabled);
  const { revalidate } = forecast;

  useEffect(() => {
    if (!open) return;
    revalidate();
  }, [open, revalidate]);

  if (!enabled) return null;

  return (
    <CodexResetForecastDialog
      open={open}
      onOpenChange={onOpenChange}
      state={forecast.state}
      watch={forecast.watch}
      isExpired={forecast.isExpired}
      nowMs={forecast.nowMs}
      onRetry={forecast.refresh}
    />
  );
}
