export type UsageWindow = {
  label?: string;
  usedPercent: number;
  duration: number | null;
  resetsAt: number | null;
};
export type AgentQuota = {
  id: string;
  provider: string;
  agentConfigId?: string | null;
  name?: string;
  windows: UsageWindow[];
};
export type AgentUsage = {
  configs: {
    id: string;
    name: string;
    provider: string;
    eligible: boolean;
    rateLimitsAvailable?: boolean;
  }[];
  quotas: AgentQuota[];
};
