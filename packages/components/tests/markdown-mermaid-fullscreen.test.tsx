// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeInitialDiagramZoom } from '../src/components/ai-gui/mermaid-diagram-viewer';
import { computeCanvasPinchFactor } from '../src/components/ai-gui/mermaid-inline-canvas';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

const DIAGRAM_WIDTH = 1200;
const DIAGRAM_HEIGHT = 800;

vi.mock('pele', () => ({
  render: () => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${DIAGRAM_WIDTH}" height="${DIAGRAM_HEIGHT}" style="color:var(--_fg)" data-diagram="sequence"><text>Launch game</text><script>window.diagramInjected = true</script><foreignObject><iframe src="https://example.com"></iframe></foreignObject><path onload="alert(1)" d="M0 0L10 10"/></svg>`,
    width: DIAGRAM_WIDTH,
    height: DIAGRAM_HEIGHT,
    links: [],
    type: 'sequence',
  }),
}));

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
 * The diagram renders after its runtime arrives through a dynamic import. Fake
 * timers make the wait a number of steps rather than a race against the wall
 * clock; `advanceTimersByTimeAsync` flushes the pending import between them.
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

  const clickOn = async (element: Element, init: MouseEventInit = {}) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    });
  };

  /** The pointer that started a click decides what it means, so it is replayed. */
  const pressWith = async (element: Element, pointerType: string) => {
    await act(async () => {
      element.dispatchEvent(
        Object.assign(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }), {
          pointerType,
          pointerId: 1,
          isPrimary: true,
        })
      );
    });
    await clickOn(element);
  };

  const readScale = (svg: SVGSVGElement) =>
    Number(svg.style.transform.match(/scale\(([-\d.]+)\)/)?.[1] ?? 1);
  const readTranslate = (svg: SVGSVGElement) => {
    const match = svg.style.transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
    return { x: Number(match?.[1] ?? 0), y: Number(match?.[2] ?? 0) };
  };

  /**
   * jsdom lays nothing out and applies no transform, so the frame gets a fixed
   * size and the diagram is measured the way a browser would: through whatever
   * transform is on it right now.
   */
  const stubCanvasRects = (diagram: HTMLElement, svg: SVGSVGElement) => {
    const asRect = (left: number, top: number, width: number, height: number) => {
      const rect = {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      };
      return { ...rect, toJSON: () => rect } as DOMRect;
    };
    vi.spyOn(diagram, 'getBoundingClientRect').mockReturnValue(asRect(0, 0, 400, 300));
    vi.spyOn(svg, 'getBoundingClientRect').mockImplementation(() => {
      const { x, y } = readTranslate(svg);
      const scale = readScale(svg);
      return asRect(x, y, 400 * scale, 300 * scale);
    });
  };

  const fullscreenButton = () =>
    container?.querySelector<HTMLElement>('[data-testid="mermaid-fullscreen-button"]') ?? null;

  const openViewer = async () => {
    const button = fullscreenButton();
    expect(button).toBeTruthy();
    await clickOn(button as Element);
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

  it('closes from the button, from a click off the diagram, and from Escape', async () => {
    await renderMarkdown();

    await openViewer();
    expect(viewer()).toBeTruthy();
    await clickOn(viewerClose() as Element);
    expect(viewer()).toBeNull();

    await openViewer();
    const surface = viewerSurface() as HTMLElement;
    // A click on the diagram itself must NOT close: panning it is the point.
    await clickOn(surface.querySelector('svg[data-diagram="sequence"]') as Element);
    expect(viewer()).toBeTruthy();
    await clickOn(surface);
    expect(viewer()).toBeNull();

    await openViewer();
    expect(viewer()).toBeTruthy();
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(viewer()).toBeNull();
  });

  it('activates from the keyboard, since the diagram is a focusable control', async () => {
    const diagram = await renderMarkdown();

    const pressEnter = async () => {
      await act(async () => {
        diagram.focus();
        diagram.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
      });
    };

    await pressEnter();
    expect(diagram.getAttribute('data-lody-canvas')).toBe('active');
    // The viewer stays out of the way: it has its own control.
    expect(viewer()).toBeNull();

    await pressEnter();
    expect(diagram.getAttribute('data-lody-canvas')).toBeNull();
  });

  it('turns a clicked diagram into a canvas that pinches where it stands', async () => {
    const diagram = await renderMarkdown();
    const svg = diagram.querySelector('svg') as SVGSVGElement;
    stubCanvasRects(diagram, svg);

    await pressWith(diagram, 'mouse');

    expect(diagram.getAttribute('data-lody-canvas')).toBe('active');
    expect(diagram.style.outline).toBe('');
    // Activation is not the viewer: the diagram stays in the conversation.
    expect(viewer()).toBeNull();

    const pinch = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -20,
      clientX: 200,
      clientY: 150,
    });
    await act(async () => {
      svg.dispatchEvent(pinch);
    });

    // Taken, so Chromium does not spend the pinch on zooming the whole window.
    expect(pinch.defaultPrevented).toBe(true);
    expect(readScale(svg)).toBeCloseTo(computeCanvasPinchFactor(-20), 5);
  });

  it('keeps the page scrolling even while a diagram is activated', async () => {
    const diagram = await renderMarkdown();
    const svg = diagram.querySelector('svg') as SVGSVGElement;
    stubCanvasRects(diagram, svg);
    await pressWith(diagram, 'mouse');

    const abovePage: number[] = [];
    const listener = (event: Event) => abovePage.push((event as WheelEvent).deltaY);
    container?.addEventListener('wheel', listener);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    await act(async () => {
      svg.dispatchEvent(wheel);
    });
    container?.removeEventListener('wheel', listener);

    // An unmodified wheel is never the canvas's: a reader who forgot they
    // activated a diagram must still be able to scroll past it.
    expect(wheel.defaultPrevented).toBe(false);
    expect(abovePage).toEqual([120]);
    expect(readScale(svg)).toBe(1);
  });

  it('drags the activated diagram, and releases it on Escape', async () => {
    const diagram = await renderMarkdown();
    const svg = diagram.querySelector('svg') as SVGSVGElement;
    stubCanvasRects(diagram, svg);
    await pressWith(diagram, 'mouse');
    // Zoom in first: a diagram that fits its frame has nowhere to pan.
    await act(async () => {
      svg.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -25,
          clientX: 0,
          clientY: 0,
        })
      );
    });
    const zoomed = readTranslate(svg);

    const pointer = (type: string, clientX: number, clientY: number) =>
      Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }), {
        pointerType: 'mouse',
        pointerId: 7,
        isPrimary: true,
      });
    await act(async () => {
      diagram.dispatchEvent(pointer('pointerdown', 200, 150));
      diagram.dispatchEvent(pointer('pointermove', 170, 130));
      diagram.dispatchEvent(pointer('pointerup', 170, 130));
    });

    expect(readTranslate(svg).x).toBe(zoomed.x - 30);
    expect(readTranslate(svg).y).toBe(zoomed.y - 20);

    const retainedTransform = svg.style.transform;

    // Escape belongs to the canvas only while the canvas has focus. An
    // activated diagram sitting in the scrollback must not answer the Escape
    // that dismisses a dialog, nor prevent its default.
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    const ignored = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      document.dispatchEvent(ignored);
    });
    expect(ignored.defaultPrevented).toBe(false);
    expect(diagram.getAttribute('data-lody-canvas')).toBe('active');
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();

    await act(async () => {
      diagram.focus();
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });

    // Escape stops interaction without moving the view.
    expect(diagram.getAttribute('data-lody-canvas')).toBeNull();
    expect(svg.style.transform).toBe(retainedTransform);
    expect(diagram.style.outline).toBe('');
  });

  it('keeps the viewer open when a press that began on the diagram is retargeted', async () => {
    await renderMarkdown();
    await openViewer();
    const surface = viewerSurface() as HTMLElement;
    const svg = surface.querySelector('svg[data-diagram="sequence"]') as Element;

    // Pointer capture retargets the `click` that follows a press on the diagram
    // to the capturing element, which is the surface itself. Without the press
    // being remembered, that click reads as one on the backdrop and closes the
    // viewer the user just opened.
    await act(async () => {
      svg.dispatchEvent(
        Object.assign(
          new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
          { pointerType: 'mouse', pointerId: 4, isPrimary: true }
        )
      );
    });
    await clickOn(surface);
    expect(viewer()).toBeTruthy();

    // A press that really did start on the backdrop still closes it.
    await act(async () => {
      surface.dispatchEvent(
        Object.assign(
          new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
          { pointerType: 'mouse', pointerId: 5, isPrimary: true }
        )
      );
    });
    await clickOn(surface);
    expect(viewer()).toBeNull();
  });

  it('opens the viewer instead of activating when the tap came from touch', async () => {
    const diagram = await renderMarkdown();

    await pressWith(diagram, 'touch');

    // Inline pinch would mean taking `touch-action` from the browser; the
    // viewer's control bar zooms instead.
    expect(viewer()).toBeTruthy();
    expect(diagram.getAttribute('data-lody-canvas')).toBeNull();
  });

  it.each(['outside press', 'focus out', 'Enter', 'viewer'])(
    'preserves the view across %s and resumes from its last transform',
    async (exit) => {
      const diagram = await renderMarkdown();
      const svg = diagram.querySelector('svg') as SVGSVGElement;
      stubCanvasRects(diagram, svg);
      await pressWith(diagram, 'mouse');
      await act(async () => {
        diagram.focus();
        diagram.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
        diagram.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      });
      const retainedTransform = svg.style.transform;
      const scale = readScale(svg);
      expect(scale).toBeGreaterThan(1);

      if (exit === 'viewer') {
        await openViewer();
        const viewerSvg = viewerSurface()?.querySelector('svg') as SVGSVGElement;
        expect(viewerSvg.style.transform).toBe('');
        await clickOn(viewerClose() as HTMLElement);
      } else {
        await act(async () => {
          if (exit === 'outside press') {
            document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
          } else if (exit === 'focus out') {
            diagram.blur();
          } else {
            diagram.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
        });
      }
      expect(diagram.getAttribute('data-lody-canvas')).toBeNull();
      expect(svg.style.transform).toBe(retainedTransform);
      const pinch = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -20,
        clientX: 200,
        clientY: 150,
      });
      await act(async () => {
        svg.dispatchEvent(pinch);
      });
      expect(pinch.defaultPrevented).toBe(false);
      expect(svg.style.transform).toBe(retainedTransform);

      await pressWith(diagram, 'mouse');
      expect(svg.style.transform).toBe(retainedTransform);
      await act(async () => {
        diagram.focus();
        diagram.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      });
      expect(readScale(svg)).toBeCloseTo(scale * scale, 5);
    }
  );

  it('zooms the open viewer on a pinch and leaves a plain wheel to scrolling', async () => {
    await renderMarkdown();
    await openViewer();
    const surface = viewerSurface() as HTMLElement;
    const zoomLabel = () => document.body.querySelector('[title="Reset zoom"]')?.textContent;
    expect(zoomLabel()).toBe('100%');

    const scroll = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -40 });
    await act(async () => {
      surface.dispatchEvent(scroll);
    });
    // An unmodified wheel is the surface's own scrolling, which is how it pans.
    expect(scroll.defaultPrevented).toBe(false);
    expect(zoomLabel()).toBe('100%');

    // A trackpad pinch: a ctrl-modified wheel, which would otherwise zoom the
    // whole window.
    const pinch = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -20,
    });
    await act(async () => {
      surface.dispatchEvent(pinch);
    });
    expect(pinch.defaultPrevented).toBe(true);
    expect(zoomLabel()).toBe('122%');
  });

  it('pans the open viewer by dragging the diagram, without closing on release', async () => {
    await renderMarkdown();
    await openViewer();
    const surface = viewerSurface() as HTMLElement;
    const svg = surface.querySelector('svg[data-diagram="sequence"]') as Element;
    surface.scrollLeft = 100;
    surface.scrollTop = 100;

    const pointer = (type: string, clientX: number, clientY: number) =>
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
    await act(async () => {
      svg.dispatchEvent(pointer('pointerdown', 200, 200));
      surface.dispatchEvent(pointer('pointermove', 180, 170));
      surface.dispatchEvent(pointer('pointerup', 180, 170));
    });

    expect(surface.scrollLeft).toBe(120);
    expect(surface.scrollTop).toBe(130);

    // The drag ended over the backdrop, but letting go of a pan is not a click
    // off the diagram.
    await clickOn(surface);
    expect(viewer()).toBeTruthy();
    // The next real click still closes.
    await clickOn(surface);
    expect(viewer()).toBeNull();
  });

  it('pans with one touch and zooms around two touch points', async () => {
    await renderMarkdown();
    await openViewer();
    const surface = viewerSurface() as HTMLElement;
    const svg = surface.querySelector('svg[data-diagram="sequence"]') as Element;
    const zoomLabel = () => document.body.querySelector('[title="Reset zoom"]')?.textContent;
    const pointer = (type: string, pointerId: number, clientX: number, clientY: number) =>
      Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }), {
        pointerType: 'touch',
        pointerId,
        isPrimary: pointerId === 1,
      });

    expect(surface.style.touchAction).toBe('none');
    surface.scrollLeft = 100;
    surface.scrollTop = 100;
    await act(async () => {
      svg.dispatchEvent(pointer('pointerdown', 1, 200, 200));
      surface.dispatchEvent(pointer('pointermove', 1, 180, 170));
      surface.dispatchEvent(pointer('pointerup', 1, 180, 170));
    });
    expect(surface.scrollLeft).toBe(120);
    expect(surface.scrollTop).toBe(130);

    await act(async () => {
      svg.dispatchEvent(pointer('pointerdown', 1, 100, 200));
      svg.dispatchEvent(pointer('pointerdown', 2, 200, 200));
      const move = pointer('pointermove', 2, 250, 200);
      surface.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);
      surface.dispatchEvent(pointer('pointerup', 2, 250, 200));
      surface.dispatchEvent(pointer('pointerup', 1, 100, 200));
    });

    expect(zoomLabel()).toBe('150%');
    // The pinch started on the diagram, so its synthetic click cannot dismiss
    // the viewer even though pointer capture retargets it to the surface.
    await clickOn(surface);
    expect(viewer()).toBeTruthy();
  });
});

// The same renderer result feeds inline markup, fullscreen clones and exports.
it('strips executable SVG markup before the diagram reaches any display surface', async () => {
  const { renderMarkdownMermaidSvg } = await import('../src/components/ai-gui/markdown-mermaid');
  const svg = await renderMarkdownMermaidSvg('graph TD; Safe-->Diagram');
  const host = document.createElement('div');
  host.innerHTML = svg;
  expect(host.querySelector('script, foreignObject, iframe, [onload]')).toBeNull();
  expect(host.querySelector('svg text')?.textContent).toBe('Launch game');
  expect(host.querySelector('svg path')).not.toBeNull();
});
