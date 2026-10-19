import { describe, expect, it } from 'vitest';
import { isSensitiveAcpConfigOptionId } from '../src/acp-config-option-sensitivity';
import { SessionPreparationRunConfigSchema } from '../src/message-schemas';

describe('ACP config option sensitivity', () => {
  it('flags secret-shaped option ids regardless of case or separator', () => {
    for (const configId of [
      'API_KEY',
      'apiKey',
      'api-key',
      'bearerToken',
      'authMode',
      'db_password',
    ]) {
      expect(isSensitiveAcpConfigOptionId(configId)).toBe(true);
    }
    for (const configId of ['effort', 'fast', 'model', 'mode', 'permission_mode']) {
      expect(isSensitiveAcpConfigOptionId(configId)).toBe(false);
    }
  });

  it('strips secret-shaped values from a retained run config payload', () => {
    expect(
      SessionPreparationRunConfigSchema.parse({
        configOptionValues: { effort: 'high', fast: true, API_KEY: 'private', bearerToken: 'x' },
      })
    ).toEqual({ configOptionValues: { effort: 'high', fast: true } });
  });
});
