import { describe, expect, it } from 'vitest';
import {
  buildLodyCodexCustomProviderEnv,
  CODEX_API_KEY_ENV,
  CODEX_CONFIG_ENV,
  getLodyCodexCustomProvider,
  isAllowedCredentialEndpoint,
  LODY_CODEX_API_KEY_ENV,
  LODY_CODEX_MODEL_PROVIDER_ID,
  LODY_CODEX_PROVIDER_STATE_ENV,
  removeLodyCodexCustomProviderEnv,
} from '../src/codex-provider-config';

describe('Lody Codex custom provider config', () => {
  it('keeps the credential out of durable env and routes Codex through Responses', () => {
    const env = buildLodyCodexCustomProviderEnv(
      { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      { baseUrl: '  https://relay.example.com/v1  ', credentialRevision: 'revision-1' }
    );

    expect(env[CODEX_API_KEY_ENV]).toBeUndefined();
    expect(env[LODY_CODEX_API_KEY_ENV]).toBeUndefined();
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
      credentialRevision: 'revision-1',
    });
  });

  it('restores the exact prior selector and existing API key', () => {
    const original = {
      [CODEX_API_KEY_ENV]: 'old-user-key',
      EXTRA_FLAG: '1',
      [CODEX_CONFIG_ENV]: JSON.stringify({
        model: 'gpt-custom',
        model_provider: 'corp',
        model_providers: { corp: { base_url: 'https://existing.example.com' } },
      }),
    };
    const configured = buildLodyCodexCustomProviderEnv(original, {
      baseUrl: 'https://relay.example.com',
      credentialRevision: 'revision-1',
    });

    expect(removeLodyCodexCustomProviderEnv(configured)).toEqual(original);
  });

  it('rejects reserved-provider collisions and malformed config without rewriting either', () => {
    expect(() =>
      buildLodyCodexCustomProviderEnv(
        {
          [CODEX_CONFIG_ENV]: JSON.stringify({
            model_providers: { [LODY_CODEX_MODEL_PROVIDER_ID]: { base_url: 'https://corp.test' } },
          }),
        },
        { baseUrl: 'https://relay.example.com', credentialRevision: 'revision-1' }
      )
    ).toThrow(/already defines/);
    expect(() =>
      buildLodyCodexCustomProviderEnv(
        { [CODEX_CONFIG_ENV]: '{not-json' },
        { baseUrl: 'https://relay.example.com', credentialRevision: 'revision-1' }
      )
    ).toThrow(/JSON object/);
  });

  it('accepts HTTPS and loopback HTTP but rejects remote plaintext endpoints', () => {
    for (const value of [
      'https://example.com/v1',
      'http://localhost:8787/v1',
      'http://127.0.0.1:8787/v1',
      'http://127.42.0.9/v1',
      'http://[::1]:8787/v1',
    ]) {
      expect(isAllowedCredentialEndpoint(value)).toBe(true);
    }
    for (const value of [
      'http://example.com/v1',
      'http://192.168.1.2/v1',
      'ftp://localhost/v1',
      'https://user:password@example.com/v1',
    ]) {
      expect(isAllowedCredentialEndpoint(value)).toBe(false);
    }
  });

  it('does not claim arbitrary CODEX_CONFIG overrides without its ownership marker', () => {
    const env = {
      [CODEX_API_KEY_ENV]: 'sk-manual',
      [LODY_CODEX_PROVIDER_STATE_ENV]: '',
      [CODEX_CONFIG_ENV]: JSON.stringify({
        model_provider: 'manual',
        model_providers: { manual: { base_url: 'https://manual.example.com' } },
      }),
    };
    expect(getLodyCodexCustomProvider(env)).toBeNull();
    expect(removeLodyCodexCustomProviderEnv(env)).toEqual(env);
  });
});
