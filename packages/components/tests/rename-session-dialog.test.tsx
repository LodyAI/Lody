// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';

import { SessionList } from '../src/components/session-list';
import { RenameSessionDialogView } from '../src/components/sessions/rename-session-dialog';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type MockResizeObserverInstance = {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
};

const resizeObserverInstances: MockResizeObserverInstance[] = [];

class MockResizeObserver {
  private readonly instance: MockResizeObserverInstance;

  constructor(callback: ResizeObserverCallback) {
    this.instance = { callback, targets: new Set<Element>() };
    resizeObserverInstances.push(this.instance);
  }

  observe = (target: Element) => {
    this.instance.targets.add(target);
  };

  unobserve = (target: Element) => {
    this.instance.targets.delete(target);
  };

  disconnect = () => {
    this.instance.targets.clear();
  };
}

/**
 * jsdom has no layout, so on mount the field reports the zero width and zero
 * scroll height that a not-yet-laid-out textarea reports in a browser. This
 * stands in for the layout that arrives afterwards: `scrollHeight` wraps the
 * current value at the current width, which is what the dialog measures.
 */
function attachLayout(textarea: HTMLTextAreaElement, lineHeight: number, charWidth: number) {
  const computed = window.getComputedStyle(textarea);
  const padding =
    (Number.parseFloat(computed.paddingTop) || 0) +
    (Number.parseFloat(computed.paddingBottom) || 0);
  let width = 0;
  Object.defineProperty(textarea, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(textarea, 'scrollHeight', {
    configurable: true,
    get: () => {
      if (width <= 0) return 0;
      const charsPerLine = Math.max(1, Math.floor(width / charWidth));
      const lines = Math.max(1, Math.ceil(textarea.value.length / charsPerLine));
      return lines * lineHeight + padding;
    },
  });
  return {
    setWidth: (next: number) => {
      width = next;
    },
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('RenameSessionDialogView', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    root = undefined;
    container = undefined;
  });

  it('focuses the title and ignores Enter while the IME is composing', async () => {
    const onRename = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        <RenameSessionDialogView
          target={{
            sessionId: 'rename-session' as SessionId,
            initialTitle: 'Original title',
          }}
          onClose={onClose}
          onRename={onRename}
        />
      );
    });

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(textarea?.rows).toBe(1);
    expect(document.activeElement).toBe(textarea);
    const singleLineHeight = Number.parseFloat(textarea?.style.height ?? '0');

    await act(async () => {
      if (!textarea) return;
      Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 72 });
      setTextareaValue(textarea, 'Composed title');
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          isComposing: true,
        })
      );
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(Number.parseFloat(textarea?.style.height ?? '0')).toBeGreaterThan(singleLineHeight);

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(onRename).toHaveBeenCalledWith('rename-session', 'Composed title');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens the shared Rename Chat dialog from a sidebar session title', async () => {
    const onRenameSession = vi.fn();

    await act(async () => {
      root?.render(
        <SessionList
          sessions={[
            {
              sessionId: 'sidebar-session',
              title: 'Sidebar title',
              repoFullName: null,
              branchName: '',
              latestMessageAt: 0,
              addedLines: 0,
              deletedLines: 0,
              isWorking: false,
              hasUnreadMessages: false,
              isOffline: false,
              isWaitingPermission: false,
            },
          ]}
          repos={[]}
          onRenameSession={onRenameSession}
        />
      );
    });

    const title = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-sidebar-session-id] span') ?? []
    ).find((element) => element.textContent === 'Sidebar title');
    expect(title).toBeInstanceOf(HTMLElement);

    await act(async () => {
      title?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.value).toBe('Sidebar title');
    expect(document.activeElement).toBe(textarea);

    await act(async () => {
      if (!textarea) return;
      setTextareaValue(textarea, 'Renamed from sidebar');
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(onRenameSession).toHaveBeenCalledWith('sidebar-session', 'Renamed from sidebar');
  });

  it('grows the title field once the dialog panel has been laid out', async () => {
    // `observeResizeOnAnimationFrame` defers to a frame; run it inline so the
    // assertions do not depend on the scheduler.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    resizeObserverInstances.length = 0;

    // jsdom applies no Tailwind, so the line height is the function's own
    // fallback and the padding/border come from the UA stylesheet. Assertions
    // are relative to the one-line height so they do not encode either.
    const LINE_HEIGHT = 20;
    const CHAR_WIDTH = 8;
    const title = 'A generated session title long enough to wrap onto a second line';

    await act(async () => {
      root?.render(
        <RenameSessionDialogView
          target={{ sessionId: 'grow-session' as SessionId, initialTitle: title }}
          onClose={vi.fn()}
          onRename={vi.fn()}
        />
      );
    });

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    const field = textarea as HTMLTextAreaElement;
    // The mount measurement ran before the portalled panel had a width, so the
    // field sits at its one-line height holding a value that wraps.
    const oneLineHeight = Number.parseFloat(field.style.height);
    expect(oneLineHeight).toBeGreaterThan(0);

    const layout = attachLayout(field, LINE_HEIGHT, CHAR_WIDTH);
    const observed = resizeObserverInstances.find((instance) => instance.targets.has(field));
    expect(observed).toBeDefined();

    await act(async () => {
      layout.setWidth(CHAR_WIDTH * 40);
      observed?.callback([], observed as unknown as ResizeObserver);
    });

    expect(field.style.height).toBe(`${oneLineHeight + LINE_HEIGHT}px`);
    expect(field.style.overflowY).toBe('hidden');

    await act(async () => {
      setTextareaValue(field, title.repeat(4));
    });

    // Past four lines the field stops growing and scrolls instead.
    expect(field.style.height).toBe(`${oneLineHeight + LINE_HEIGHT * 3}px`);
    expect(field.style.overflowY).toBe('auto');
  });
});
