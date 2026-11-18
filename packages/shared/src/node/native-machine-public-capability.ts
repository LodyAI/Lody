import {
  isAcpFastModeConfigId,
  isAcpThoughtLevelConfigOption,
  LODY_PLAN_MODE_CONFIG_ID,
} from '../acp-run-config';
import { isSensitiveAcpConfigOptionId } from '../acp-config-option-sensitivity';
import type { AcpCapabilityCacheEntry } from '../ai';
import {
  getAcpCapabilityCacheEntryAuthority,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
} from '../ai';
import type { AgentConfigMeta } from '../schema';
import type {
  MachineCatalogPublicCapability,
  MachineCatalogQuotaEligibility,
} from '../machine-catalog';
import { machineCatalogPublicCapabilitySchema } from '../machine-catalog-ipc';
import { isSubscriptionQuotaEligible } from '../subscription-quota';
import { summarizeAgentRunConfigCapabilities } from '../acp-run-config';
import { resolveAgentBrandId } from '../agent-brand';

/** Validate the saved private launch identity in Node. The outward schema picks
 * every public field and strips all opaque extensions, including sourceVersion. */
export function projectMachinePublicCapability(
  config: AgentConfigMeta,
  entry: AcpCapabilityCacheEntry
): {
  publicCapability?: MachineCatalogPublicCapability;
  quotaEligibility: MachineCatalogQuotaEligibility;
} {
  const readable = getReadableAcpCapabilityCacheEntryForRuntimeOverrides(
    entry,
    config.runtimeOverrides
  );
  const matches = readable?.cliType === config.cliType && readable.agentType === config.agentType;
  const quotaEligibility = {
    subscription:
      !!matches && readable.rateLimits?.version === 1 && isSubscriptionQuotaEligible(config),
    query: !!matches && readable.rateLimits?.query === true,
    resetForecast:
      config.cliType === 'builtin' &&
      config.agentType === 'codex' &&
      Object.keys(config.env).length === 0 &&
      !resolveAgentBrandId(config),
  };
  if (!matches) return { quotaEligibility };
  const withheldOptionIds = new Set<string>();
  const publicOptions = (options: typeof readable.configOptions) =>
    options?.filter((option) => {
      const declared =
        ['model', 'mode', 'thought_level', '_permission'].includes(option.category ?? '') ||
        (config.cliType === 'builtin' &&
          (isAcpFastModeConfigId(option.id) ||
            isAcpThoughtLevelConfigOption(option) ||
            option.id === LODY_PLAN_MODE_CONFIG_ID));
      if (declared && !isSensitiveAcpConfigOptionId(option.id)) return true;
      withheldOptionIds.add(option.id);
      return false;
    });
  const configOptions = publicOptions(readable.configOptions);
  const observedModelConfigOptions = readable.observedModelConfigOptions
    ? Object.fromEntries(
        Object.entries(readable.observedModelConfigOptions).flatMap(([model, options]) => {
          const projected = publicOptions(options) ?? [];
          return projected.length || options.length === 0 ? [[model, projected]] : [];
        })
      )
    : undefined;
  const choices = summarizeAgentRunConfigCapabilities({
    ...readable,
    configOptions,
    observedModelConfigOptions,
  });
  const parsed = machineCatalogPublicCapabilitySchema.safeParse({
    cliType: readable.cliType,
    agentType: readable.agentType,
    authority: getAcpCapabilityCacheEntryAuthority(readable, config.runtimeOverrides),
    optionCoverage: {
      complete: withheldOptionIds.size === 0,
      withheldOptionIds: [...withheldOptionIds].sort(),
    },
    canValidateRolePins:
      readable.provenance === 'runtime' && (choices.models.length > 0 || choices.modes.length > 0),
    modes: readable.modes,
    models: readable.models,
    configOptions,
    availableCommands: readable.availableCommands,
    sessionFork: readable.sessionFork,
    sessionForkWorktree: readable.sessionForkWorktree,
    sessionTitle: readable.sessionTitle,
    acknowledgedSteer: readable.acknowledgedSteer,
    goalActions: readable.goalActions,
    modelReasoningEfforts: readable.modelReasoningEfforts,
    declaredModelControls: readable.declaredModelControls,
    observedModelConfigOptions,
  });
  // A secondary oversized capability view must not remove the provider list or
  // pretend that truncated choices prove a Role pin unavailable.
  if (
    !parsed.success ||
    new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > 256 * 1024
  )
    return { quotaEligibility };
  return { publicCapability: parsed.data, quotaEligibility };
}
