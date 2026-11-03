import { describe, expect, it } from 'vitest';

import {
  sanitizeMentionRanges,
  toPersistedMentionRanges,
} from '../src/components/mentions/mention-persistence';

const TEXT = 'see @src/a.ts and #482';

describe('toPersistedMentionRanges', () => {
  it('drops pasted text, which the pasted-text drafts already own', () => {
    // Persisting both would let the two disagree the moment one is edited.
    expect(
      toPersistedMentionRanges([{ start: 0, end: 8, value: 'paste-1', kind: 'pasted_text' }])
    ).toEqual([]);
  });
});

describe('sanitizeMentionRanges', () => {
  const file = { start: 4, end: 13, value: 'src/a.ts', kind: 'file' };
  const issue = { start: 18, end: 22, value: '#482', kind: 'issue' };

  it('drops a range whose offsets no longer fit, rather than clamping it', () => {
    // Stored against text that has since been edited elsewhere. Decorating the
    // wrong characters is worse than decorating none.
    expect(sanitizeMentionRanges('short', [file])).toEqual([]);
  });

  it('drops the later of two overlapping ranges', () => {
    expect(sanitizeMentionRanges(TEXT, [file, { ...issue, start: 8 }])).toEqual([file]);
  });
});
