/**
 * Which provider configs can use a built-in agent's interactive sign-in flow.
 *
 * Only the managed built-in agents (Claude Code / Codex / Kimi Code / Grok) have one.
 * A config that carries its own credentials in `env` — every preset such as
 * DeepSeek, MiniMax, MiMo, or GLM, plus hand-rolled configs pointed at an
 * OpenRouter/Ollama-style endpoint — authenticates through those variables
 * instead, so the provider's login flow can neither be started usefully nor
 * change anything about that config.
 */
import { isManagedBuiltinAgentType, type AgentConfigCliType } from './ai';
import { isAgentBrandId, type AgentBrandId } from './agent-brand';

/**
 * Env vars that supply credentials directly or route Claude through a
 * separately authenticated provider. Claude's native credential-store status
 * command does not reliably represent those paths, so the ACP adapter stays the
 * source of truth whenever one of them is configured.
 *
 * Codex, Kimi, and Grok have no equivalent list: their authentication requirement
 * is reported by the agent itself (Codex custom model providers may set
 * `requires_openai_auth = false`), never inferred from environment variables.
 */
const CLAUDE_ENV_AUTH_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_VERTEX_PROJECT_ID',
] as const;

/** True when `env` already authenticates the built-in agent by itself. */
export const hasBuiltinEnvAuthentication = (
  agentType: string,
  env: Record<string, string | undefined> | undefined
): boolean =>
  agentType === 'claude' && CLAUDE_ENV_AUTH_KEYS.some((key) => Boolean(env?.[key]?.trim()));

/**
 * True when the provider config can run (and re-run) the built-in interactive
 * sign-in flow. Callers use it to decide whether to offer a sign-in action at
 * all; a live probe reporting `authRequired` is a separate, stronger signal.
 */
export const supportsBuiltinAuthentication = (input: {
  cliType: AgentConfigCliType | null | undefined;
  agentType: string | null | undefined;
  brandId?: AgentBrandId | undefined;
  env?: Record<string, string | undefined> | undefined;
}): boolean => {
  if (input.cliType !== 'builtin') return false;
  const agentType = input.agentType;
  if (!agentType || !isManagedBuiltinAgentType(agentType)) return false;
  if (hasBuiltinEnvAuthentication(agentType, input.env)) return false;
  // A persisted brand marks a preset routed through a third-party provider even
  // when its env vars have since been edited away. Only the persisted marker is
  // consulted: a brand inferred from `ANTHROPIC_BASE_URL` is already covered by
  // the env check above for Claude, and means nothing on Codex, Kimi, or Grok.
  return !isAgentBrandId(input.brandId);
};

/**
 * True when the config is a third-party ACP provider, which authenticates
 * through the standard ACP `initialize` → `authenticate` exchange. The methods
 * are advertised by the agent itself, so support cannot be known for certain
 * until it is asked — callers pair this with a live `authRequired` signal rather
 * than offering a sign-in nothing asked for.
 */
export const usesAcpProtocolAuthentication = (
  cliType: AgentConfigCliType | null | undefined
): boolean => cliType === 'registry' || cliType === 'custom';

/**
 * True when Lody has any sign-in flow to offer for this config after the agent
 * reported that authentication is required.
 */
export const supportsAuthenticationWhenRequired = (input: {
  cliType: AgentConfigCliType | null | undefined;
  agentType: string | null | undefined;
}): boolean =>
  usesAcpProtocolAuthentication(input.cliType) ||
  (input.cliType === 'builtin' && !!input.agentType && isManagedBuiltinAgentType(input.agentType));
