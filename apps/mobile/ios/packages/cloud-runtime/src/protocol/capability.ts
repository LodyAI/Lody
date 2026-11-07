import type { Capability, ModelChoice, ConfigOption } from '../models/send.ts';

export const isThoughtLevel = (option: ConfigOption) =>
  option.type === 'select' &&
  (option.category === 'thought_level' || option.id === 'reasoning_effort');

export const validConfigValue = (option: ConfigOption, value: unknown) =>
  option.type === 'boolean'
    ? typeof value === 'boolean'
    : typeof value === 'string' &&
      option.options.some((item) => item.id === value);

export function effortsFor(capability?: Capability, modelId?: string) {
  const model =
    modelId ??
    capability?.configOptions?.find((option) => option.category === 'model')
      ?.currentValue;
  if (typeof model === 'string' && capability?.reasoningEfforts[model])
    return capability.reasoningEfforts[model];
  // Agents without a per-model catalog publish the current ladder in configOptions.
  return (
    capability?.configOptions
      ?.find(isThoughtLevel)
      ?.options.map((option) => option.id) ?? []
  );
}

export function fastModeFor(
  capability: Capability | undefined,
  choice: ModelChoice,
) {
  const model =
    choice.modelId ??
    capability?.configOptions?.find((o) => o.category === 'model')
      ?.currentValue;
  if (typeof model === 'string' && capability?.fastModes?.[model] === false)
    return undefined;
  const option = capability?.configOptions?.find(
    (item) =>
      ['fast-mode', 'fast'].includes(item.id) && item.type === 'boolean',
  );
  if (!option) return undefined;
  const value = choice.configOptionValues?.[option.id] ?? option.currentValue;
  return { id: option.id, enabled: value === true };
}

export function withFastMode(
  capability: Capability | undefined,
  choice: ModelChoice,
  enabled: boolean,
): ModelChoice {
  const mode = fastModeFor(capability, choice);
  if (!mode) return choice;
  return {
    ...choice,
    configOptionValues: { ...choice.configOptionValues, [mode.id]: enabled },
  };
}

// Match OSS resolvePermissionModeFace: explicit permissions, legacy modes,
// then a generic mode selector. Interaction mode is a separate control.
export function permissionModeFor(
  capability: Capability | undefined,
  choice: ModelChoice,
) {
  const selectors =
    capability?.configOptions?.filter((item) => item.type === 'select') ?? [];
  let option = selectors.find(
    (item) => item.id === 'permission_mode' || item.category === '_permission',
  );
  const modes = capability?.legacyModes ?? capability?.modes ?? [];
  if (!option && modes.length) {
    return {
      options: modes,
      value: choice.modeId,
      configId: undefined,
    };
  }
  option ??= selectors.find(
    (item) =>
      item.category === 'mode' &&
      item.id !== 'interaction_mode' &&
      !isThoughtLevel(item),
  );
  if (!option?.options.length) return undefined;
  const selected = choice.configOptionValues?.[option.id];
  const value = validConfigValue(option, selected)
    ? selected
    : option.currentValue;
  return {
    options: option.options,
    value: typeof value === 'string' ? value : undefined,
    configId: option.id,
  };
}

export function withPermissionMode(
  capability: Capability | undefined,
  choice: ModelChoice,
  value: string,
): ModelChoice {
  const permission = permissionModeFor(capability, choice);
  if (!permission?.options.some((item) => item.id === value)) return choice;
  if (permission.configId)
    return {
      ...choice,
      configOptionValues: {
        ...choice.configOptionValues,
        [permission.configId]: value,
      },
    };
  return { ...choice, modeId: value };
}
