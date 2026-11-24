import { isPerModelControlConfigId } from './acp-run-config';
import type { AcpConfigOptionValue } from './ai';
import type { AgentSessionDefaults } from './schema';

/**
 * Whether an option id in persisted `AgentSessionDefaults.configOptionValues` is
 * scoped to a single model rather than the whole session. Covers built-in effort
 * and speed ids (`reasoning_effort`, `effort`, `thought_level`, `fast-mode`, `fast`).
 */
export const isModelScopedSessionDefaultConfigId = (configId: string): boolean =>
  isPerModelControlConfigId(configId) || configId === 'thought_level';

/**
 * Resolves the effective `configOptionValues` from `AgentSessionDefaults` for a
 * specific `targetModelId`:
 * - Session-wide defaults (`mode`, `permission_mode`, `plan_mode`, etc.) always apply.
 * - Legacy flat model-scoped keys in `defaults.configOptionValues` apply only when
 *   `targetModelId` matches `defaults`'s own model (or neither names a model), so one
 *   model's saved `thought_level` / `fast-mode` never leaks onto another model.
 * - `defaults.modelConfigOptionValues[targetModelId]` overlays per-model choices.
 */
export function resolveSessionDefaultConfigOptionValues(
  defaults: AgentSessionDefaults | undefined,
  targetModelId: string | undefined
): Record<string, AcpConfigOptionValue> {
  if (!defaults) return {};
  const rawConfigOptionValues = defaults.configOptionValues ?? {};
  const defaultsModelId =
    defaults.modelId ??
    (typeof rawConfigOptionValues.model === 'string' ? rawConfigOptionValues.model : undefined);
  const matchesDefaultsModel =
    !defaultsModelId || !targetModelId || targetModelId === defaultsModelId;
  const resolved: Record<string, AcpConfigOptionValue> = {};
  for (const [configId, value] of Object.entries(rawConfigOptionValues)) {
    if (!matchesDefaultsModel && isModelScopedSessionDefaultConfigId(configId)) {
      continue;
    }
    resolved[configId] = value;
  }
  if (targetModelId) {
    const perModel = defaults.modelConfigOptionValues?.[targetModelId];
    if (perModel) {
      Object.assign(resolved, perModel);
    }
  }
  return resolved;
}

/**
 * Fills the gaps of one run configuration with a Provider's session defaults.
 * Whatever the request names — the model or any config option — stays exactly
 * as requested; a default only supplies what the request left out.
 */
export function withAgentSessionDefaults<
  T extends { modelId?: string; configOptionValues?: Record<string, AcpConfigOptionValue> },
>(config: T, defaults: AgentSessionDefaults | undefined): T {
  if (!defaults) return config;
  const effectiveModelId =
    config.modelId ??
    (typeof config.configOptionValues?.model === 'string'
      ? config.configOptionValues.model
      : undefined) ??
    defaults.modelId ??
    (typeof defaults.configOptionValues?.model === 'string'
      ? defaults.configOptionValues.model
      : undefined);
  const baseValues = resolveSessionDefaultConfigOptionValues(defaults, effectiveModelId);
  const configOptionValues = { ...baseValues, ...config.configOptionValues };
  return {
    ...config,
    ...(config.modelId || !defaults.modelId ? {} : { modelId: defaults.modelId }),
    ...(Object.keys(configOptionValues).length ? { configOptionValues } : {}),
  };
}
