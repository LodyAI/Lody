import {
  resolveConfigOptionValue,
  type AcpConfigOptionSelector,
  type AcpConfigOptionValue,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';

/**
 * What "permission" even IS on a given agent.
 *
 * Its own module because three surfaces ask: the standalone permission button,
 * the run-config trigger face, and the Agent Role detail pane. They must not
 * drift into disagreeing about which knob carries permission — an explicit
 * `_permission` config option, a legacy ACP mode, or a plain mode selector
 * standing in for one.
 */
export type PermissionModeFace = {
  options: ReadonlyArray<AcpSessionSelectOption>;
  value: string | null;
  label: string | null;
  /**
   * What the resolved control actually is, so callers name it honestly.
   * Only an explicit `_permission` config option is a 'permission' knob;
   * legacy ACP modes and a mode-category selector standing in are 'mode' —
   * labelling an interaction-style mode list "Permission" misleads (the
   * Agent / Plan / Ask case).
   */
  semantics: 'permission' | 'mode';
  /**
   * The provider's own name for the selector when the control resolves to a
   * config option ("Mode", "Permission Mode", …); `null` for legacy modes.
   */
  selectorLabel: string | null;
  /**
   * Where that value lives, so a caller can ask whether something else — an
   * Agent Role — already pins it. `null` when this agent exposes no permission
   * control at all.
   */
  source: { kind: 'configOption'; configId: string } | { kind: 'modeId' } | null;
};

/**
 * What the permission control is showing.
 *
 * Explicit `_permission` config options outrank legacy ACP modes; with neither,
 * a plain mode selector stands in. The Role detail pane takes only the `source`
 * from this — the VALUE resolves through the agent's own current one, which is
 * never what a Role pinned.
 */
export function resolvePermissionModeFace({
  modeOptions,
  selectedModeId,
  configOptionSelectors = [],
  configOptionValues,
}: {
  modeOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModeId: string | null;
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
}): PermissionModeFace {
  const { permissionModeSelectors, modeSelectors } =
    orderAcpConfigOptionSelectors(configOptionSelectors);
  const explicitPermissionSelector = permissionModeSelectors[0];
  const modeConfigSelector: AcpSelectConfigOptionSelector | undefined =
    explicitPermissionSelector ?? modeSelectors[0];
  const usesConfigOption = Boolean(explicitPermissionSelector) || modeOptions.length === 0;
  const options = explicitPermissionSelector
    ? explicitPermissionSelector.options
    : modeOptions.length > 0
      ? modeOptions
      : (modeConfigSelector?.options ?? []);
  const value = usesConfigOption
    ? modeConfigSelector
      ? ((resolveConfigOptionValue(
          modeConfigSelector,
          configOptionValues?.[modeConfigSelector.configId]
        ) as string) ?? null)
      : null
    : selectedModeId;
  const source: PermissionModeFace['source'] = usesConfigOption
    ? modeConfigSelector
      ? { kind: 'configOption', configId: modeConfigSelector.configId }
      : null
    : { kind: 'modeId' };
  return {
    options,
    value,
    label: options.find((option) => option.value === value)?.label ?? null,
    semantics: explicitPermissionSelector ? 'permission' : 'mode',
    selectorLabel: modeConfigSelector?.label ?? null,
    source: options.length > 0 ? source : null,
  };
}

/**
 * The noun a control should name itself with. Real permission knobs keep the
 * translated "Permission"; everything else names itself — the provider's
 * selector label when it has one, else "Mode".
 */
export const permissionModeControlLabel = (
  face: Pick<PermissionModeFace, 'semantics' | 'selectorLabel'>,
  t: (key: string, defaultValue: string) => string
): string =>
  face.semantics === 'permission'
    ? t('chat.runConfig.permissionLabel', 'Permission')
    : (face.selectorLabel ?? t('chat.runConfig.modeLabel', 'Mode'));
