import type { AgentConfigMeta } from './schema';
import { CLAUDE_ENV_AUTH_KEYS } from './agent-authentication';

export type SubscriptionQuotaConfig = Pick<AgentConfigMeta, 'cliType' | 'agentType'> &
  Partial<Pick<AgentConfigMeta, 'env' | 'brandId' | 'codexAuth' | 'magpieGatewayUrl'>>;

// These change credential/config discovery or execute code before the adapter.
// Ordinary tool credentials (e.g. OP_TOKEN) and locale/logging settings are unrelated.
const COMMON_ACCOUNT_ENV = new Set([
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

// Claude's usage.ts reads native OAuth credentials, independently of SDK auth.
// Reuse the SDK auth/routing keys, plus alternate OAuth/config entry points.
const CLAUDE_ACCOUNT_ENV = new Set([
  ...CLAUDE_ENV_AUTH_KEYS,
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
]);

// Codex adapter index.ts accepts config/provider/auth overrides; the native
// account reader also honors these credential and endpoint inputs.
const CODEX_ACCOUNT_ENV = new Set([
  'CODEX_HOME',
  'CODEX_PATH',
  'CODEX_CONFIG',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CLIENT_ID',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_AUTH_CLIENT_ID',
  'LODY_CODEX_API_KEY',
  'LODY_CODEX_PROFILE_CONFIG',
  'MODEL_PROVIDER',
  'DEFAULT_AUTH_REQUEST',
]);

// Grok delegates quota to native x.ai/billing. XAI_API_KEY is the official
// runtime's API auth input; homes/config/model overrides can select custom routes
// (also used by Lody's magpie-runtime.ts).
const GROK_ACCOUNT_ENV = new Set([
  'XAI_API_KEY',
  'GROK_PATH',
  'GROK_HOME',
  'GROK_CONFIG',
  'GROK_DEFAULT_MODEL',
  'GROK_WEB_SEARCH_MODEL',
]);

/** Account eligibility only. Callers must also require the advertised quota
 * capability and select snapshots belonging to the exact Provider config. */
export function isSubscriptionQuotaEligible(config: SubscriptionQuotaConfig): boolean {
  // Custom/registry adapters own their declared account semantics.
  if (config.cliType !== 'builtin') return true;
  if (config.brandId || Boolean(config.magpieGatewayUrl) || config.codexAuth?.mode === 'api-key') {
    return false;
  }

  // Match case-insensitively for Windows too. Presence is conservative even for
  // empty overrides: clearing an inherited credential can change account choice.
  const keys = Object.keys(config.env ?? {}).map((key) => key.toUpperCase());
  if (keys.some((key) => COMMON_ACCOUNT_ENV.has(key))) return false;
  switch (config.agentType) {
    case 'claude':
      return !keys.some((key) => CLAUDE_ACCOUNT_ENV.has(key));
    case 'codex':
      return !keys.some((key) => CODEX_ACCOUNT_ENV.has(key));
    case 'grok':
      return !keys.some((key) => GROK_ACCOUNT_ENV.has(key));
    default:
      // Other builtin adapters retain their existing policy until their quota
      // credential paths have been audited.
      return keys.length === 0;
  }
}
