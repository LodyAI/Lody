import { useMemo, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ListChecks, Zap } from 'lucide-react';
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
import { composerSurface } from '@/components/shared/composer-surface';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { control, space, text } from '@lody/ui/tokens/scales.stylex';
import { PermissionModeFaceIndicator } from './permission-mode-face';

const styles = stylex.create({
  /**
   * The composer's ghost trigger at the touch step: no fill or edge at rest —
   * the button reads as plain model + indicators text next to the + menu, and
   * only the pointer's wash marks it as tappable. It stays one row: short names
   * stay compact, long names shrink inside the footer slot, and only the model
   * label yields width.
   */
  button: {
    maxWidth: '100%',
    height: control.medium,
    paddingInline: space[1.5],
    overflow: 'hidden',
    color: colors.label,
    fontSize: text.bodySize,
  },
  /** Identity group: agent logo + model name, the flex item that shrinks. */
  identity: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    overflow: 'hidden',
  },
  /** Truncates keeping the tail, so `provider/model-name` loses the prefix. */
  model: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'start',
    direction: 'rtl',
  },
  fixed: { flexShrink: 0, whiteSpace: 'nowrap' },
  dot: { flexShrink: 0, userSelect: 'none', color: colors.tertiaryLabel },
  /** Plan / Fast on: live state, so the accent. */
  live: { color: colors.accent },
});

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

  return { modelLabel, thinkingLabel, modeId, planOn, fastOn };
}

/** Middle-dot separator between the face's identity/status groups. */
function FaceDot() {
  return (
    <span aria-hidden="true" {...stylex.props(styles.dot)}>
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
  const { modelLabel, thinkingLabel, modeId, planOn, fastOn } = useRunConfigFace(faceProps);
  const hasToggle = planOn || fastOn;
  // The indicator hides itself for default/unknown modes; mirror that here so
  // the separator dot never renders next to nothing.
  const modeVisible = classifyPermissionModeFace(modeId).kind !== 'hidden';

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      aria-label={ariaLabel}
      {...stylex.props(composerSurface.trigger, styles.button)}
    >
      <span {...stylex.props(styles.identity)}>
        {agentIcon ? <span {...stylex.props(composerSurface.glyph)}>{agentIcon}</span> : null}
        <span {...stylex.props(styles.model)}>
          <span dir="ltr">{modelLabel ?? 'Model'}</span>
        </span>
      </span>
      {thinkingLabel ? (
        <>
          <FaceDot />
          <span {...stylex.props(styles.fixed)}>{thinkingLabel}</span>
        </>
      ) : null}
      {modeVisible ? (
        <>
          <FaceDot />
          <span {...stylex.props(styles.fixed)}>
            <PermissionModeFaceIndicator modeId={modeId} />
          </span>
        </>
      ) : null}
      {hasToggle ? (
        <>
          <FaceDot />
          {planOn ? (
            <ListChecks
              {...stylex.props(composerSurface.glyph14, styles.live)}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : null}
          {fastOn ? (
            <Zap
              {...stylex.props(composerSurface.glyph14, styles.live)}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : null}
        </>
      ) : null}
    </button>
  );
}
