import { describe, expect, it } from 'vitest';
import {
  findPastedUrlReferences,
  MAX_REFERENCE_PASTE_LENGTH,
} from '../src/components/mentions/url-reference-source';

describe('pasted URL ranges', () => {
  it('uses UTF-16 offsets without changing pasted text', () => {
    const text = '😀 https://example.test/a?q=1#two and https://github.com/LodyAI/Lody';
    const ranges = findPastedUrlReferences(text, 4);
    expect(ranges.map((range) => [range.kind, text.slice(range.start - 4, range.end - 4)])).toEqual(
      [
        ['url', 'https://example.test/a?q=1#two'],
        ['github_repo', 'https://github.com/LodyAI/Lody'],
      ]
    );
    expect(ranges[0].start).toBe(7);
  });
  it('leaves sentence delimiters outside references but retains balanced URL parentheses', () => {
    expect(
      findPastedUrlReferences('See https://example.test/docs. (https://example.test/a_(b))').map(
        (range) => range.value
      )
    ).toEqual(['https://example.test/docs', 'https://example.test/a_(b)']);
  });
  it('does not inspect pasted blobs or recognize credentials', () => {
    expect(
      findPastedUrlReferences('https://example.test/' + 'x'.repeat(MAX_REFERENCE_PASTE_LENGTH))
    ).toEqual([]);
    expect(findPastedUrlReferences('https://user:secret@example.test')).toEqual([]);
  });
});
