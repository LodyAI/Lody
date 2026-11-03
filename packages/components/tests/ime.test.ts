import { describe, expect, it } from 'vitest';

import { resolveDuplicatedImeCommitEcho } from '../src/lib/ime';

describe('resolveDuplicatedImeCommitEcho', () => {
  it('resolves duplicated insertFromComposition echo while composing', () => {
    expect(
      resolveDuplicatedImeCommitEcho({
        nextValue: 'tokentoken',
        lastStableComposingValue: 'token',
        inputType: 'insertFromComposition',
        isComposing: true,
      })
    ).toBe('token');
  });

  it('prefers committed data when last composing snapshot is stale', () => {
    expect(
      resolveDuplicatedImeCommitEcho({
        nextValue: '你好你好',
        lastStableComposingValue: 'ni h',
        inputType: 'insertFromComposition',
        isComposing: true,
        committedData: '你好',
      })
    ).toBe('你好');
  });
});
