import { describe, expect, it } from 'vitest';
import { isSubscriptionQuotaEligible } from '../src/subscription-quota';
import { assertManagedCodexProfileConfig } from '../src/codex-auth-profile';

describe('subscription quota account eligibility', () => {
  it.each(['codex', 'claude', 'grok'])('allows ordinary tool settings for %s', (agentType) => {
    expect(
      isSubscriptionQuotaEligible({
        cliType: 'builtin',
        agentType,
        env: { OP_TOKEN: 'synthetic', LANG: 'en_US.UTF-8', HTTP_PROXY: 'http://localhost:8080' },
      })
    ).toBe(true);
  });

  it.each([
    ['claude', 'ANTHROPIC_API_KEY'],
    ['claude', 'ANTHROPIC_BASE_URL'],
    ['claude', 'CLAUDE_CODE_USE_BEDROCK'],
    ['claude', 'CLAUDE_CODE_USE_VERTEX'],
    ['claude', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['claude', 'CLAUDE_CONFIG_DIR'],
    ['codex', 'OPENAI_API_KEY'],
    ['codex', 'CODEX_HOME'],
    ['codex', 'CODEX_CONFIG'],
    ['codex', 'MODEL_PROVIDER'],
    ['codex', 'DEFAULT_AUTH_REQUEST'],
    ['grok', 'XAI_API_KEY'],
    ['grok', 'GROK_HOME'],
    ['grok', 'GROK_CONFIG'],
    ['grok', 'GROK_DEFAULT_MODEL'],
  ])('rejects %s account override %s, including empty and Windows casing', (agentType, key) => {
    for (const env of [{ [key]: 'synthetic' }, { [key.toLowerCase()]: '' }]) {
      expect(isSubscriptionQuotaEligible({ cliType: 'builtin', agentType, env })).toBe(false);
    }
  });

  it('allows managed ChatGPT profiles with tool credentials but preserves profile validation', () => {
    const config = {
      cliType: 'builtin',
      agentType: 'codex',
      env: { OP_TOKEN: 'synthetic' },
      codexAuth: { mode: 'chatgpt' as const, profileId: '60a84cb4-50fd-4590-9f69-6055ffef0c57' },
    };
    expect(() => assertManagedCodexProfileConfig(config)).not.toThrow();
    expect(isSubscriptionQuotaEligible({ ...config, cliType: 'builtin' })).toBe(true);
    expect(() =>
      assertManagedCodexProfileConfig({ ...config, env: { CODEX_HOME: '/other' } })
    ).toThrow();
    expect(
      isSubscriptionQuotaEligible({
        ...config,
        cliType: 'builtin',
        codexAuth: { ...config.codexAuth, mode: 'api-key', baseUrl: 'https://example.test/v1' },
      })
    ).toBe(false);
  });

  it.each(['codex', 'claude', 'grok'])(
    'keeps third-party and home overrides isolated for %s',
    (agentType) => {
      const config = { cliType: 'builtin' as const, agentType };
      expect(isSubscriptionQuotaEligible({ ...config, brandId: 'deepseek' })).toBe(false);
      expect(
        isSubscriptionQuotaEligible({ ...config, magpieGatewayUrl: 'http://localhost:9000' })
      ).toBe(false);
      expect(isSubscriptionQuotaEligible({ ...config, env: { HOME: '/other' } })).toBe(false);
    }
  );

  it('does not apply another runtime’s credential keys or change other adapter policies', () => {
    expect(
      isSubscriptionQuotaEligible({
        cliType: 'builtin',
        agentType: 'codex',
        env: { ANTHROPIC_API_KEY: 'tool-key' },
      })
    ).toBe(true);
    expect(
      isSubscriptionQuotaEligible({
        cliType: 'custom',
        agentType: 'example',
        env: { XAI_API_KEY: 'synthetic' },
      })
    ).toBe(true);
    expect(
      isSubscriptionQuotaEligible({
        cliType: 'builtin',
        agentType: 'kimi',
        env: { TOOL_TOKEN: 'synthetic' },
      })
    ).toBe(false);
    expect(isSubscriptionQuotaEligible({ cliType: 'builtin', agentType: 'kimi', env: {} })).toBe(
      true
    );
  });
});
