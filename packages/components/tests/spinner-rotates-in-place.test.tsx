// @vitest-environment jsdom

/**
 * A spinner must rotate about its own center. `animate-spin` is
 * `rotate(360deg)` about `transform-origin: 50% 50%`, so the glyph turns in
 * place only while the animated element's box is square AND centered on the
 * glyph. Two ways that breaks, both of which shipped as visible bugs:
 *
 *  1. The animated element is an HTML *wrapper* that contains more than the
 *     glyph (a label, a gap). Its box grows, its center moves off the glyph,
 *     and the glyph orbits that offset center — a wrapper that also held its
 *     "Syncing" label measured 64px of travel in WebKit.
 *  2. The glyph sits in a tight flex row with a truncating label and no
 *     `shrink-0`, so it is compressed to a non-square box and the rotation
 *     sweeps an ellipse (measured 14×14 → 13.55×15.43).
 *
 * jsdom has no layout, so these assert the *structural* invariants that make
 * the geometry correct rather than re-measuring pixels: an animated element
 * is explicitly square and cannot be squished, an animated wrapper is
 * icon-only, and the sidebar status slot has no positional nudge. The
 * `transform-box`/`transform-origin` half of the fix lives in
 * `src/tailwind/index.css` and is not observable here.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SessionRowLeadingSlot } from '../src/components/sidebar-row-shared';
import { SessionSyncingIndicator } from '../src/components/sessions/session-syncing-indicator';
import { MobileConnectionStatus } from '../src/components/mobile/mobile-connection-status';
import { initI18n } from '../src/i18n';

/** A sizing utility that pins BOTH axes, e.g. `h-3 w-3` / `size-4`. */
function hasExplicitSquareSize(el: Element): boolean {
  const classes = [...el.classList];
  const has = (prefix: string) =>
    classes.some((c) => new RegExp(String.raw`^-?${prefix}-\[?[\d./]`).test(c));
  return (has('h') && has('w')) || has('size');
}

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(async () => {
  await initI18n();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = undefined;
  container.remove();
});

function render(node: React.ReactElement) {
  flushSync(() => root?.render(node));
}

describe('spinners rotate in place', () => {
  it('session row working indicator: square SVG is centered without a vertical nudge', () => {
    render(
      React.createElement(SessionRowLeadingSlot, {
        isWorking: true,
        menuLabel: 'More actions',
      })
    );

    const spinner = container.querySelector('[data-session-working-spinner]');
    expect(spinner).not.toBeNull();
    expect(spinner!.tagName).toBe('svg');
    expect(spinner!.classList.contains('animate-spin')).toBe(true);
    expect(spinner!.classList.contains('shrink-0')).toBe(true);
    expect(hasExplicitSquareSize(spinner!)).toBe(true);

    const indicator = spinner!.closest('[data-session-row-indicator]');
    expect(indicator).not.toBeNull();
    expect(indicator!.classList.contains('-top-px')).toBe(false);
    expect(indicator!.classList.contains('items-center')).toBe(true);
    expect(indicator!.classList.contains('justify-center')).toBe(true);
  });

  /* The compositor-friendly pattern: animate an HTML wrapper, not the SVG.
     Only equivalent while the wrapper's box IS the glyph's box. */
  const wrapperCases: ReadonlyArray<readonly [string, () => React.ReactElement]> = [
    ['session syncing indicator', () => React.createElement(SessionSyncingIndicator, {})],
  ];

  for (const [name, element] of wrapperCases) {
    it(`${name}: animated wrapper is icon-only and explicitly sized`, () => {
      render(element());

      const wrappers = [...container.querySelectorAll('span.animate-spin')];
      expect(wrappers.length).toBe(1);
      const wrapper = wrappers[0]!;

      // Square, explicitly sized: the wrapper's center is the glyph's center.
      expect(hasExplicitSquareSize(wrapper)).toBe(true);

      // Icon-only. Any extra content (a label, a sibling) shifts the box
      // center off the glyph and turns the spin into an orbit.
      expect(wrapper.childElementCount).toBe(1);
      expect(wrapper.firstElementChild?.tagName).toBe('svg');
      expect(wrapper.textContent).toBe('');

      // The glyph itself must NOT also spin, or the two rotations compound.
      expect(wrapper.querySelector('svg')?.classList.contains('animate-spin')).toBe(false);
    });
  }

  /* The mobile home status pill: a capped-width flex row with a truncating
     label, i.e. exactly the layout that squishes an unprotected spinner. */
  const pillStates = [
    { label: 'refreshing', props: { state: 'online', refreshing: true } },
    { label: 'reconnecting', props: { state: 'reconnecting' } },
    { label: 'loading', props: { state: 'loading' } },
  ] as const;

  for (const { label, props } of pillStates) {
    it(`mobile status pill (${label}): spinner cannot be squished by the label`, () => {
      render(
        React.createElement(MobileConnectionStatus, {
          ...props,
          labels: {
            refreshing: '正在刷新工作区，请稍候等待同步完成',
            reconnecting: '正在重新连接到工作区，请稍候等待',
            loading: '正在连接到工作区，请稍候等待',
          },
        } as React.ComponentProps<typeof MobileConnectionStatus>)
      );

      const spinner = container.querySelector('svg.animate-spin');
      expect(spinner).not.toBeNull();
      // Without shrink-0 the flex row compresses the glyph to a non-square
      // box and the rotation sweeps an ellipse.
      expect(spinner!.classList.contains('shrink-0')).toBe(true);
      expect(hasExplicitSquareSize(spinner!)).toBe(true);
    });
  }
});
