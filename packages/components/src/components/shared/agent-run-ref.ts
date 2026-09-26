import type { AgentConfigId } from '@lody/shared';

/**
 * The agent a run is entrusted to. It intentionally does not carry a machine id:
 * the executing machine is resolved through the agent config, so a selection
 * follows its agent when the agent moves.
 */
export type AgentRunRef = {
  agentConfigId: AgentConfigId;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, string>;
};
