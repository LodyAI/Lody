// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { InlineSvg } from '../src/components/icons/inline-svg';
import { resetSafeAreaInsetsForTest } from '../src/hooks/use-safe-area-insets';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SVG_MARKUP = '<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z" /></svg>';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetSafeAreaInsetsForTest();
});

describe('InlineSvg', () => {
  it('fills the glyph without replacing its parsed node or explicit SVG styles', () => {
    const raw =
      '<svg viewBox="0 0 16 16" style="width:4px;\nopacity:.5"><path d="M0 0h16v16H0z" /></svg>';
    const render = (className: string) =>
      act(() => root.render(createElement(InlineSvg, { raw, fillParent: true, className })));
    render('first');
    const svg = container.querySelector('svg');
    expect(svg?.style.width).toBe('4px');
    expect(svg?.style.height).toBe('100%');
    expect(svg?.style.opacity).toBe('0.5');
    const path = svg?.firstElementChild;
    render('second');
    expect(container.querySelector('svg')).toBe(svg);
    expect(container.querySelector('svg')?.firstElementChild).toBe(path);
    expect(container.querySelector('span')?.className).toBe('second');
  });
});
