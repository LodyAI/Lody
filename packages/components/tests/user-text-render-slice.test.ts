import { describe, expect, it } from 'vitest';

import {
  USER_TEXT_RENDER_CHAR_LIMIT,
  getUserTextRenderSlice,
} from '../src/components/ai-gui/message-copy';

/**
 * The collapsed slice is the one place a chip has to survive truncation, and
 * the one place it could not: a paste is only captured above
 * `LARGE_PASTED_TEXT_MIN_CHAR_COUNT`, which is already larger than the render
 * budget, so charging it by its raw length made the failure total rather than
 * occasional.
 */
describe('getUserTextRenderSlice with spans', () => {
  const blob = 'x'.repeat(4000);
  const text = `look at this ${blob} and tell me why`;
  const span = {
    start: 'look at this '.length,
    end: 'look at this '.length + blob.length,
    kind: 'pasted_text' as const,
    label: 'Pasted 4,000 chars',
  };

  it('keeps the paste whole and charges only its label, so the chip survives', () => {
    const slice = getUserTextRenderSlice(text, [span]);

    expect(slice.spans).toHaveLength(1);
    // The region is intact, so the chip has something to cover and expanding
    // still reveals the blob.
    expect(slice.text.slice(slice.spans![0]!.start, slice.spans![0]!.end)).toBe(blob);
    // And the rest of the sentence fits, because the blob cost 18 not 4000.
    expect(slice.text).toContain('and tell me why');
    expect(slice.isTruncated).toBe(false);
  });

  it('drops a span it cannot reach rather than cutting into it', () => {
    const prose = 'y'.repeat(USER_TEXT_RENDER_CHAR_LIMIT + 100);
    const late = `${prose} ${blob}`;
    const slice = getUserTextRenderSlice(late, [
      {
        start: prose.length + 1,
        end: prose.length + 1 + blob.length,
        kind: 'pasted_text',
        label: 'Pasted',
      },
    ]);
    expect(slice.isTruncated).toBe(true);
    expect(slice.spans ?? []).toHaveLength(0);
    expect(slice.text).not.toContain(blob);
  });

  it('does not let newlines inside a span consume the line budget', () => {
    const lines = `${'a\n'.repeat(30)}`;
    const withSpan = `intro ${lines} outro`;
    const slice = getUserTextRenderSlice(withSpan, [
      { start: 6, end: 6 + lines.length, kind: 'pasted_text', label: 'Pasted' },
    ]);
    // Thirty newlines are one chip, not thirty lines against a limit of ten.
    expect(slice.text).toContain('outro');
    expect(slice.isTruncated).toBe(false);
  });
});
