import { describe, expect, it } from 'vitest';
import {
  hasBuiltinEnvAuthentication,
  supportsAuthenticationWhenRequired,
  supportsBuiltinAuthentication,
  usesAcpProtocolAuthentication,
} from '../src/agent-authentication';

describe('hasBuiltinEnvAuthentication', () => {
  it('detects Claude credentials and provider routing supplied by env', () => {
    expect(hasBuiltinEnvAuthentication('claude', { ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
    expect(hasBuiltinEnvAuthentication('claude', { ANTHROPIC_AUTH_TOKEN: 'sk-test' })).toBe(true);
    expect(
      hasBuiltinEnvAuthentication('claude', {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      })
    ).toBe(true);
    expect(hasBuiltinEnvAuthentication('claude', { CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(true);
  });

  it('ignores unrelated or blank variables', () => {
    expect(hasBuiltinEnvAuthentication('claude', undefined)).toBe(false);
    expect(hasBuiltinEnvAuthentication('claude', {})).toBe(false);
    expect(hasBuiltinEnvAuthentication('claude', { HTTPS_PROXY: 'http://127.0.0.1:7890' })).toBe(
      false
    );
    expect(hasBuiltinEnvAuthentication('claude', { ANTHROPIC_API_KEY: '  ' })).toBe(false);
    expect(hasBuiltinEnvAuthentication('claude', { ANTHROPIC_API_KEY: undefined })).toBe(false);
  });

  it('does not infer env authentication for agents that report it themselves', () => {
    // Codex custom model providers may set `requires_openai_auth = false`, so the
    // agent — not an env heuristic — decides whether sign-in is required.
    expect(hasBuiltinEnvAuthentication('codex', { OPENAI_API_KEY: 'sk-test' })).toBe(false);
    expect(hasBuiltinEnvAuthentication('kimi', { MOONSHOT_API_KEY: 'sk-test' })).toBe(false);
    expect(hasBuiltinEnvAuthentication('grok', { XAI_API_KEY: 'xai-test' })).toBe(false);
    expect(hasBuiltinEnvAuthentication('auggie', { ANTHROPIC_API_KEY: 'sk-test' })).toBe(false);
  });
});

describe('supportsBuiltinAuthentication', () => {
  it('allows sign-in for managed built-in agents without env credentials', () => {
    for (const agentType of ['claude', 'codex', 'kimi', 'grok']) {
      expect(supportsBuiltinAuthentication({ cliType: 'builtin', agentType, env: {} })).toBe(true);
    }
  });

  it('keeps sign-in available when env only carries unrelated variables', () => {
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      })
    ).toBe(true);
  });

  it('refuses sign-in for preset providers configured through env variables', () => {
    // DeepSeek / MiniMax / MiMo / GLM presets all run as builtin Claude Code.
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        brandId: 'deepseek',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'sk-test',
        },
      })
    ).toBe(false);
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        env: { ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic' },
      })
    ).toBe(false);
  });

  it('refuses sign-in when only the brand survives an env edit', () => {
    expect(
      supportsBuiltinAuthentication({ cliType: 'builtin', agentType: 'claude', brandId: 'mimo' })
    ).toBe(false);
  });

  it('refuses sign-in for hand-rolled endpoint overrides', () => {
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        env: {
          ANTHROPIC_BASE_URL: 'http://localhost:11434',
          ANTHROPIC_AUTH_TOKEN: 'ollama',
        },
      })
    ).toBe(false);
  });

  it('refuses the builtin login flow for registry and custom providers', () => {
    expect(supportsBuiltinAuthentication({ cliType: 'registry', agentType: 'gemini' })).toBe(false);
    expect(supportsBuiltinAuthentication({ cliType: 'custom', agentType: 'my-agent' })).toBe(false);
    expect(supportsBuiltinAuthentication({ cliType: 'builtin', agentType: 'auggie' })).toBe(false);
    expect(supportsBuiltinAuthentication({ cliType: undefined, agentType: undefined })).toBe(false);
  });
});

describe('usesAcpProtocolAuthentication', () => {
  it('covers exactly the third-party ACP providers', () => {
    expect(usesAcpProtocolAuthentication('registry')).toBe(true);
    expect(usesAcpProtocolAuthentication('custom')).toBe(true);
    expect(usesAcpProtocolAuthentication('builtin')).toBe(false);
    expect(usesAcpProtocolAuthentication(undefined)).toBe(false);
  });
});

describe('supportsAuthenticationWhenRequired', () => {
  it('offers the ACP exchange to registry and custom agents', () => {
    // The whole point: a registry agent reporting auth-required used to have no
    // way to sign in at all.
    expect(
      supportsAuthenticationWhenRequired({ cliType: 'registry', agentType: 'antigravity-acp' })
    ).toBe(true);
    expect(supportsAuthenticationWhenRequired({ cliType: 'custom', agentType: 'my-agent' })).toBe(
      true
    );
  });

  it('keeps the managed builtin login flow and excludes providers with neither', () => {
    expect(supportsAuthenticationWhenRequired({ cliType: 'builtin', agentType: 'codex' })).toBe(
      true
    );
    // DeepSeek Harness authenticates purely through env vars.
    expect(supportsAuthenticationWhenRequired({ cliType: 'builtin', agentType: 'deepseek' })).toBe(
      false
    );
    expect(supportsAuthenticationWhenRequired({ cliType: undefined, agentType: undefined })).toBe(
      false
    );
  });
});
