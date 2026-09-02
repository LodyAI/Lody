import { describe, expect, it } from 'vitest';

import { describeUnsupportedTurnDiffSqliteRuntime } from '../src/sqlite-runtime-support';

describe('turn-diff SQLite runtime support', () => {
  it('accepts Node-API 10 on supported architectures', () => {
    expect(
      describeUnsupportedTurnDiffSqliteRuntime({
        napi: '10',
        arch: 'arm64',
        nodeVersion: 'v22.14.0',
      })
    ).toBeUndefined();
  });

  it('rejects runtimes that would crash while loading the native addon', () => {
    const problem = describeUnsupportedTurnDiffSqliteRuntime({
      napi: '9',
      arch: 'x64',
      nodeVersion: 'v22.13.1',
    });

    expect(problem).toMatch(/Node-API 10/);
    expect(problem).toContain('23.6.0');
  });

  it('rejects architectures without a prebuilt SQLite binding', () => {
    expect(
      describeUnsupportedTurnDiffSqliteRuntime({
        napi: '10',
        arch: 'arm',
        nodeVersion: 'v22.14.0',
      })
    ).toMatch(/arm architecture/);
  });
});
