import type { AgentConfigListSummary, AgentConfigMeta, ProviderSetupTask } from '@lody/shared';
/** A list may contain the legacy full value or a native safe summary. Missing
 * private fields are unavailable, never an empty saved configuration. */
export type AgentConfigDisplay = AgentConfigListSummary &
  Partial<Omit<AgentConfigMeta, keyof AgentConfigListSummary>>;
export type ProviderSetupDisplay = Omit<ProviderSetupTask, 'config'> & {
  config: AgentConfigDisplay;
};
