import * as stylex from '@stylexjs/stylex';
import { act } from 'react';
import { mount } from './dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Separator } from '../src/separator/separator';

function classesAt(html: string): string[] {
  return (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ').filter(Boolean);
}

const extension = stylex.create({ offset: (offset: number) => ({ marginInlineStart: offset }) });

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

  test('composes dynamic variables with the caller orientation callback', async () => {
    const render = (vertical: boolean) => (
      <Separator
        orientation={vertical ? 'vertical' : 'horizontal'}
        xstyle={extension.offset(vertical ? 0 : 13)}
        style={(state) => ({ marginTop: state.orientation === 'vertical' ? 9 : 7 })}
      />
    );
    const view = await mount(render(false));
    try {
      const node = view.container.querySelector<HTMLElement>('[role=separator]')!;
      expect(node.style.marginTop).toBe('7px');
      const vars = stylex.props(extension.offset(13)).style!;
      expect(Object.keys(vars).length).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(vars))
        expect(node.style.getPropertyValue(key)).toBe(String(value));
      await act(async () => view.root.render(render(true)));
      expect(view.container.querySelector('[role=separator]')).toBe(node);
      expect(node.getAttribute('aria-orientation')).toBe('vertical');
      expect(node.style.marginTop).toBe('9px');
      for (const [key, value] of Object.entries(stylex.props(extension.offset(0)).style!))
        expect(node.style.getPropertyValue(key)).toBe(String(value));
    } finally {
      await view.unmount();
    }
  });
});
