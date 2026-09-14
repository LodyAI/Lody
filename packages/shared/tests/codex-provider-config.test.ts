import { describe, expect, it } from 'vitest';
import {
  buildLodyCodexCustomProviderEnv,
  CODEX_CONFIG_ENV,
  getLodyCodexCustomProvider,
  hasLodyCodexApiKeyAuthentication,
  isAllowedCodexEndpoint,
  LODY_CODEX_API_KEY_ENV,
  LODY_CODEX_MODEL_PROVIDER_ID,
  LODY_CODEX_PROVIDER_STATE_ENV,
  removeLodyCodexCustomProviderEnv,
} from '../src/codex-provider-config';

describe('Lody Codex custom provider config', () => {
  it('stores routing and the API key in the AgentConfig environment', () => {
    const env = buildLodyCodexCustomProviderEnv(
      { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      { baseUrl: '  https://relay.example.com/v1  ', apiKey: '  sk-relay  ' }
    );

    expect(env[LODY_CODEX_API_KEY_ENV]).toBe('sk-relay');
    expect(JSON.parse(env[CODEX_CONFIG_ENV]!)).toMatchObject({
      model_provider: LODY_CODEX_MODEL_PROVIDER_ID,
      model_providers: {
        [LODY_CODEX_MODEL_PROVIDER_ID]: {
          base_url: 'https://relay.example.com/v1',
          env_key: LODY_CODEX_API_KEY_ENV,
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
    });
    expect(getLodyCodexCustomProvider(env)).toEqual({
      baseUrl: 'https://relay.example.com/v1',
    });
    expect(hasLodyCodexApiKeyAuthentication(env)).toBe(true);
  });

  it('restores the prior provider selection without disturbing unrelated env', () => {
    const original = {
      OPENAI_API_KEY: 'existing-user-key',
      EXTRA_FLAG: '1',
      [CODEX_CONFIG_ENV]: JSON.stringify({
        model: 'gpt-custom',
        model_provider: 'corp',
        model_providers: { corp: { base_url: 'https://existing.example.com' } },
      }),
    };
    const configured = buildLodyCodexCustomProviderEnv(original, {
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
    });

    expect(removeLodyCodexCustomProviderEnv(configured)).toEqual(original);
  });

  it('updates an existing generated provider and replaces its key', () => {
    const first = buildLodyCodexCustomProviderEnv(
      {},
      { baseUrl: 'https://one.example.com/v1', apiKey: 'sk-one' }
    );
    const second = buildLodyCodexCustomProviderEnv(first, {
      baseUrl: 'https://two.example.com/v1',
      apiKey: 'sk-two',
    });

    expect(getLodyCodexCustomProvider(second)).toEqual({
      baseUrl: 'https://two.example.com/v1',
    });
    expect(second[LODY_CODEX_API_KEY_ENV]).toBe('sk-two');
    expect(removeLodyCodexCustomProviderEnv(second)).toEqual({});
  });

  it('requires the referenced API key before treating the config as authenticated', () => {
    const env = buildLodyCodexCustomProviderEnv(
      {},
      { baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-relay' }
    );
    delete env[LODY_CODEX_API_KEY_ENV];

    expect(getLodyCodexCustomProvider(env)).not.toBeNull();
    expect(hasLodyCodexApiKeyAuthentication(env)).toBe(false);
  });

  it('rejects collisions and malformed configuration instead of overwriting them', () => {
    expect(() =>
      buildLodyCodexCustomProviderEnv(
        {
          [CODEX_CONFIG_ENV]: JSON.stringify({
            model_providers: { [LODY_CODEX_MODEL_PROVIDER_ID]: { base_url: 'https://corp.test' } },
          }),
        },
        { baseUrl: 'https://relay.example.com', apiKey: 'sk-relay' }
      )
    ).toThrow(/already defines/);
    expect(() =>
      buildLodyCodexCustomProviderEnv(
        { [CODEX_CONFIG_ENV]: '{not-json' },
        { baseUrl: 'https://relay.example.com', apiKey: 'sk-relay' }
      )
    ).toThrow(/JSON object/);
    expect(() =>
      buildLodyCodexCustomProviderEnv(
        { [LODY_CODEX_PROVIDER_STATE_ENV]: '{not-json' },
        { baseUrl: 'https://relay.example.com', apiKey: 'sk-relay' }
      )
    ).toThrow(/already defined/);
  });

  it('accepts HTTPS and loopback HTTP but rejects remote plaintext endpoints', () => {
    for (const value of [
      'https://example.com/v1',
      'http://localhost:8787/v1',
      'http://127.0.0.1:8787/v1',
      'http://127.42.0.9/v1',
      'http://[::1]:8787/v1',
    ]) {
      expect(isAllowedCodexEndpoint(value)).toBe(true);
    }
    for (const value of [
      'http://example.com/v1',
      'http://192.168.1.2/v1',
      'ftp://localhost/v1',
      'https://user:password@example.com/v1',
    ]) {
      expect(isAllowedCodexEndpoint(value)).toBe(false);
    }
  });

  it('does not claim arbitrary CODEX_CONFIG overrides', () => {
    const env = {
      [LODY_CODEX_API_KEY_ENV]: 'sk-manual',
      [CODEX_CONFIG_ENV]: JSON.stringify({
        model_provider: 'manual',
        model_providers: { manual: { base_url: 'https://manual.example.com' } },
      }),
    };

    expect(getLodyCodexCustomProvider(env)).toBeNull();
    expect(removeLodyCodexCustomProviderEnv(env)).toEqual(env);
  });
});
