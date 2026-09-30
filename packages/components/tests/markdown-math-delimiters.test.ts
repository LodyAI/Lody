import { describe, expect, it } from 'vitest';

import { normalizeTexMathDelimiters } from '../src/lib/markdown-single-dollar-math';

describe('normalizeTexMathDelimiters', () => {
  it('normalizes complete display pairs without shifting Unicode text', () => {
    const markdown = ['😀 before \\(x_i\\).', '', '\\[', 'y = \\boxed{1}', '\\]'].join('\n');

    expect(normalizeTexMathDelimiters(markdown)).toBe(
      ['😀 before \\(x_i\\).', '', '$$', 'y = \\boxed{1}', '$$'].join('\n')
    );
  });

  it('rewrites a same-line display pair embedded in prose as inline math', () => {
    const markdown = String.raw`text before \[x + y\] and \(p\)`;

    expect(normalizeTexMathDelimiters(markdown, true)).toBe(
      String.raw`text before $$x + y$$ and $$p$$`
    );
  });

  it('puts multiline display pairs after prose on their own lines', () => {
    const markdown = ['Derive \\[', 'x + y', '\\] in prose.'].join('\n');

    expect(normalizeTexMathDelimiters(markdown)).toBe(
      ['Derive', '$$', 'x + y', '$$', ' in prose.'].join('\n')
    );
  });

  it('keeps inserted multiline display pairs inside list items', () => {
    const markdown = ['- Derive \\[', '  x + y', '  \\] in prose.'].join('\n');

    expect(normalizeTexMathDelimiters(markdown)).toBe(
      ['- Derive', '  $$', '  x + y', '  $$', '   in prose.'].join('\n')
    );
  });

  it('normalizes display pairs at Markdown block starts in quotes and lists', () => {
    const markdown = ['> \\[', '> x + y', '> \\]', '', '- \\[', '  z', '  \\]'].join('\n');

    expect(normalizeTexMathDelimiters(markdown)).toBe(
      ['> $$', '> x + y', '> $$', '', '- $$', '  z', '  $$'].join('\n')
    );
  });

  it('leaves escaped and incomplete delimiters unchanged', () => {
    const markdown = String.raw`literal \\(x\\), unmatched z\), and incomplete \(y`;

    expect(normalizeTexMathDelimiters(markdown)).toBe(markdown);
  });

  it('does not let inline delimiters suppress a later display formula', () => {
    const markdown = ['incomplete \\(y', 'next', '\\[', 'z', '\\]'].join('\n');

    expect(normalizeTexMathDelimiters(markdown)).toBe(
      ['incomplete \\(y', 'next', '$$', 'z', '$$'].join('\n')
    );
  });

  it('normalizes complete inline pairs only when enabled', () => {
    const markdown = String.raw`before \(x_i\) after`;

    expect(normalizeTexMathDelimiters(markdown)).toBe(markdown);
    expect(normalizeTexMathDelimiters(markdown, true)).toBe('before $$x_i$$ after');
  });

  it('leaves inline delimiters in link labels unchanged when enabled', () => {
    const markdown = String.raw`[\(x_i\)](https://example.com)`;

    expect(normalizeTexMathDelimiters(markdown, true)).toBe(markdown);
  });

  it('leaves inline delimiters in link destinations unchanged when enabled', () => {
    const markdown = String.raw`[x](https://example.com/\(value\))`;

    expect(normalizeTexMathDelimiters(markdown, true)).toBe(markdown);
  });

  it('normalizes inline delimiters in ordinary square-bracket text when enabled', () => {
    const markdown = String.raw`[\(x_i\)]`;

    expect(normalizeTexMathDelimiters(markdown, true)).toBe('[$$x_i$$]');
  });

  it('leaves delimiters inside inline and fenced code unchanged', () => {
    const markdown = [
      '`\\(inline\\)`',
      '',
      '~~~tex',
      '\\[',
      'display',
      '\\]',
      '~~~',
      '',
      '\\(outside\\)',
    ].join('\n');

    expect(normalizeTexMathDelimiters(markdown)).toBe(markdown);
  });

  it('leaves delimiters inside four-column indented code unchanged', () => {
    const markdown = ['    \\(space_indented\\)', '\t\\[tab_indented\\]', '', '\\(outside\\)'].join(
      '\n'
    );

    expect(normalizeTexMathDelimiters(markdown)).toBe(markdown);
  });

  it('leaves delimiters inside container-nested fenced code unchanged', () => {
    const markdown = [
      '> ```tex',
      '> \\(blockquote_literal\\)',
      '> ```',
      '',
      '- ~~~tex',
      '  \\[list_literal\\]',
      '  ~~~',
      '',
      '> - ````tex',
      '>   \\(nested_literal\\)',
      '>   ````',
      '',
      '10. ```tex',
      '    \\(ordered_list_literal\\)',
      '    ```',
      '',
      '\\(outside\\)',
    ].join('\n');

    expect(normalizeTexMathDelimiters(markdown)).toBe(
      [
        '> ```tex',
        '> \\(blockquote_literal\\)',
        '> ```',
        '',
        '- ~~~tex',
        '  \\[list_literal\\]',
        '  ~~~',
        '',
        '> - ````tex',
        '>   \\(nested_literal\\)',
        '>   ````',
        '',
        '10. ```tex',
        '    \\(ordered_list_literal\\)',
        '    ```',
        '',
        '\\(outside\\)',
      ].join('\n')
    );
  });
});
