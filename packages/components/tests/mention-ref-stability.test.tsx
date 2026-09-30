// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Mention, MentionInput, MentionItem, useMentionContext } from '../src/ui/mention';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('Mention ref stability', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;

  beforeEach(() => {
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback) => {
      callback(0);
      return 0;
    }) as typeof requestAnimationFrame;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      delete (
        globalThis as typeof globalThis & { requestAnimationFrame?: typeof requestAnimationFrame }
      ).requestAnimationFrame;
    }
    originalRequestAnimationFrame = undefined;
  });

  function renderMention(tick: number) {
    act(() => {
      root?.render(
        <Mention inputValue="@" defaultOpen>
          <MentionItem value="src/" label={`src-${tick}`}>
            src/
          </MentionItem>
          <MentionItem value="docs/" label="docs">
            docs/
          </MentionItem>
        </Mention>
      );
    });
  }

  it('does not re-enter updates when item rows mount and the parent rerenders', () => {
    renderMention(0);
    renderMention(1);
    renderMention(2);

    expect(container?.querySelectorAll('[data-slot="mention-item"]')).toHaveLength(2);
  });

  it('reuses the virtual anchor for repeated updates at the same trigger position', () => {
    const anchors: unknown[] = [];

    function VirtualAnchorProbe() {
      const context = useMentionContext('VirtualAnchorProbe');
      React.useEffect(() => {
        anchors.push(context.virtualAnchor);
      }, [context.virtualAnchor]);
      return null;
    }

    act(() => {
      root?.render(
        <Mention inputValue="@src" defaultOpen>
          <VirtualAnchorProbe />
          <MentionInput value="@src" onChange={() => {}} />
          <MentionItem value="src/" label="src">
            src/
          </MentionItem>
        </Mention>
      );
    });

    const input = container?.querySelector('textarea');
    if (!input) throw new Error('Expected mention textarea to render');

    act(() => {
      input.setSelectionRange(4, 4);
      input.focus();
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nonNullAnchors = anchors.filter(Boolean);
    expect(nonNullAnchors.length).toBeGreaterThan(0);
    expect(new Set(nonNullAnchors).size).toBe(1);
  });

  it('moves the menu anchor with the caret across columns and lines', () => {
    let anchorRect: DOMRect | null = null;
    let anchor: ReturnType<typeof useMentionContext>['virtualAnchor'] = null;

    function VirtualAnchorProbe() {
      const { virtualAnchor } = useMentionContext('VirtualAnchorProbe');
      anchor = virtualAnchor;
      anchorRect = virtualAnchor?.getBoundingClientRect() ?? null;
      return null;
    }

    function CaretHarness() {
      const [value, setValue] = React.useState('@');
      return (
        <Mention inputValue={value} onInputValueChange={setValue} defaultOpen>
          <VirtualAnchorProbe />
          <MentionInput value={value} onChange={() => {}} />
          <MentionItem value="source" label="source">
            source
          </MentionItem>
        </Mention>
      );
    }

    act(() => {
      root?.render(<CaretHarness />);
    });

    const input = container?.querySelector('textarea');
    if (!input) throw new Error('Expected mention textarea to render');
    input.style.lineHeight = '20px';
    input.style.padding = '0px';
    const inputRect = vi
      .spyOn(input, 'getBoundingClientRect')
      .mockReturnValue(DOMRect.fromRect({ x: 100, y: 200, width: 400, height: 40 }));
    vi.spyOn(input, 'clientWidth', 'get').mockReturnValue(400);
    const width = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this === input ? 400 : 0;
      });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const mirrorRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.parentElement === document.documentElement && this.tagName === 'DIV') {
          return DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 60 });
        }
        if (this.tagName === 'SPAN' && this.textContent === '\u200b') {
          const before = this.parentElement?.firstChild?.textContent ?? '';
          const position = before.startsWith('long prefix')
            ? { x: 48, y: 40 }
            : { x: before.includes('@source') ? 56 : 8, y: before.startsWith('\n') ? 20 : 0 };
          return DOMRect.fromRect({ ...position, width: 0, height: 17 });
        }
        return originalRect.call(this);
      });

    try {
      act(() => {
        input.setSelectionRange(1, 1);
        input.focus();
        input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(anchorRect?.x).toBe(108);

      act(() => {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        )?.set;
        setValue?.call(input, '@source');
        input.setSelectionRange(7, 7);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(anchorRect?.x).toBe(156);

      act(() => {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        )?.set;
        setValue?.call(input, '\n@source');
        input.setSelectionRange(8, 8);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(anchorRect?.y).toBe(220);

      act(() => {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        )?.set;
        setValue?.call(input, 'long prefix with several words that wrap @');
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(anchorRect?.x).toBe(148);
      expect(anchorRect?.y).toBe(240);
      expect(anchor?.contextElement).toBe(input);

      inputRect.mockReturnValue(DOMRect.fromRect({ x: 200, y: 200, width: 400, height: 40 }));
      expect(anchor?.getBoundingClientRect().x).toBe(248);
    } finally {
      width.mockRestore();
      mirrorRect.mockRestore();
    }
  });
});
