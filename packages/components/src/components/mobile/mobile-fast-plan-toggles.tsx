import { AcpControlAvailability } from '../shared/acp-control-availability';
import { useMemo, type ReactNode } from 'react';
import { ListChecks, Zap, ZapOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  resolveOnOffConfigOptionEnabled,
  resolvePlanModeSelectorEnabled,
  toggleOnOffConfigOptionValue,
  togglePlanModeSelectorValue,
  type AcpConfigOptionSelector,
  type AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';

/**
 * Mobile counterparts to the desktop Fast / Plan icon-state toggles.
 *
 * The two used to live together in a single row, but per the latest
 * design Fast belongs next to the model + thinking pickers in the
 * composer footer (it's a model-tier behavior), while Plan stays in
 * the row below the composer next to the permission selector with a
 * "计划" label after the icon. The two are exported separately so
 * each consumer places them where they belong.
 *
 * Both render `null` when the active agent doesn't expose the
 * corresponding selector (Codex exposes both; most others expose
 * neither). Callers can render them unconditionally.
 */

type SharedTogglesProps = {
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  disabled?: boolean;
  className?: string;
};

export function MobileFastModeToggle({
  configOptionSelectors = [],
  configOptionValues,
  onConfigOptionChange,
  disabled,
  className,
}: SharedTogglesProps) {
  const { fastModeSelectors } = useMemo(
    () => orderAcpConfigOptionSelectors(configOptionSelectors),
    [configOptionSelectors]
  );
  const fastSelector = fastModeSelectors[0];
  const fastValue = fastSelector
    ? resolveOnOffConfigOptionEnabled(fastSelector, configOptionValues?.[fastSelector.configId])
    : false;
  if (!fastSelector) return null;
  if (fastSelector.availability)
    return (
      <AcpControlAvailability
        selector={fastSelector}
        value={configOptionValues?.[fastSelector.configId]}
      />
    );
  return (
    <ToggleButton
      ariaLabel={fastSelector.label}
      active={fastValue}
      disabled={disabled}
      onToggle={() =>
        onConfigOptionChange?.(
          fastSelector.configId,
          toggleOnOffConfigOptionValue(fastSelector, configOptionValues?.[fastSelector.configId])
        )
      }
      className={className}
    >
      {fastValue ? (
        <Zap className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <ZapOff className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      )}
    </ToggleButton>
  );
}

export function MobilePlanModeToggle({
  configOptionSelectors = [],
  configOptionValues,
  onConfigOptionChange,
  disabled,
  className,
}: SharedTogglesProps) {
  const { t } = useTranslation();
  const { planModeSelectors } = useMemo(
    () => orderAcpConfigOptionSelectors(configOptionSelectors),
    [configOptionSelectors]
  );
  const planSelector = planModeSelectors[0];
  const planValue = planSelector
    ? resolvePlanModeSelectorEnabled(planSelector, configOptionValues?.[planSelector.configId])
    : false;
  if (!planSelector) return null;
  /* "计划" — the chip's label sits to the right of the icon (desktop
     does the same with "Plan"). Use the project's t() so the label
     localises with the rest of the UI; the Chinese fallback matches
     the agent's own localised label when running zh. */
  const planLabel = t('chat.mobileNewChat.planModeLabel', '计划');
  return (
    <ToggleButton
      ariaLabel={planSelector.label}
      active={planValue}
      disabled={disabled}
      onToggle={() =>
        onConfigOptionChange?.(
          planSelector.configId,
          togglePlanModeSelectorValue(planSelector, configOptionValues?.[planSelector.configId])
        )
      }
      withLabel
      className={className}
    >
      <ListChecks className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      <span className="leading-none">{planLabel}</span>
    </ToggleButton>
  );
}

/* Shared chip surface for the fast + plan buttons. Active state uses
   the primary-tinted background the desktop pattern uses; inactive
   stays muted so the row reads as "this is a toggle, currently off".
   `withLabel` flips from a square icon button (h-8 w-8) to a wider
   pill (h-8 px-2 gap-1.5) so the plan toggle can carry text. */
function ToggleButton({
  children,
  ariaLabel,
  active,
  disabled,
  onToggle,
  withLabel = false,
  className,
}: {
  children: ReactNode;
  ariaLabel: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
  withLabel?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'inline-flex h-8 shrink-0 select-none items-center justify-center rounded-md border transition-colors',
        withLabel ? 'gap-1.5 px-2 text-sm font-medium' : 'w-8',
        active
          ? 'border-primary/40 bg-primary/[0.12] text-primary'
          : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-inherit hover:text-inherit',
        className
      )}
    >
      {children}
    </button>
  );
}
