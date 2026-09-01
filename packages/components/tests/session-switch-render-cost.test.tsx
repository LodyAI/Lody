// @vitest-environment jsdom

import { act, createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { InlineSvg } from '../src/components/icons/inline-svg';
import {
  resetSafeAreaInsetsForTest,
  useSafeAreaInsets,
  type SafeAreaInsets,
} from '../src/hooks/use-safe-area-insets';

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
  it('keeps the parsed SVG node across re-renders of unchanged markup', () => {
    const render = (className: string) =>
      act(() => root.render(createElement(InlineSvg, { raw: SVG_MARKUP, className })));

    render('h-4 w-4');
    const host = container.querySelector('span');
    const parsed = host?.firstElementChild;
    expect(parsed?.tagName.toLowerCase()).toBe('svg');

    // React 19 assigns `innerHTML` whenever the `dangerouslySetInnerHTML` prop
    // is a new object, so a fresh literal per render reparses the markup and
    // replaces this node. Interning the wrapper is what keeps it alive.
    render('h-4 w-4');
    render('h-5 w-5');

    expect(container.querySelector('span')?.firstElementChild).toBe(parsed);
    expect(container.querySelector('span')?.className).toBe('h-5 w-5');
  });

  it('parses distinct markup into its own node', () => {
    act(() => root.render(createElement(InlineSvg, { raw: SVG_MARKUP })));
    const first = container.querySelector('span')?.firstElementChild;

    act(() =>
      root.render(createElement(InlineSvg, { raw: '<svg viewBox="0 0 8 8"><g /></svg>' }))
    );
    const second = container.querySelector('span')?.firstElementChild;

    expect(second).not.toBe(first);
    expect(second?.getAttribute('viewBox')).toBe('0 0 8 8');
  });
});

describe('useSafeAreaInsets', () => {
  function Probe({ id }: { id: string }) {
    const insets = useSafeAreaInsets();
    return createElement('i', { 'data-testid': id }, `${insets.top}/${insets.bottom}`);
  }

  function setInsetVariables(top: string, bottom: string) {
    document.documentElement.style.setProperty('--safe-area-top', top);
    document.documentElement.style.setProperty('--safe-area-bottom', bottom);
  }

  afterEach(() => {
    document.documentElement.style.removeProperty('--safe-area-top');
    document.documentElement.style.removeProperty('--safe-area-bottom');
  });

  it('reads the document once no matter how many surfaces subscribe', () => {
    setInsetVariables('44px', '34px');
    let reads = 0;
    const original = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      if (element === document.documentElement) reads += 1;
      return original(element, pseudo ?? undefined);
    }) as typeof window.getComputedStyle;

    try {
      act(() =>
        root.render(
          createElement(
            Fragment,
            null,
            ...Array.from({ length: 25 }, (_, index) =>
              createElement(Probe, { key: index, id: `probe-${index}` })
            )
          )
        )
      );

      expect(container.querySelector('[data-testid="probe-0"]')?.textContent).toBe('44/34');
      expect(container.querySelector('[data-testid="probe-24"]')?.textContent).toBe('44/34');
      // A per-instance read forces a full-document style recalculation each
      // time, which is what made a session switch expensive.
      expect(reads).toBe(1);
    } finally {
      window.getComputedStyle = original;
    }
  });

  it('republishes insets on resize and holds the snapshot identity otherwise', () => {
    setInsetVariables('10px', '20px');
    const seen: SafeAreaInsets[] = [];

    function Recorder() {
      const insets = useSafeAreaInsets();
      seen.push(insets);
      return null;
    }

    act(() => root.render(createElement(Recorder)));
    const settled = seen[seen.length - 1];
    expect(settled).toEqual({ top: 10, right: 0, bottom: 20, left: 0 });

    // An unchanged environment must not hand subscribers a new object, or every
    // consumer re-renders for a value that did not move.
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(seen[seen.length - 1]).toBe(settled);

    setInsetVariables('0px', '0px');
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(seen[seen.length - 1]).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
