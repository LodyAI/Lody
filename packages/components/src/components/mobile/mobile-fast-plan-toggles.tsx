import { useMemo, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ListChecks, Zap, ZapOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '@lody/ui/toggle';
import { composerSurface } from '@/components/shared/composer-surface';
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
        <Zap {...stylex.props(composerSurface.glyph16)} strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <ZapOff {...stylex.props(composerSurface.glyph16)} strokeWidth={1.8} aria-hidden="true" />
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
      <ListChecks {...stylex.props(composerSurface.glyph16)} strokeWidth={1.8} aria-hidden="true" />
      <span>{planLabel}</span>
    </ToggleButton>
  );
}

/* Shared control for the fast + plan buttons: `@lody/ui`'s Toggle at the touch
   step. Off it is a ghost button; on it sinks into the well, which is how this
   system says a control went down and stayed — not a tinted chip. `withLabel`
   flips from a square icon button to a wider one so the plan toggle can carry
   text. `className` is layout only. */
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
    <Toggle
      size="medium"
      icon={!withLabel}
      pressed={active}
      onPressedChange={onToggle}
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={disabled}
      className={className}
    >
      {children}
    </Toggle>
  );
}
