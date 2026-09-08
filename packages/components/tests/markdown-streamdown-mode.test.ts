import { describe, expect, it } from 'vitest';

import { resolveMarkdownStreamdownMode } from '../src/components/ai-gui/markdown-streamdown-mode';

describe('resolveMarkdownStreamdownMode', () => {
  it('uses static mode for finished complete markdown', () => {
    expect(resolveMarkdownStreamdownMode(false, 'Hello **world**.')).toBe('static');
  });

  it('uses streaming mode while a turn is still growing', () => {
    expect(resolveMarkdownStreamdownMode(true, 'Hello **wor')).toBe('streaming');
  });

  it('keeps streaming mode for a finished turn with an unclosed fence', () => {
    expect(resolveMarkdownStreamdownMode(false, '```ts\nconst x = 1;\n')).toBe('streaming');
  });
});
