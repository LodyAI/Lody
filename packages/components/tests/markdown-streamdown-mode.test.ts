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

  it('keeps streaming mode for an unclosed indented backtick fence', () => {
    expect(resolveMarkdownStreamdownMode(false, '1. example:\n   ```ts\n   const x = 1;\n')).toBe(
      'streaming'
    );
  });

  it('keeps streaming mode for an unclosed tilde fence', () => {
    expect(resolveMarkdownStreamdownMode(false, '~~~js\nconst x = 1;\n')).toBe('streaming');
  });

  it('uses static mode when an indented fence is closed', () => {
    expect(
      resolveMarkdownStreamdownMode(false, '1. example:\n   ```ts\n   const x = 1;\n   ```\n')
    ).toBe('static');
  });

  it('does not treat a 4-space indent as a fence', () => {
    expect(resolveMarkdownStreamdownMode(false, '    ```ts\n    const x = 1;\n')).toBe('static');
  });

  it('keeps streaming mode when a shorter closer cannot end a longer fence', () => {
    expect(resolveMarkdownStreamdownMode(false, '````ts\nconst x = 1;\n```\n')).toBe('streaming');
  });
});
