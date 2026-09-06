/**
 * Anthropic / Claude Code environment variables that affect authentication or
 * request routing. When a user has explicitly configured an auth/routing var
 * in Lody (e.g. via the DeepSeek or MiMo preset, or a manual config), other
 * conflicting vars inherited from the host shell or Claude's own settings can
 * silently override that choice. This list is the surface we scrub.
 *
 * Sourced from https://code.claude.com/docs/en/env-vars and
 * https://code.claude.com/docs/en/third-party-integrations.
 */
const CLAUDE_AUTH_ROUTING_KEYS = [
  // Direct Anthropic API auth
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  // Endpoint overrides
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  // Provider switches
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // Provider auth bypass
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  // Provider-specific auth/region
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  // Model selectors (a wrong model name from the host shell makes a third-party
  // gateway reject the request, even when auth is otherwise correct)
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

/** A managed subscription account must not inherit another authentication route. */
export function scrubManagedClaudeAccountEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_(USE_|SKIP_))/.test(key.toUpperCase()) ||
      key.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN'
    ) {
      delete result[key];
    }
  }
  return result;
}

/**
 * Keys that, when present in the user's agent config, signal explicit
 * auth/routing intent. Setting one of these means "I am choosing how Claude
 * reaches its provider"; other inherited routing/auth/model vars must not
 * silently override that choice.
 *
 * Model selectors are intentionally NOT triggers: setting `ANTHROPIC_MODEL`
 * alone (without auth/routing) does not imply the user wants to suppress
 * inherited credentials.
 */
const EXPLICIT_INTENT_TRIGGERS = new Set<string>([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

/**
 * Strip Anthropic/Claude auth, routing, and model env vars inherited from the
 * host shell when the user has an explicit auth/routing choice in their agent
 * config. Vars the user explicitly set in `userExplicitEnv` are preserved.
 *
 * Returns the input unchanged when no explicit intent is detected, so
 * subscription-based default Claude usage still inherits the host shell.
 */
export function scrubInheritedClaudeAuthEnv(
  mergedEnv: NodeJS.ProcessEnv,
  userExplicitEnv: Record<string, string>
): NodeJS.ProcessEnv {
  const explicitKeys = new Set(Object.keys(userExplicitEnv));
  let hasExplicitIntent = false;
  for (const key of explicitKeys) {
    if (EXPLICIT_INTENT_TRIGGERS.has(key)) {
      hasExplicitIntent = true;
      break;
    }
  }
  if (!hasExplicitIntent) return mergedEnv;

  const out: NodeJS.ProcessEnv = { ...mergedEnv };
  for (const key of CLAUDE_AUTH_ROUTING_KEYS) {
    if (!explicitKeys.has(key)) {
      delete out[key];
    }
  }
  return out;
}

export function shouldScrubClaudeAuthEnv(cliType: string, agentType: string): boolean {
  return (
    (cliType === 'builtin' && agentType === 'claude') ||
    (cliType === 'registry' && agentType === 'claude-p')
  );
}
