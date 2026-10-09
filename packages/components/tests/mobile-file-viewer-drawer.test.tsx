// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileFileViewerDrawer } from '../src/components/mobile/mobile-file-viewer-drawer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

const runtime = vi.hoisted(() => ({ native: true, ios: false }));
vi.mock('../src/lib/native-platform', () => ({
  isNativeAppShell: () => runtime.native,
  isNativeIOSAppShell: () => runtime.native && runtime.ios,
}));

vi.mock('../src/components/mobile/mobile-session-menu-sheet', async () => {
  const React = await import('react');
  return {
    MobileSessionMenuSheet: ({
      actions,
    }: {
      readonly actions: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly onClick: () => void;
      }>;
    }) =>
      React.createElement(
        'div',
        null,
        actions.map((action) =>
          React.createElement(
            'button',
            { key: action.id, type: 'button', onClick: action.onClick },
            action.label
          )
        )
      ),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  runtime.native = true;
  runtime.ios = false;
});

function renderDrawer(onCopyMarkdown?: () => void): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(
        MobileFileViewerDrawer,
        {
          open: true,
          onOpenChange: vi.fn(),
          filePath: 'README.md',
          onCopyPath: vi.fn(),
          ...(onCopyMarkdown ? { onCopyMarkdown } : {}),
        },
        createElement('textarea', { 'aria-label': 'File text', defaultValue: '# Example' })
      )
    );
  });
  return document.body;
}

describe('MobileFileViewerDrawer', () => {
  it('adds a full Markdown copy action when the file view provides one', () => {
    let copied = '';
    const onCopyMarkdown = () => {
      copied = '# Example';
    };
    const view = renderDrawer(onCopyMarkdown);
    const action = Array.from(view.querySelectorAll('button')).find(
      (button) => button.textContent === 'Copy full Markdown'
    );

    expect(action).not.toBeUndefined();
    act(() => action?.click());
    expect(copied).toBe('# Example');
  });

  it('omits the full Markdown copy action for other file types', () => {
    const view = renderDrawer();
    expect(view.textContent).not.toContain('Copy full Markdown');
    expect(view.textContent).toContain('Copy file path');
  });

  it.each([true, false])(
    'resizes with the visual viewport and restores on hide (native: %s)',
    (native) => {
      runtime.native = native;
      const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
      vi.stubGlobal('visualViewport', viewport);
      vi.stubGlobal('innerHeight', 800);
      renderDrawer();
      const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
      const editor = drawer.querySelector('textarea')!;
      act(() => {
        editor.focus();
        editor.setSelectionRange(3, 3);
      });
      for (const height of [480, 400, 800]) {
        act(() => {
          viewport.height = height;
          viewport.dispatchEvent(new Event('resize'));
        });
        expect(drawer.style.bottom).toBe(`${800 - height}px`);
        expect(drawer.style.height).toBe('');
        expect(document.activeElement).toBe(editor);
        expect(editor.value).toBe('# Example');
        expect(editor.selectionStart).toBe(3);
      }
    }
  );

  it('uses the native iOS keyboard inset without Vaul writing a second height', () => {
    runtime.ios = true;
    const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', viewport);
    renderDrawer();
    const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
    const editor = drawer.querySelector('textarea')!;
    act(() => {
      editor.focus();
      editor.setSelectionRange(3, 3);
    });
    for (const height of [480, 800]) {
      act(() => {
        viewport.height = height;
        viewport.dispatchEvent(new Event('resize'));
      });
      expect(drawer.style.bottom).toBe('var(--native-keyboard-height, 0px)');
      expect(drawer.style.height).toBe('');
      expect(document.activeElement).toBe(editor);
      expect(editor.value).toBe('# Example');
      expect(editor.selectionStart).toBe(3);
    }
  });
});
