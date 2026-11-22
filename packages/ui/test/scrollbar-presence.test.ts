import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SCROLLBAR_HOVER_ATTRIBUTE,
  SCROLLBAR_SCROLLING_ATTRIBUTE,
  installScrollbarPresence,
} from '../src/scroll-area/scrollbar-presence';

/** A 200×200 box with 1000px of content and a 12px vertical scrollbar. */
function scroller(): HTMLDivElement {
  const element = document.createElement('div');
  const layout = { clientWidth: 188, clientHeight: 200, offsetWidth: 200, offsetHeight: 200 };
  for (const [key, value] of Object.entries({
    ...layout,
    clientLeft: 0,
    clientTop: 0,
    scrollHeight: 1000,
    scrollWidth: 188,
  }))
    Object.defineProperty(element, key, { value });
  document.body.append(element);
  return element;
}

const pointer = (target: Element, type: string, offsetX: number, offsetY = 20) => {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget: null });
  Object.defineProperties(event, { offsetX: { value: offsetX }, offsetY: { value: offsetY } });
  target.dispatchEvent(event);
};
const scroll = (target: Element) => target.dispatchEvent(new Event('scroll'));
const wheel = (target: Element) => target.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));

describe('installScrollbarPresence', () => {
  let uninstall: () => void;
  let element: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    uninstall = installScrollbarPresence();
    element = scroller();
  });
  afterEach(() => {
    uninstall();
    element.remove();
    vi.useRealTimers();
  });

  test('a scroll the person makes shows the thumb until scrolling pauses', () => {
    wheel(element);
    scroll(element);
    expect(element.hasAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE)).toBe(true);

    vi.advanceTimersByTime(400);
    scroll(element);
    vi.advanceTimersByTime(400);
    expect(element.hasAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE)).toBe(true);

    vi.advanceTimersByTime(100);
    expect(element.hasAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE)).toBe(false);
  });

  test('a scroll the app makes, such as following a streaming reply, keeps the thumb hidden', () => {
    scroll(element);
    expect(element.hasAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE)).toBe(false);

    wheel(element);
    vi.advanceTimersByTime(600);
    scroll(element);
    expect(element.hasAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE)).toBe(false);

    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    scroll(element);
    expect(element.hasAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE)).toBe(false);
    editor.remove();
  });

  test('the pointer on the scrollbar gutter widens the thumb; content and other elements do not', () => {
    pointer(element, 'pointermove', 100);
    expect(element.hasAttribute(SCROLLBAR_HOVER_ATTRIBUTE)).toBe(false);

    pointer(element, 'pointermove', 194);
    expect(element.hasAttribute(SCROLLBAR_HOVER_ATTRIBUTE)).toBe(true);

    pointer(element, 'pointermove', 100);
    expect(element.hasAttribute(SCROLLBAR_HOVER_ATTRIBUTE)).toBe(false);

    const inline = document.createElement('span');
    document.body.append(inline);
    pointer(inline, 'pointermove', 194);
    expect(inline.hasAttribute(SCROLLBAR_HOVER_ATTRIBUTE)).toBe(false);
    inline.remove();
  });

  test('dragging the thumb keeps it shown while the scrollbar owns the pointer', () => {
    pointer(element, 'pointerdown', 194);
    vi.advanceTimersByTime(2000);
    scroll(element);
    expect(element.hasAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE)).toBe(true);
    expect(element.hasAttribute(SCROLLBAR_HOVER_ATTRIBUTE)).toBe(true);

    pointer(element, 'pointerup', 100);
    expect(element.hasAttribute(SCROLLBAR_HOVER_ATTRIBUTE)).toBe(false);
    vi.advanceTimersByTime(500);
    scroll(element);
    expect(element.hasAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE)).toBe(false);
  });

  test('uninstalling clears every published state', () => {
    wheel(element);
    scroll(element);
    pointer(element, 'pointermove', 194);
    uninstall();
    expect(element.hasAttribute(SCROLLBAR_SCROLLING_ATTRIBUTE)).toBe(false);
    expect(element.hasAttribute(SCROLLBAR_HOVER_ATTRIBUTE)).toBe(false);
    uninstall = installScrollbarPresence();
  });
});
