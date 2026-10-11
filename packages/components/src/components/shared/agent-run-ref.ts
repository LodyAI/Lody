import type { AgentConfigId, ScheduleDefinition } from '@lody/shared';

/**
 * The agent a run is entrusted to. It intentionally does not carry a machine id:
 * the executing machine is resolved through the agent config, so a selection
 * follows its agent when the agent moves.
 */
export type AgentRunRef = Omit<ScheduleDefinition['agent'], 'agentConfigId'> & {
  agentConfigId: AgentConfigId;
};
