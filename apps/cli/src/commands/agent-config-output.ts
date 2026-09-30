import type { AgentConfigMeta } from '@lody/shared';

// A presentation contract, never a persisted/launch config. Explicit fields keep
// future runtime credentials out of output without depending on secret names.
export type AgentConfigOutput = Pick<
  AgentConfigMeta,
  'id' | 'machineId' | 'name' | 'agentType' | 'description' | 'prompt' | 'titleGeneration'
> & {
  envKeys: string[];
  env?: Record<string, string>;
};

export function toAgentConfigOutput(
  config: AgentConfigMeta,
  showSecrets = false
): AgentConfigOutput {
  return {
    id: config.id,
    machineId: config.machineId,
    name: config.name,
    agentType: config.agentType,
    description: config.description,
    prompt: config.prompt,
    titleGeneration: config.titleGeneration
      ? { configOptionValues: config.titleGeneration.configOptionValues }
      : undefined,
    envKeys: Object.keys(config.env).sort(),
    ...(showSecrets ? { env: { ...config.env } } : {}),
  };
}
