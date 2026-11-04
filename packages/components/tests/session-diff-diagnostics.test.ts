import { describe, expect, it } from 'vitest';

import { describeSessionDiffSnapshot } from '../src/lib/session-diff-diagnostics';

describe('session diff diagnostics', () => {
  it('summarizes text snapshots by length instead of raw content', () => {
    expect(describeSessionDiffSnapshot({ kind: 'text', text: 'hello world' })).toEqual({
      kind: 'text',
      textLength: 11,
    });
  });
});
