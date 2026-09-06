import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';

const AUTH_ENV_KEYS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
]);

const SETTINGS_ERROR =
  'Managed Claude accounts cannot use settings that override authentication. Remove the conflicting settings or use System Default.';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Never report settings values: they can contain credentials or helper commands. */
export function assertManagedClaudeSettingsValuesSafe(settings: unknown): void {
  if (settings === undefined) return;
  const values = record(settings);
  if (!values) throw new Error(SETTINGS_ERROR);
  if (values.apiKeyHelper || values.policyHelper) throw new Error(SETTINGS_ERROR);
  if (values.env === undefined) return;
  const env = record(values.env);
  if (!env) throw new Error(SETTINGS_ERROR);
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (AUTH_ENV_KEYS.has(normalized) || /^CLAUDE_CODE_(USE_|SKIP_)/.test(normalized)) {
      throw new Error(SETTINGS_ERROR);
    }
  }
}

/** Run only inside the managed child: the SDK reads this process's profile environment. */
export async function assertManagedClaudeSettingsSafe(
  cwd: string,
  settings?: unknown
): Promise<void> {
  assertManagedClaudeSettingsValuesSafe(settings);
  try {
    const resolved = await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
    assertManagedClaudeSettingsValuesSafe(resolved.effective);
  } catch {
    throw new Error(SETTINGS_ERROR);
  }
}
