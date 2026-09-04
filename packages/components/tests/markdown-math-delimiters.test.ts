import { describe, expect, it } from 'vitest';

import { normalizeTexMathDelimiters } from '../src/lib/markdown-single-dollar-math';

describe('normalizeTexMathDelimiters', () => {
  it('normalizes complete inline and display pairs without shifting Unicode text', () => {
    const markdown = ['😀 before \\(x_i\\).', '', '\\[', 'y = \\boxed{1}', '\\]'].join('\n');

    expect(normalizeTexMathDelimiters(markdown)).toBe(
      ['😀 before $$x_i$$.', '', '$$', 'y = \\boxed{1}', '$$'].join('\n')
    );
  });

  it('leaves escaped and incomplete delimiters unchanged', () => {
    const markdown = String.raw`literal \\(x\\), unmatched z\), and incomplete \(y`;

    expect(normalizeTexMathDelimiters(markdown)).toBe(markdown);
  });

  it('does not let an incomplete inline delimiter suppress a later formula', () => {
    const markdown = ['incomplete \\(y', 'next \\(z\\)'].join('\n');

    expect(normalizeTexMathDelimiters(markdown)).toBe(['incomplete \\(y', 'next $$z$$'].join('\n'));
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

    expect(normalizeTexMathDelimiters(markdown)).toBe(
      ['`\\(inline\\)`', '', '~~~tex', '\\[', 'display', '\\]', '~~~', '', '$$outside$$'].join('\n')
    );
  });

  it('leaves delimiters inside four-column indented code unchanged', () => {
    const markdown = ['    \\(space_indented\\)', '\t\\[tab_indented\\]', '', '\\(outside\\)'].join(
      '\n'
    );

    expect(normalizeTexMathDelimiters(markdown)).toBe(
      ['    \\(space_indented\\)', '\t\\[tab_indented\\]', '', '$$outside$$'].join('\n')
    );
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
        '$$outside$$',
      ].join('\n')
    );
  });
});
