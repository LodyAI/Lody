/**
 * Brand identity for an agent config / session, independent of the runtime
 * `agentType`. Preset-created agents (DeepSeek / MiMo / MiniMax over Claude
 * Code) all run as `builtin`/`claude` but route through a third-party provider;
 * `brandId` lets the UI render the provider's icon instead of the Claude icon
 * without overloading `agentType` (which is load-bearing for the runtime).
 */
export const AGENT_BRAND_IDS = ['deepseek', 'mimo', 'minimax', 'glm'] as const;

export type AgentBrandId = (typeof AGENT_BRAND_IDS)[number];

export function isAgentBrandId(value: unknown): value is AgentBrandId {
  return typeof value === 'string' && (AGENT_BRAND_IDS as readonly string[]).includes(value);
}

/**
 * Host suffixes used to recognize a provider from `ANTHROPIC_BASE_URL` for
 * agents created before `brandId` was persisted (and for hand-rolled Claude
 * configs pointed at a known provider). MiMo's custom token-plan base URL is
 * user-supplied and intentionally not matchable here — those rely on the
 * persisted `brandId` instead.
 */
const BRAND_HOST_SUFFIXES: Record<AgentBrandId, readonly string[]> = {
  deepseek: ['deepseek.com'],
  mimo: ['xiaomimimo.com'],
  minimax: ['minimaxi.com', 'minimax.io'],
  glm: ['bigmodel.cn', 'z.ai'],
};

function brandIdFromEnv(env: Record<string, string> | undefined): AgentBrandId | undefined {
  const baseUrl = env?.ANTHROPIC_BASE_URL;
  if (!baseUrl) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const brandId of AGENT_BRAND_IDS) {
    const matched = BRAND_HOST_SUFFIXES[brandId].some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );
    if (matched) return brandId;
  }
  return undefined;
}

/**
 * Resolve the brand for an agent. Prefers the explicitly persisted `brandId`,
 * falling back to detecting a known provider from `env.ANTHROPIC_BASE_URL`.
 * Returns `undefined` for plain Claude / Codex / registry agents.
 */
export function resolveAgentBrandId(input: {
  brandId?: AgentBrandId | undefined;
  env?: Record<string, string> | undefined;
}): AgentBrandId | undefined {
  if (isAgentBrandId(input.brandId)) return input.brandId;
  return brandIdFromEnv(input.env);
}
