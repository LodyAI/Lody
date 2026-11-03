import { describe, expect, it } from 'vitest';
import { SessionPreparationRunConfigSchema } from '../src/message-schemas';

describe('ACP config option sensitivity', () => {
  it('strips secret-shaped values from a retained run config payload', () => {
    expect(
      SessionPreparationRunConfigSchema.parse({
        configOptionValues: { effort: 'high', fast: true, API_KEY: 'private', bearerToken: 'x' },
      })
    ).toEqual({ configOptionValues: { effort: 'high', fast: true } });
  });
});
