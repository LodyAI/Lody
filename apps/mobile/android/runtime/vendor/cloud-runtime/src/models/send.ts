import type { Project } from './catalog.ts';

export type CapabilityChoice = {
  id: string;
  name: string;
  description?: string;
};

export type ConfigOption = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: 'select' | 'boolean';
  currentValue?: string | boolean;
  options: CapabilityChoice[];
};

export type Capability = {
  machineId: string;
  /** The agent config (ACP provider) this was probed for; capabilities are per config, as web. */
  agentConfigId?: string;
  cliType: string;
  agentType: string;
  models: CapabilityChoice[];
  modes: CapabilityChoice[];
  // Actual legacy ACP modes, before the model picker folds in config selectors.
  legacyModes?: CapabilityChoice[];
  reasoningEfforts: Record<string, string[]>;
  fastModes?: Record<string, boolean>;
  reasoningEffortConfigId?: string;
  configOptions?: ConfigOption[];
  steer: boolean;
};

export type CreationOptions = {
  availability?: 'online' | 'offline' | 'unknown';
  onlineMachineIds?: string[];
  sessionId: string;
  project?: Project;
  agents: {
    id: string;
    name: string;
    machineId: string;
    machineName: string;
    cliType: string;
    agentType: string;
  }[];
  capabilities: Capability[];
};

export type ModelChoice = {
  modelId?: string;
  effort?: string;
  modeId?: string;
  configOptionValues?: Record<string, string | boolean>;
};

export type ProjectPrefs = ModelChoice & {
  machineId?: string;
  agentKey?: string;
};

export type CreatePrefs = {
  projectId?: string;
  context?: 'project' | 'chat';
  projects?: Record<string, ProjectPrefs>;
  modelChoices?: Record<string, ModelChoice>;
};
