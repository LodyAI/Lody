export * from './utils';
export * from './auth';
export * from './app-location';
export * from './code-collab-session-file-provider';
export * from './file-workspace-provider';
export * from './session-file-provider-selection';
export * from './session-file-provider-view-model';
export * from './session-file-provider';
export * from './project-skills-cache';
export * from './local-project-skills-provider';
export { API_BASE_URL } from './api-base-url';
export const buildAgentPrompt = (prompt: string, agentPrompt = '') =>
  [agentPrompt, prompt].filter((part) => part?.trim()).join('\n\n');
