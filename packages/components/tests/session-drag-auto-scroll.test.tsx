// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { useSessionDragAutoScroll } from '../src/hooks/use-session-drag-auto-scroll';
import { armSessionMentionDrag, clearSessionMentionDrag } from '../src/lib/session-mention-drag';
import { setPinnedPointerDrag } from '../src/lib/pinned-drop-settle';

/**
 * A 280x600 list viewport with `scrollTop` driven straight (jsdom lays out
 * nothing, so overflow only exists as the property the hook writes).
 */
describe('useSessionDragAutoScroll', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let viewport: HTMLDivElement;
  let queuedFrames: FrameRequestCallback[];

  function Harness() {
    const ref = useRef<HTMLDivElement | null>(null);
    useSessionDragAutoScroll(ref);
    return (
      <div
        ref={(element) => {
          ref.current = element;
          if (element) {
            element.getBoundingClientRect = () =>
              ({
                top: 0,
                bottom: 600,
                left: 0,
                right: 280,
                height: 600,
                width: 280,
                x: 0,
                y: 0,
                toJSON: () => ({}),
              }) as DOMRect;
            viewport = element;
          }
        }}
      />
    );
  }

  function runFrame() {
    const queued = queuedFrames;
    queuedFrames = [];
    for (const callback of queued) callback(0);
  }

  function dragPointerTo(clientX: number, clientY: number, type: 'dragover' | 'pointermove') {
    flushSync(() => {
      window.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true }));
    });
  }

  beforeEach(() => {
    queuedFrames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      queuedFrames[id - 1] = () => undefined;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(<Harness />);
    });
  });

  afterEach(() => {
    clearSessionMentionDrag();
    setPinnedPointerDrag(false);
    if (root) flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.unstubAllGlobals();
  });

  it('walks the list up while a session drag holds the pointer near the top', () => {
    viewport.scrollTop = 200;
    flushSync(() => armSessionMentionDrag('s1'));

    // Native HTML5 session drags report the pointer through dragover.
    dragPointerTo(140, 10, 'dragover');
    runFrame();
    expect(viewport.scrollTop).toBeLessThan(200);
    // It keeps moving while the pointer is held still at the edge.
    const afterFirst = viewport.scrollTop;
    runFrame();
    expect(viewport.scrollTop).toBeLessThan(afterFirst);
  });

  it('scrolls down near the bottom edge and not in the middle', () => {
    viewport.scrollTop = 200;
    flushSync(() => armSessionMentionDrag('s1'));

    dragPointerTo(140, 300, 'dragover');
    runFrame();
    expect(viewport.scrollTop).toBe(200);

    dragPointerTo(140, 595, 'dragover');
    runFrame();
    expect(viewport.scrollTop).toBeGreaterThan(200);
  });

  it('follows pointermove for pointer-driven session drags', () => {
    viewport.scrollTop = 200;
    flushSync(() => armSessionMentionDrag('s1'));

    // Pinned/focus row drags (dnd-kit) emit pointermove, never dragover.
    dragPointerTo(140, 10, 'pointermove');
    runFrame();
    expect(viewport.scrollTop).toBeLessThan(200);
  });

  it('scrolls for pinned-section drags, which arm no mention store', () => {
    viewport.scrollTop = 200;
    // Section-header drags set the pinned pointer-drag flag, not a session id.
    flushSync(() => setPinnedPointerDrag(true));

    dragPointerTo(140, 10, 'pointermove');
    runFrame();
    expect(viewport.scrollTop).toBeLessThan(200);
  });

  it('leaves the list alone while the pointer is outside its width', () => {
    viewport.scrollTop = 200;
    flushSync(() => armSessionMentionDrag('s1'));

    dragPointerTo(500, 10, 'dragover');
    runFrame();
    expect(viewport.scrollTop).toBe(200);
  });

  it('stops scrolling once the drag ends', () => {
    viewport.scrollTop = 200;
    flushSync(() => armSessionMentionDrag('s1'));
    dragPointerTo(140, 10, 'dragover');
    runFrame();
    expect(viewport.scrollTop).toBeLessThan(200);

    flushSync(() => clearSessionMentionDrag());
    const resting = viewport.scrollTop;
    runFrame();
    expect(viewport.scrollTop).toBe(resting);

    // Later events reach no listener until the next session drag.
    dragPointerTo(140, 10, 'dragover');
    runFrame();
    expect(viewport.scrollTop).toBe(resting);
  });
});
