import { describe, expect, it } from 'vitest';
import {
  agentConfigContainsCodexCredential,
  assertAgentConfigDoesNotContainCodexCredential,
  buildLodyCodexCustomProviderEnv,
  CODEX_API_KEY_ENV,
  CODEX_CONFIG_ENV,
  getLodyCodexCredentialBinding,
  getLodyCodexCustomProvider,
  isAllowedCredentialEndpoint,
  isReservedCodexCredentialEnvKey,
  LODY_CODEX_API_KEY_ENV,
  LODY_CODEX_MODEL_PROVIDER_ID,
  LODY_CODEX_PROVIDER_STATE_ENV,
  removeLodyCodexCustomProviderEnv,
  withLodyCodexCredentialRevision,
} from '../src/codex-provider-config';

describe('Lody Codex custom provider config', () => {
  it('reserves the machine-local credential key even when its value is empty', () => {
    const config = { env: { [LODY_CODEX_API_KEY_ENV]: '' } };

    expect(agentConfigContainsCodexCredential(config)).toBe(true);
    expect(() => assertAgentConfigDoesNotContainCodexCredential(config)).toThrow(
      /reserved for machine-local credential injection/
    );
  });

  it.each(['lody_codex_custom_endpoint_api_key', 'LoDy_CoDeX_Custom_Endpoint_Api_Key'])(
    'treats the Windows-equivalent %s alias as reserved',
    (key) => {
      const config = { env: { [key]: 'sk-must-not-sync' } };

      expect(isReservedCodexCredentialEnvKey(key)).toBe(true);
      expect(agentConfigContainsCodexCredential(config)).toBe(true);
      expect(() => assertAgentConfigDoesNotContainCodexCredential(config)).toThrow(
        /reserved for machine-local credential injection/
      );
    }
  );

  it('keeps the credential out of durable env and routes Codex through Responses', () => {
    const env = buildLodyCodexCustomProviderEnv(
      { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      { baseUrl: '  https://relay.example.com/v1  ' }
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
    });
  });

  it('removes reserved key aliases from generated env and credential bindings', () => {
    const lowerCaseKey = 'lody_codex_custom_endpoint_api_key';
    const cleanEnv = buildLodyCodexCustomProviderEnv(
      { EXTRA_FLAG: '1' },
      { baseUrl: 'https://relay.example.com/v1' }
    );
    const configured = buildLodyCodexCustomProviderEnv(
      { EXTRA_FLAG: '1', [lowerCaseKey]: 'sk-must-not-copy' },
      { baseUrl: 'https://relay.example.com/v1' }
    );
    const config = {
      cliType: 'builtin',
      agentType: 'codex',
      env: { ...cleanEnv, [lowerCaseKey]: 'sk-must-not-hash' },
    };

    expect(configured[lowerCaseKey]).toBeUndefined();
    expect(getLodyCodexCredentialBinding(config)).toBe(
      getLodyCodexCredentialBinding({ ...config, env: cleanEnv })
    );
    expect(removeLodyCodexCustomProviderEnv(configured)[lowerCaseKey]).toBeUndefined();
  });

  it('makes the non-secret credential generation part of the launch binding', () => {
    const env = buildLodyCodexCustomProviderEnv(
      { EXTRA_FLAG: '1' },
      { baseUrl: 'https://relay.example.com/v1' }
    );
    const revisionOne = withLodyCodexCredentialRevision(env, 'revision-1');
    const revisionTwo = withLodyCodexCredentialRevision(env, 'revision-2');
    const config = { cliType: 'builtin', agentType: 'codex', env };

    expect(getLodyCodexCustomProvider(revisionOne)).toEqual({
      baseUrl: 'https://relay.example.com/v1',
      credentialRevision: 'revision-1',
    });
    expect(getLodyCodexCredentialBinding({ ...config, env: revisionOne })).not.toBe(
      getLodyCodexCredentialBinding({ ...config, env: revisionTwo })
    );
    const rebuilt = buildLodyCodexCustomProviderEnv(revisionOne, {
      baseUrl: 'https://relay.example.com/v1',
    });
    expect(getLodyCodexCredentialBinding({ ...config, env: rebuilt })).toBe(
      getLodyCodexCredentialBinding({ ...config, env: revisionOne })
    );
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
        { baseUrl: 'https://relay.example.com' }
      )
    ).toThrow(/already defines/);
    expect(() =>
      buildLodyCodexCustomProviderEnv(
        { [CODEX_CONFIG_ENV]: '{not-json' },
        { baseUrl: 'https://relay.example.com' }
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
