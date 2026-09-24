// @vitest-environment jsdom

/**
 * Two invariants for every long-lived spinner, both of which shipped as
 * visible or measurable bugs.
 *
 *  1. The animated element is an HTML wrapper, never the `<svg>`. Chromium
 *     refuses to composite a transform animation whose target is an SVG
 *     element with an effective zoom other than 1 (crbug.com/1186312), and
 *     Blink folds the device scale factor into that zoom, so on a Retina
 *     display an `<svg class="animate-spin">` re-runs style, pre-paint and
 *     layerize on the main thread every vsync. Two sidebar spinners measured
 *     40–50% renderer CPU at 120 Hz with the app idle; the same animation on
 *     an HTML element composited and the main thread went quiet.
 *
 *  2. The wrapper's box is the glyph's box. `animate-spin` rotates about
 *     `transform-origin: 50% 50%`, so the glyph turns in place only while the
 *     animated box is square and centered on it. A wrapper that also held a
 *     "Syncing" label measured 64px of orbit in WebKit; a glyph squeezed by a
 *     truncating label in a tight flex row was compressed to 13.55×15.43 and
 *     swept an ellipse.
 *
 * jsdom has no layout, so these assert the structural facts that make the
 * geometry correct: the animated element is HTML, explicitly square, cannot
 * be squished, and contains exactly the glyph. The `transform-box` /
 * `transform-origin` half of the fix lives in `src/tailwind/index.css`.
 */

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { RemoteDirectoryPicker } from '../src/components/local-projects/add-local-project-dialog';
import { MobileAddLocalProjectFlow } from '../src/components/local-projects/mobile-add-local-project-flow';
import { MobileProjectFileBrowser } from '../src/components/files/mobile-project-file-browser';
import { SessionSyncingIndicator } from '../src/components/sessions/session-syncing-indicator';
import { MobileConnectionStatus } from '../src/components/mobile/mobile-connection-status';
import { Spinner } from '../src/ui/spinner';
import { initI18n } from '../src/i18n';

// The mobile file browser's file-preview branch pulls the real Monaco editor,
// which touches `document.queryCommandSupported` at import time and fails in
// jsdom. None of these tests reach a file preview; the stub keeps ~10 MB of
// editor out of this suite's module graph.
vi.mock('../src/components/sessions/session-monaco-text-viewer', () => ({
  SessionMonacoTextViewer: () => null,
}));

const XHTML = 'http://www.w3.org/1999/xhtml';

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

/** The single animated element in the tree, checked against both invariants. */
function expectCompositableSpinner(): Element {
  const animated = [...container.querySelectorAll('.animate-spin')];
  expect(animated.length).toBe(1);
  const wrapper = animated[0]!;

  // Invariant 1: the animation target is HTML, so the compositor can run it.
  expect(wrapper.namespaceURI).toBe(XHTML);
  expect(wrapper.tagName).toBe('SPAN');
  expect(container.querySelector('svg.animate-spin')).toBeNull();

  // Invariant 2: square, explicitly sized, unsquishable, icon-only, and the
  // glyph itself must not also spin or the two rotations compound.
  expect(hasExplicitSquareSize(wrapper)).toBe(true);
  expect(wrapper.classList.contains('shrink-0')).toBe(true);
  expect(wrapper.childElementCount).toBe(1);
  expect(wrapper.firstElementChild?.tagName).toBe('svg');
  expect(wrapper.textContent).toBe('');
  expect(wrapper.querySelector('.animate-spin')).toBeNull();

  return wrapper;
}

describe('spinners animate on a compositable wrapper and rotate in place', () => {
  it('session syncing indicator: the label stays outside the animated box', () => {
    render(React.createElement(SessionSyncingIndicator, {}));

    expectCompositableSpinner();
    // The label renders, just not inside the rotating element.
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
  });

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

      expectCompositableSpinner();
    });
  }

  it('a refresh glyph reuses one element and only animates while spinning', () => {
    render(
      React.createElement(Spinner, { icon: RefreshCw, spinning: false, className: 'h-4 w-4' })
    );
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();

    render(React.createElement(Spinner, { icon: RefreshCw, spinning: true, className: 'h-4 w-4' }));
    const wrapper = expectCompositableSpinner();
    expect(wrapper.querySelector('svg.lucide-refresh-cw')).not.toBeNull();
  });
});

/**
 * A status panel picks an icon per state and rotates it only in the loading
 * one. `Spinner` defaults `spinning` to true, because a bare `<Spinner />` is
 * a loading indicator, so a panel that forwards its own OPTIONAL `spinning`
 * prop hands `undefined` through in every other state and the default takes
 * over: the "no machines", "files unavailable" and empty-folder icons all
 * span forever. Assert the animation is absent in a resting state and present
 * in the loading one, so a fix that simply never spins fails too.
 */
describe('status panels animate only their loading state', () => {
  const pickerArgs = {
    machines: [],
    ops: {
      listRoots: async () => ({ ok: true as const, value: { roots: [], pathSeparator: '/' } }),
      browseDir: async () => ({ ok: true as const, value: { entries: [] } }),
      addProject: async () => ({ ok: true as const, value: {} }),
    },
    onAdded: () => {},
    onClose: () => {},
  } as unknown as React.ComponentProps<typeof RemoteDirectoryPicker>;

  const panels: ReadonlyArray<
    readonly [string, (loading: boolean) => React.ReactElement, string]
  > = [
    [
      'desktop machine picker',
      (loading) =>
        React.createElement(RemoteDirectoryPicker, { ...pickerArgs, machinesLoading: loading }),
      'No machines available',
    ],
    [
      'mobile machine picker',
      (loading) =>
        React.createElement(MobileAddLocalProjectFlow, { ...pickerArgs, machinesLoading: loading }),
      'No machines available',
    ],
  ];

  for (const [name, element, restingText] of panels) {
    it(`${name}: the resting icon does not spin`, () => {
      render(element(false));

      expect(container.textContent).toContain(restingText);
      expect(container.querySelector('.animate-spin')).toBeNull();
    });

    it(`${name}: the loading icon still spins`, () => {
      render(element(true));

      expect(container.querySelectorAll('.animate-spin').length).toBe(1);
    });
  }

  it('mobile file browser: the "files unavailable" icon does not spin', () => {
    render(React.createElement(MobileProjectFileBrowser, { provider: undefined }));

    expect(container.textContent).toContain('Files unavailable');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});
