import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import {
  assertManagedClaudeSettingsSafe,
  assertManagedClaudeSettingsValuesSafe,
} from './managed-claude-settings';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ resolveSettings: vi.fn() }));

describe('managed Claude settings authentication boundary', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    'ANTHROPIC_API_KEY',
    'anthropic_auth_token',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    'CLAUDE_CODE_HOST_CREDS_FILE',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    'CLAUDE_CODE_CUSTOM_OAUTH_URL',
    'CLAUDE_CODE_OAUTH_CLIENT_ID',
  ])('rejects %s without disclosing its value', (key) => {
    expect(() =>
      assertManagedClaudeSettingsValuesSafe({ env: { [key]: 'private-value' } })
    ).toThrow('cannot use settings that override authentication');
    try {
      assertManagedClaudeSettingsValuesSafe({ env: { [key]: 'private-value' } });
    } catch (error) {
      expect(String(error)).not.toContain('private-value');
    }
  });

  it.each([
    { apiKeyHelper: 'private-command' },
    { policyHelper: { path: 'private-path' } },
    'uninspected-settings.json',
    { env: 'uninspected-env' },
  ])('rejects uninspectable authentication settings', (settings) => {
    expect(() => assertManagedClaudeSettingsValuesSafe(settings)).toThrow();
  });

  it('preserves nonauthentication project and model settings', async () => {
    const settings = {
      model: 'opus',
      env: {
        ANTHROPIC_MODEL: 'custom',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom',
        CUSTOM_PROJECT_ENV: 'yes',
      },
      permissions: { deny: ['Read(private)'] },
      apiKeyHelper: '',
    };
    vi.mocked(resolveSettings).mockResolvedValue({
      effective: settings,
      sources: [],
      provenance: {},
    });
    await expect(assertManagedClaudeSettingsSafe('/project', settings)).resolves.toBeUndefined();
    expect(resolveSettings).toHaveBeenCalledWith({
      cwd: '/project',
      settingSources: ['user', 'project', 'local'],
    });
    expect(settings.env.CUSTOM_PROJECT_ENV).toBe('yes');
  });

  it('checks effective policy authentication and fails closed on resolver errors', async () => {
    vi.mocked(resolveSettings).mockResolvedValue({
      effective: { env: { ANTHROPIC_API_KEY: 'policy-secret' } },
      sources: [],
      provenance: {},
    });
    await expect(assertManagedClaudeSettingsSafe('/project')).rejects.toThrow(
      'override authentication'
    );
    vi.mocked(resolveSettings).mockRejectedValue(new Error('private-path private-secret'));
    await expect(assertManagedClaudeSettingsSafe('/project')).rejects.toThrow(
      'override authentication'
    );
    await expect(assertManagedClaudeSettingsSafe('/project')).rejects.not.toThrow('private-secret');
  });
});
