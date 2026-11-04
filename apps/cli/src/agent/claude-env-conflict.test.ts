import { describe, expect, it } from 'vitest';

import { scrubInheritedClaudeAuthEnv } from './claude-env-conflict';

describe('scrubInheritedClaudeAuthEnv', () => {
  it('strips inherited ANTHROPIC_API_KEY when user explicitly sets ANTHROPIC_AUTH_TOKEN', () => {
    const merged = {
      ANTHROPIC_API_KEY: 'sk-from-shell',
      ANTHROPIC_AUTH_TOKEN: 'sk-from-config',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      PATH: '/usr/bin',
    };
    const out = scrubInheritedClaudeAuthEnv(merged, {
      ANTHROPIC_AUTH_TOKEN: 'sk-from-config',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-config');
    expect(out.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(out.PATH).toBe('/usr/bin');
  });

  it('strips inherited Bedrock/Vertex/Foundry routing when ANTHROPIC_BASE_URL is configured', () => {
    const merged = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'aws-token',
      ANTHROPIC_VERTEX_PROJECT_ID: 'gcp-proj',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-deep',
    };
    const out = scrubInheritedClaudeAuthEnv(merged, {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-deep',
    });
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(out.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(out.ANTHROPIC_VERTEX_PROJECT_ID).toBeUndefined();
    expect(out.CLOUD_ML_REGION).toBeUndefined();
  });

  it('strips inherited model selectors when explicit auth/routing intent exists', () => {
    const merged = {
      ANTHROPIC_AUTH_TOKEN: 'sk-from-config',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4',
    };
    const out = scrubInheritedClaudeAuthEnv(merged, {
      ANTHROPIC_AUTH_TOKEN: 'sk-from-config',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    });
    expect(out.ANTHROPIC_MODEL).toBeUndefined();
    expect(out.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(out.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it('preserves user-explicit values over inherited ones', () => {
    const merged = {
      ANTHROPIC_API_KEY: 'sk-shell',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_MODEL: 'mimo-v2.5-pro',
    };
    const out = scrubInheritedClaudeAuthEnv(merged, {
      ANTHROPIC_API_KEY: 'sk-shell',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_MODEL: 'mimo-v2.5-pro',
    });
    // User explicitly set ANTHROPIC_API_KEY in their config — preserved.
    expect(out.ANTHROPIC_API_KEY).toBe('sk-shell');
    expect(out.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com');
    expect(out.ANTHROPIC_MODEL).toBe('mimo-v2.5-pro');
  });

  it('does not trigger on model-only config (subscription auth still inherits)', () => {
    // User has only set a model preference but no auth/routing override.
    // Don't touch their inherited subscription credentials.
    const merged = {
      ANTHROPIC_API_KEY: 'sk-shell',
      ANTHROPIC_MODEL: 'claude-opus-4',
    };
    const out = scrubInheritedClaudeAuthEnv(merged, {
      ANTHROPIC_MODEL: 'claude-opus-4',
    });
    expect(out.ANTHROPIC_API_KEY).toBe('sk-shell');
  });

  it('CLAUDE_CODE_USE_BEDROCK in user config triggers scrub of inherited Anthropic auth', () => {
    const merged = {
      ANTHROPIC_API_KEY: 'sk-shell',
      ANTHROPIC_AUTH_TOKEN: 'sk-shell-token',
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'aws-from-config',
    };
    const out = scrubInheritedClaudeAuthEnv(merged, {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'aws-from-config',
    });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(out.AWS_BEARER_TOKEN_BEDROCK).toBe('aws-from-config');
  });
});
