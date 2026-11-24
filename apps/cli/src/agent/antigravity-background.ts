import type { AgentConfigCliType } from '@lody/shared';

export const ANTIGRAVITY_ACP_SERVER_NAME = 'Antigravity ACP Server';

export interface AntigravityServerIdentityInput {
  agentConfig?: {
    cliType: AgentConfigCliType;
    agentType?: string;
  } | null;
  agentInfo?: {
    name?: string | null;
  } | null;
}

/**
 * Identify builtin or custom Antigravity ACP v1 servers while excluding legacy `antigravity-acp`.
 */
export function isAntigravityServer({
  agentConfig,
  agentInfo,
}: AntigravityServerIdentityInput): boolean {
  if (agentConfig?.cliType === 'builtin' && agentConfig.agentType === 'antigravity') {
    return true;
  }
  return agentInfo?.name === ANTIGRAVITY_ACP_SERVER_NAME;
}
