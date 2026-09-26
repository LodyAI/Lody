import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Separator } from '../src/separator/separator';

function classesAt(html: string): string[] {
  return (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ').filter(Boolean);
}

describe('Separator', () => {
  test('it says what it is, in the orientation it is in', () => {
    // The old Radix wrapper defaulted to `decorative`, which is `role="none"`,
    // because it was used for decoration. In this system a line is never
    // decoration: the one place it is allowed — between the rows of a list or a
    // table — is structural, so it is announced rather than hidden.
    const html = renderToStaticMarkup(<Separator />);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(renderToStaticMarkup(<Separator orientation="vertical" />)).toContain(
      'aria-orientation="vertical"'
    );
  });

  test('the two orientations are two lines, sharing everything but the axis', () => {
    const horizontal = classesAt(renderToStaticMarkup(<Separator />));
    const vertical = classesAt(renderToStaticMarkup(<Separator orientation="vertical" />));
    expect(horizontal).not.toEqual(vertical);
    const shared = horizontal.filter((name) => vertical.includes(name));
    // The colour and the hairline are one decision; only the width and the
    // height differ, and a vertical line stretches to its row rather than
    // taking a percentage of a height the row has not got.
    expect(shared.length).toBe(horizontal.length - 2);
  });

  test('a caller className lands after the compiled classes', () => {
    const html = renderToStaticMarkup(<Separator className="my-2" />);
    const cls = /class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(cls.endsWith(' my-2')).toBe(true);
  });
});
