import type { AcpConfigOptionValue } from './ai';
import type { AgentSessionDefaults } from './schema';

/**
 * Fills the gaps of one run configuration with a Provider's session defaults.
 * Whatever the request names — the model or any config option — stays exactly
 * as requested; a default only supplies what the request left out.
 */
export function withAgentSessionDefaults<
  T extends { modelId?: string; configOptionValues?: Record<string, AcpConfigOptionValue> },
>(config: T, defaults: AgentSessionDefaults | undefined): T {
  if (!defaults) return config;
  const configOptionValues = { ...defaults.configOptionValues, ...config.configOptionValues };
  return {
    ...config,
    ...(config.modelId || !defaults.modelId ? {} : { modelId: defaults.modelId }),
    ...(Object.keys(configOptionValues).length ? { configOptionValues } : {}),
  };
}
