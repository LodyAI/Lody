import { describe, expect, it } from 'vitest';
import { parseEnvVarsText } from '../src/components/settings/env-vars-textarea';

describe('parseEnvVarsText', () => {
  it('strips matching quotes that wrap an environment variable value', () => {
    expect(
      parseEnvVarsText(['DOUBLE="value"', "SINGLE='value with spaces'", 'EMPTY=""'].join('\n')).env
    ).toEqual({
      DOUBLE: 'value',
      SINGLE: 'value with spaces',
      EMPTY: '',
    });
  });

  it('preserves quotes that do not wrap the entire value', () => {
    expect(
      parseEnvVarsText(
        ['UNMATCHED="value', 'SUFFIX="value"suffix', 'INNER=value"quoted"'].join('\n')
      ).env
    ).toEqual({
      UNMATCHED: '"value',
      SUFFIX: '"value"suffix',
      INNER: 'value"quoted"',
    });
  });
});
