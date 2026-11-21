/*
 * The Models page reads the model catalog returned by Sorbet control through
 * the harness store. The ACP capability cache remains only for config-option
 * metadata such as the reasoning-effort selector.
 *
 * What a Sorbet entry can say (see `AcpCapabilityCacheEntry`):
 *   models        — the probe's model list; custom-endpoint models land here
 *                   too, so they need no manual merge from the store.
 *   configOptions — the session's selects, keyed by category:
 *                   'model' for the one model pick, 'thought_level' /
 *                   `reasoning_effort` for the effort ladder.
 *
 * One capability entry serves both Main and Subagent selects: ACP exposes a
 * single model choice per session, so the second row's pick stays in the
 * harness store until Sorbet grows a sub-model contract.
 */
import { useMemo } from 'react';
import {
  getAcpCapabilityCacheKey,
  getMachineFlockAcpCapabilities,
  isAcpThoughtLevelConfigOption,
  ACP_CAPABILITY_ROW_FAMILIES,
  type AcpCapabilityCacheEntry,
  type AcpConfigOptionSummary,
  type MachineId,
  type ModelInfo,
} from '@lody/shared';

import { useMachineFlockRows } from '@/hooks/use-machine-flock-rows';

import { useSorbetTarget } from './sorbet';
import { availableModels, useHarness } from './store';

/** What the Models page renders one ACP model as, after the modelOption fold. */
export interface HarnessModel {
  id: string;
  name: string;
  /** Option-group name, when the agent grouped its model select. */
  group?: string;
  /**
   * What the option or model says about itself — a group name, the probe's
   * `_meta.contextWindow`, or the model's description. Shown where the drawn
   * list put `tier · context`; ACP advertises neither, so nothing is invented.
   */
  meta?: string;
}

export type DeviceCapabilityStatus = 'no-agent' | 'loading' | 'ready';

export interface DeviceCapabilities {
  /** The cached ACP entry used only for config-option metadata. */
  capability: AcpCapabilityCacheEntry | undefined;
  /** The model pool returned by `control.providers.availableModels()`. */
  models: HarnessModel[];
  /** The select that carries the model choice (category 'model'), if any. */
  modelOption: AcpConfigOptionSummary | undefined;
  /** The effort ladder (`thought_level` / `reasoning_effort`), if the agent has one. */
  effortOption: AcpConfigOptionSummary | undefined;
  /**
   * no-agent — the page's machine or its Sorbet config is unresolved, so no
   *            entry can exist yet
   * loading  — a config is resolved but no probe has answered for it
   * ready    — an entry exists; `models` may still be empty and is honest about it
   */
  status: DeviceCapabilityStatus;
}

const findOption = (
  capability: AcpCapabilityCacheEntry | undefined,
  predicate: (option: AcpConfigOptionSummary) => boolean
): AcpConfigOptionSummary | undefined => capability?.configOptions?.find(predicate);

const metaText = (meta: ModelInfo['_meta'], key: string): string | undefined => {
  const value = meta?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
  }
  return typeof value === 'string' && value.trim() ? value : undefined;
};

/** One entry's model pool, preferring the richer select summary over `models`. */
export function capabilityModels(capability: AcpCapabilityCacheEntry | undefined): HarnessModel[] {
  const modelOption = findOption(
    capability,
    (option) => option.category === 'model' && option.type === 'select'
  );
  if (modelOption?.options.length) {
    return modelOption.options.map((option) => ({
      id: option.value,
      name: option.name,
      group: option.group,
      meta: option.group ?? option.description,
    }));
  }
  return (capability?.models ?? []).map((model) => ({
    id: model.modelId,
    name: model.name,
    meta: metaText(model._meta, 'contextWindow') ?? model.description ?? undefined,
  }));
}

/** The Models page's view of the machine the bridge resolved. */
export function useDeviceCapabilities(): DeviceCapabilities {
  const target = useSorbetTarget();
  const harness = useHarness();
  const rows = useMachineFlockRows(target?.machineId as MachineId | null, {
    families: [...ACP_CAPABILITY_ROW_FAMILIES],
  });
  const capability = useMemo(
    () =>
      target
        ? getMachineFlockAcpCapabilities(rows)[getAcpCapabilityCacheKey(target.configId)]
        : undefined,
    [rows, target]
  );
  const controlModels = useMemo<HarnessModel[]>(
    () =>
      availableModels(harness).map((model) => ({
        id: model.id,
        name: model.name,
        meta: model.context,
      })),
    [harness]
  );
  return useMemo<DeviceCapabilities>(
    () => ({
      capability,
      models: controlModels,
      modelOption: findOption(
        capability,
        (option) => option.category === 'model' && option.type === 'select'
      ),
      effortOption: findOption(
        capability,
        (option) => option.type === 'select' && isAcpThoughtLevelConfigOption(option)
      ),
      status: !target ? 'no-agent' : harness.status === 'loading' ? 'loading' : 'ready',
    }),
    [capability, controlModels, harness.status, target]
  );
}
