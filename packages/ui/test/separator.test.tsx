import * as stylex from '@stylexjs/stylex';
import { act } from 'react';
import { mount } from './dom';

import { describe, expect, test } from 'vitest';
import { Separator } from '../src/separator/separator';

const extension = stylex.create({ offset: (offset: number) => ({ marginInlineStart: offset }) });

describe('Separator', () => {
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
