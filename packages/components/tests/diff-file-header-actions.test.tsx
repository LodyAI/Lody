// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

import { DiffFileHeaderActions } from '../src/ui/diff-viewer/diff-file-header-actions';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const path = 'src/synthetic/评论/file.tsx';
function Header({ value = path, canOpen = true }: { value?: string; canOpen?: boolean }) {
  const [open, setOpen] = useState(true);
  const [openedPath, setOpenedPath] = useState('');
  const [pointerDowns, setPointerDowns] = useState(0);
  return (
    <>
      <div
        data-header
        onClick={() => setOpen((v) => !v)}
        onPointerDown={() => setPointerDowns((v) => v + 1)}
      >
        <span data-path>{value || '(empty)'}</span>
        <DiffFileHeaderActions path={value} onOpenFile={canOpen ? setOpenedPath : undefined} />
      </div>
      {open && <section>Expanded file content</section>}
      <output>{`Opened: ${openedPath}; parent pointerdowns: ${pointerDowns}`}</output>
    </>
  );
}

describe('DiffFileHeaderActions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let clipboard: string;
  let rejectWrite: boolean;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    clipboard = 'unchanged clipboard';
    rejectWrite = false;
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (next: string) => {
          if (rejectWrite) throw new DOMException('Clipboard permission denied', 'NotAllowedError');
          clipboard = next;
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
    vi.useRealTimers();
  });

  const copyButton = () =>
    container.querySelector('button[aria-label="Copy file path"]') as HTMLButtonElement;
  const activate = async (button: HTMLElement) => {
    await act(async () => {
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('copies exact path bytes, shows the check for two seconds and preserves the expanded parent', async () => {
    await act(() => root.render(createElement(Header)));
    expect(copyButton().querySelector('svg rect')).not.toBeNull();
    await activate(copyButton());
    expect(clipboard).toBe(path);
    expect(container.querySelector('section')?.textContent).toBe('Expanded file content');
    expect(container.querySelector('output')?.textContent).toBe('Opened: ; parent pointerdowns: 0');
    expect(copyButton().querySelector('svg rect')).toBeNull();
    expect(copyButton().querySelector('svg path')).not.toBeNull();
    await act(() => vi.advanceTimersByTime(1999));
    expect(copyButton().querySelector('svg rect')).toBeNull();
    await act(() => vi.advanceTimersByTime(1));
    expect(copyButton().querySelector('svg rect')).not.toBeNull();
    await act(() =>
      container
        .querySelector('[data-path]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    expect(container.querySelector('section')).toBeNull();
  });

  it('keeps the clipboard and original copy glyph when browser permission rejects the write', async () => {
    rejectWrite = true;
    await act(() => root.render(createElement(Header)));
    await activate(copyButton());
    await act(() => vi.advanceTimersByTime(2000));
    expect(clipboard).toBe('unchanged clipboard');
    expect(copyButton().querySelector('svg rect')).not.toBeNull();
    expect(container.querySelector('section')).not.toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('Opened: ; parent pointerdowns: 0');
  });

  it('opens the exact file without collapsing the parent or bubbling its pointerdown', async () => {
    await act(() => root.render(createElement(Header)));
    await activate(container.querySelector('button[aria-label="Open file"]') as HTMLButtonElement);
    expect(container.querySelector('output')?.textContent).toBe(
      `Opened: ${path}; parent pointerdowns: 0`
    );
    expect(container.querySelector('section')).not.toBeNull();
    expect(clipboard).toBe('unchanged clipboard');
    await act(() =>
      container
        .querySelector('[data-path]')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    );
    expect(container.querySelector('output')?.textContent).toContain('parent pointerdowns: 1');
  });

  it('retains working copy without an opener', async () => {
    await act(() => root.render(createElement(Header, { canOpen: false })));
    expect(container.querySelector('button[aria-label="Open file"]')).toBeNull();
    await activate(copyButton());
    expect(clipboard).toBe(path);
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('treats an empty path as a copy no-op while preserving parent event isolation', async () => {
    await act(() => root.render(createElement(Header, { value: '' })));
    await activate(copyButton());
    await act(() => vi.advanceTimersByTime(2000));
    expect(clipboard).toBe('unchanged clipboard');
    expect(copyButton().querySelector('svg rect')).not.toBeNull();
    expect(container.querySelector('section')).not.toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('Opened: ; parent pointerdowns: 0');
  });
});
