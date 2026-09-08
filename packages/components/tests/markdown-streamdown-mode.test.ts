import { describe, expect, it } from 'vitest';

import { resolveMarkdownStreamdownMode } from '../src/components/ai-gui/markdown-streamdown-mode';

describe('resolveMarkdownStreamdownMode', () => {
  it('uses static mode for finished markdown', () => {
    expect(resolveMarkdownStreamdownMode(false)).toBe('static');
  });

  it('uses streaming mode while a turn is still growing', () => {
    expect(resolveMarkdownStreamdownMode(true)).toBe('streaming');
  });
});
