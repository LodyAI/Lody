// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeInitialDiagramZoom,
  MERMAID_DIAGRAM_MAX_ZOOM,
} from '../src/components/ai-gui/mermaid-diagram-viewer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

const DIAGRAM_WIDTH = 1200;
const DIAGRAM_HEIGHT = 800;

vi.mock('beautiful-mermaid', () => ({
  renderMermaidSVGAsync: async () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DIAGRAM_WIDTH}" height="${DIAGRAM_HEIGHT}" data-diagram="sequence"><text>Launch game</text></svg>`,
}));

// Streamdown renders a diagram only once it scrolls into view; jsdom has no
// IntersectionObserver, so report every observed block as visible.
class VisibleIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, intersectionRatio: 1, target } as IntersectionObserverEntry],
      this
    );
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver);

const { MarkdownRenderer } = await import('../src/components/ai-gui/markdown-renderer');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MERMAID_MARKDOWN = [
  'Here is the run:',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  participant U as User',
  '  participant K as Keeper runtime',
  '  U->>K: Start whole-run task',
  '```',
].join('\n');
const PLAIN_MARKDOWN = 'Just ordinary text.';

const viewer = () => document.body.querySelector('[data-testid="mermaid-diagram-viewer"]');
const viewerSurface = () =>
  document.body.querySelector<HTMLElement>('[data-testid="mermaid-diagram-viewer-surface"]');
const viewerClose = () =>
  document.body.querySelector<HTMLElement>('[data-testid="mermaid-diagram-viewer-close"]');

/**
 * Streamdown defers a diagram until its block is on screen (a 300ms debounce
 * plus an idle callback) and both the block and the render runtime arrive
 * through dynamic imports. Fake timers drive that schedule so the wait is a
 * number of steps rather than a race against the wall clock;
 * `advanceTimersByTimeAsync` flushes the pending imports between them.
 */
async function flushUntil(condition: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

describe('computeInitialDiagramZoom', () => {
  it('keeps a diagram wider than the viewport at natural size so its labels stay readable', () => {
    expect(
      computeInitialDiagramZoom({
        containerWidth: 390,
        containerHeight: 780,
        naturalWidth: 1200,
        naturalHeight: 800,
      })
    ).toBe(1);
  });

  it('grows a diagram that already fits, up to the cap', () => {
    expect(
      computeInitialDiagramZoom({
        containerWidth: 800,
        containerHeight: 800,
        naturalWidth: 400,
        naturalHeight: 400,
      })
    ).toBe(2);
    expect(
      computeInitialDiagramZoom({
        containerWidth: 1600,
        containerHeight: 1600,
        naturalWidth: 100,
        naturalHeight: 100,
      })
    ).toBe(3);
  });

  it('falls back to natural size when a measurement is missing', () => {
    expect(
      computeInitialDiagramZoom({
        containerWidth: 0,
        containerHeight: 0,
        naturalWidth: 0,
        naturalHeight: 0,
      })
    ).toBe(1);
  });

  it('never opens past the zoom ceiling', () => {
    expect(
      computeInitialDiagramZoom({
        containerWidth: 10_000,
        containerHeight: 10_000,
        naturalWidth: 1,
        naturalHeight: 1,
      })
    ).toBeLessThanOrEqual(MERMAID_DIAGRAM_MAX_ZOOM);
  });
});

describe('mermaid full-screen viewer', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  const renderMarkdown = async (text = MERMAID_MARKDOWN) => {
    await act(async () => {
      root?.render(createElement(MarkdownRenderer, { text }));
    });
    if (!text.includes('```mermaid')) {
      return null;
    }
    await flushUntil(() => Boolean(container?.querySelector('[data-streamdown="mermaid"] svg')));
    const diagram = container?.querySelector<HTMLElement>('[data-streamdown="mermaid"]');
    expect(diagram).toBeTruthy();
    return diagram as HTMLElement;
  };

  const clickOn = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => void root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('replaces the bundled full-screen control with a diagram that opens the viewer', async () => {
    const diagram = await renderMarkdown();

    // Streamdown's own overlay is the one this fix removes; the block keeps its
    // other controls.
    expect(container?.querySelector('button[title="View fullscreen"]')).toBeNull();
    expect(container?.querySelector('button[title="Copy code"]')).toBeTruthy();

    expect(diagram.getAttribute('role')).toBe('button');
    expect(diagram.getAttribute('tabindex')).toBe('0');
    expect(diagram.getAttribute('aria-label')).toBe('Open diagram');

    await clickOn(diagram);

    expect(viewer()).toBeTruthy();
    // The copy in the conversation stays where it was.
    expect(container?.querySelector('[data-streamdown="mermaid"] svg')).toBeTruthy();
    expect(viewerSurface()?.querySelector('svg[data-diagram="sequence"]')).toBeTruthy();
  });

  it('keeps its controls clear of the top safe-area inset', async () => {
    const diagram = await renderMarkdown();
    await clickOn(diagram);

    const close = viewerClose();
    expect(close).toBeTruthy();
    // A raw `top-4` — what the bundled overlay used — puts the only exit under
    // the status bar on a phone. The control bar must reserve that inset.
    const controlBar = close?.parentElement;
    expect(controlBar?.style.paddingTop).toContain('safe-area');
    expect(close?.className).toContain('h-11');
    expect(close?.className).toContain('w-11');
    // Above dialogs and popovers, on the app's z-index scale.
    expect(viewer()?.getAttribute('style')).toContain('--z-image-viewer');
  });

  it('closes from the button, from a click off the diagram, and from Escape', async () => {
    const diagram = await renderMarkdown();

    await clickOn(diagram);
    expect(viewer()).toBeTruthy();
    await clickOn(viewerClose() as Element);
    expect(viewer()).toBeNull();

    await clickOn(diagram);
    const surface = viewerSurface() as HTMLElement;
    // A click on the diagram itself must NOT close: panning it is the point.
    await clickOn(surface.querySelector('svg[data-diagram="sequence"]') as Element);
    expect(viewer()).toBeTruthy();
    await clickOn(surface);
    expect(viewer()).toBeNull();

    await clickOn(diagram);
    expect(viewer()).toBeTruthy();
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(viewer()).toBeNull();
  });

  it('opens from the keyboard, since the diagram replaced a focusable button', async () => {
    const diagram = await renderMarkdown();

    await act(async () => {
      diagram.focus();
      diagram.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });

    expect(viewer()).toBeTruthy();
  });

  it('removes diagram button semantics when the markdown rerenders without Mermaid', async () => {
    await renderMarkdown();
    expect(container?.querySelector('[aria-label="Open diagram"]')).toBeTruthy();

    await renderMarkdown(PLAIN_MARKDOWN);

    expect(container?.querySelector('[data-streamdown="mermaid"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Open diagram"]')).toBeNull();
  });
});
