import { useMemo, type ReactNode } from 'react';
import { Brain, ListChecks, Zap } from 'lucide-react';
import { classifyPermissionModeFace } from '@lody/shared';

import {
  resolveConfigOptionValue,
  resolveOnOffConfigOptionEnabled,
  resolvePlanModeSelectorEnabled,
  type AcpConfigOptionSelector,
  type AcpConfigOptionValue,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import { cn } from '@/lib/utils';
import { PermissionModeFaceIndicator } from './permission-mode-face';

/**
 * Collapsed "run config" button for the mobile composer. Consolidates model /
 * reasoning / permission-mode / Plan / Fast into ONE control; tapping opens the
 * run-config sheet. The face reads:
 *
 *   [ agent icon + model (truncates) ]  ·  [ reasoning ]  ·  [ mode indicator ]
 *   ·  [ plan ] [ fast ]
 *
 * Layout contract (always one row):
 * - The button is `min-w-0 max-w-full` and never wraps; status glyphs stay
 *   `shrink-0`, and only the model label absorbs remaining width via flex.
 * - Model truncates keeping the *tail* (rtl trick) so long
 *   "provider/model-name" labels lose the prefix, not the model suffix.
 * - agent icon: ACP brand icon, passed in by the caller.
 * - reasoning / mode / Plan / Fast: fixed-width status; never force a second
 *   line when the model name is long.
 */
export type MobileRunConfigButtonProps = {
  modelOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModelId: string | null;
  modeOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModeId: string | null;
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  /** The ACP agent's brand icon, built by the caller (`<AgentIcon .../>`). */
  agentIcon?: ReactNode;
  onOpen?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
};

export function useRunConfigFace({
  modelOptions,
  selectedModelId,
  modeOptions,
  selectedModeId,
  configOptionSelectors = [],
  configOptionValues,
}: Pick<
  MobileRunConfigButtonProps,
  | 'modelOptions'
  | 'selectedModelId'
  | 'modeOptions'
  | 'selectedModeId'
  | 'configOptionSelectors'
  | 'configOptionValues'
>) {
  const {
    modelSelectors,
    permissionModeSelectors,
    modeSelectors,
    thoughtLevelSelectors,
    thoughtToggleSelectors,
    planModeSelectors,
    fastModeSelectors,
  } = useMemo(() => orderAcpConfigOptionSelectors(configOptionSelectors), [configOptionSelectors]);

  const modelSelector: AcpSelectConfigOptionSelector | undefined = modelSelectors[0];
  const modelValue: string | null =
    modelOptions.length > 0
      ? selectedModelId
      : modelSelector
        ? ((resolveConfigOptionValue(
            modelSelector,
            configOptionValues?.[modelSelector.configId]
          ) as string) ?? null)
        : null;
  const modelLabel = useMemo(() => {
    if (!modelValue) return null;
    const opts = modelOptions.length > 0 ? modelOptions : (modelSelector?.options ?? []);
    return opts.find((opt) => opt.value === modelValue)?.label ?? modelValue;
  }, [modelOptions, modelSelector, modelValue]);

  const thinkingSelector = useMemo(
    () =>
      thoughtLevelSelectors.find((selector) => selector.type === 'select') as
        | AcpSelectConfigOptionSelector
        | undefined,
    [thoughtLevelSelectors]
  );
  const thinkingValue = thinkingSelector
    ? ((resolveConfigOptionValue(
        thinkingSelector,
        configOptionValues?.[thinkingSelector.configId]
      ) as string) ?? null)
    : null;
  const thinkingLabel =
    thinkingSelector?.options.find((option) => option.value === thinkingValue)?.label ??
    thinkingValue;

  const explicitPermissionSelector = permissionModeSelectors[0];
  const modeSelector: AcpSelectConfigOptionSelector | undefined =
    explicitPermissionSelector ?? modeSelectors[0];
  const modeId: string | null =
    explicitPermissionSelector || modeOptions.length === 0
      ? modeSelector
        ? ((resolveConfigOptionValue(
            modeSelector,
            configOptionValues?.[modeSelector.configId]
          ) as string) ?? null)
        : null
      : selectedModeId;

  const planSelector = planModeSelectors[0];
  const planOn = planSelector
    ? resolvePlanModeSelectorEnabled(planSelector, configOptionValues?.[planSelector.configId])
    : false;
  const fastSelector = fastModeSelectors[0];
  const fastOn = fastSelector
    ? resolveOnOffConfigOptionEnabled(fastSelector, configOptionValues?.[fastSelector.configId])
    : false;
  const thoughtToggleOn = thoughtToggleSelectors.some((selector) =>
    resolveOnOffConfigOptionEnabled(selector, configOptionValues?.[selector.configId])
  );

  return { modelLabel, thinkingLabel, modeId, planOn, fastOn, thoughtToggleOn };
}

/** Middle-dot separator between the face's identity/status groups. */
function FaceDot() {
  return (
    <span aria-hidden="true" className="shrink-0 select-none text-muted-foreground/70">
      ·
    </span>
  );
}

export function MobileRunConfigButton({
  agentIcon,
  onOpen,
  disabled,
  ariaLabel = 'Run configuration',
  ...faceProps
}: MobileRunConfigButtonProps) {
  const { modelLabel, thinkingLabel, modeId, planOn, fastOn, thoughtToggleOn } =
    useRunConfigFace(faceProps);
  const hasToggle = planOn || fastOn || thoughtToggleOn;
  // The indicator hides itself for default/unknown modes; mirror that here so
  // the separator dot never renders next to nothing.
  const modeVisible = classifyPermissionModeFace(modeId).kind !== 'hidden';

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      aria-label={ariaLabel}
      className={cn(
        /* No background/border at rest — the button reads as plain
           model + indicators text next to the + menu; only a subtle
           hover/press wash marks it as tappable.
           inline-flex + max-w-full + nowrap: stay one row; short names stay
           compact, long names shrink inside the footer slot (parent gives
           min-w-0 / overflow). Only the model label yields width. */
        'inline-flex h-8 min-w-0 max-w-full select-none flex-nowrap items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-sm text-foreground transition-colors',
        'hover:bg-muted/50 active:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60'
      )}
    >
      {/* Identity group: agent logo + model name. min-w-0 so it is the flex
          item that shrinks when thinking/mode/plan need their full width. */}
      <span className="flex min-w-0 items-center gap-1 overflow-hidden">
        {agentIcon ? (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center [&>*]:h-4 [&>*]:w-4">
            {agentIcon}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-left [direction:rtl]">
          <span dir="ltr">{modelLabel ?? 'Model'}</span>
        </span>
      </span>
      {thinkingLabel ? (
        <>
          <FaceDot />
          <span className="shrink-0 whitespace-nowrap">{thinkingLabel}</span>
        </>
      ) : null}
      {modeVisible ? (
        <>
          <FaceDot />
          <span className="shrink-0">
            <PermissionModeFaceIndicator modeId={modeId} />
          </span>
        </>
      ) : null}
      {hasToggle ? (
        <>
          <FaceDot />
          {planOn ? (
            <ListChecks
              className="h-3.5 w-3.5 shrink-0 text-primary"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : null}
          {thoughtToggleOn ? (
            <Brain
              className="h-3.5 w-3.5 shrink-0 text-primary"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : null}
          {fastOn ? (
            <Zap
              className="h-3.5 w-3.5 shrink-0 text-primary"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : null}
        </>
      ) : null}
    </button>
  );
}
