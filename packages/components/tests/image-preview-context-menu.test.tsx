// @vitest-environment jsdom

import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { ZoomableImageViewer } from '../src/components/shared/zoomable-image-viewer';
import {
  resolveExportFileName,
  type ImagePreviewExportBridge,
} from '../src/lib/image-preview-export';
import { initI18n } from '../src/i18n';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const IMAGE_SRC = 'blob:lody/preview-image';

function createBridge(action: 'copy' | 'save' | null) {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    finished,
    showMenu: vi.fn(async () => {
      if (!action) finish();
      return { action };
    }),
    copyToClipboard: vi.fn(async () => {
      finish();
      return { copied: true };
    }),
    saveAs: vi.fn(async () => {
      finish();
      return { saved: true as const, path: '/tmp/shot.png' };
    }),
  } satisfies ImagePreviewExportBridge & { finished: Promise<void> };
}

function installImageIpc(bridge: ImagePreviewExportBridge) {
  window.ipc = {
    invoke: async (channel, ...args) => {
      const input = args[0];
      if (channel === 'image.showPreviewMenu') return bridge.showMenu(input as never);
      if (channel === 'image.copyToClipboard') return bridge.copyToClipboard(input as never);
      if (channel === 'image.saveAs') return bridge.saveAs(input as never);
      throw new Error(`unexpected invoke ${channel}`);
    },
    on: () => () => {},
    send: () => {},
  };
}

/**
 * The viewer reads bytes back out of the `blob:` URL it is displaying. jsdom
 * resolves neither `blob:` URLs nor `fetch`, and its `Blob` has no
 * `arrayBuffer()`, so this stands in for the browser side of that read.
 */
function stubImageFetch(mimeType: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      expect(input).toBe(IMAGE_SRC);
      return {
        ok: true,
        status: 200,
        blob: async () => ({
          type: mimeType,
          arrayBuffer: async () => PNG_BYTES.slice().buffer,
        }),
      };
    })
  );
}

describe('image preview context menu', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    // jsdom ships no matchMedia, which `useIsMobile` subscribes to.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    window.__LODY_ELECTRON__ = true;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    delete window.__LODY_ELECTRON__;
    delete window.ipc;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as Partial<HTMLElement>).inert;
  });

  const renderViewer = (onClose: () => void = () => {}) => {
    function Preview() {
      const [open, setOpen] = useState(true);
      return (
        <ZoomableImageViewer
          open={open}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
          images={[{ key: 'shot', src: IMAGE_SRC, fileName: 'diagram.png' }]}
          index={0}
        />
      );
    }
    root = createRoot(container!);
    act(() => {
      root!.render(<Preview />);
    });
    const photo = document.querySelector<HTMLImageElement>('img.lody-photo-slider-image');
    expect(photo).not.toBeNull();
    return photo!;
  };

  const rightClick = async (photo: HTMLImageElement, finished = Promise.resolve()) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => {
      photo.dispatchEvent(event);
      await finished;
    });
    return event;
  };

  it.each([IMAGE_SRC, undefined])(
    'isolates the gallery and restores its opener with source %s',
    async (src) => {
      vi.useFakeTimers();
      // jsdom lacks the browser's inert property and native layout/focus traversal.
      Object.defineProperty(HTMLElement.prototype, 'inert', {
        configurable: true,
        get() {
          return this.hasAttribute('inert');
        },
        set(value: boolean) {
          this.toggleAttribute('inert', value);
        },
      });
      const images = [
        { key: 'one', src },
        { key: 'two', src },
        { key: 'three', src },
      ];
      function Gallery() {
        const [open, setOpen] = useState(false);
        const [index, setIndex] = useState(0);
        return (
          <>
            <button onClick={() => setOpen(true)}>before-vs-after.png</button>
            <button>before.png</button>
            <ZoomableImageViewer
              open={open}
              onClose={() => setOpen(false)}
              images={images}
              index={index}
              onIndexChange={setIndex}
            />
          </>
        );
      }
      root = createRoot(container!);
      act(() => root!.render(<Gallery />));
      const [opener, background] = container!.querySelectorAll('button');
      opener!.focus();
      await act(async () => opener!.click());
      await act(async () => vi.advanceTimersByTimeAsync(20));
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
      expect(dialog).not.toBeNull();
      const close = dialog!.querySelector<HTMLButtonElement>(
        'button[aria-label="Close image preview"]'
      )!;
      const next = dialog!.querySelector<HTMLButtonElement>('button[aria-label="Next image"]')!;
      expect(close.tagName).toBe('BUTTON');
      expect(next.tagName).toBe('BUTTON');
      expect(document.activeElement).toBe(close);
      expect(background!.closest('[inert]')).not.toBeNull();
      await act(async () => {
        close.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
        );
      });
      expect(dialog!.textContent).toContain('2 / 3');
      await act(async () => {
        close.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        );
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(background!.closest('[inert]')).toBeNull();
      expect(document.activeElement).toBe(opener);
    }
  );

  it('copies the previewed image when the menu returns copy', async () => {
    const bridge = createBridge('copy');
    installImageIpc(bridge);
    stubImageFetch('image/png');

    const photo = renderViewer();
    const event = await rightClick(photo, bridge.finished);

    expect(event.defaultPrevented).toBe(true);
    expect(bridge.showMenu).toHaveBeenCalledTimes(1);
    expect(bridge.showMenu.mock.calls[0]![0]!.items.map((item) => item.action)).toEqual([
      'copy',
      'save',
    ]);
    expect(bridge.copyToClipboard).toHaveBeenCalledTimes(1);
    const copied = bridge.copyToClipboard.mock.calls[0]![0]!.pngBytes;
    expect(new Uint8Array(copied)).toEqual(PNG_BYTES);
    expect(bridge.saveAs).not.toHaveBeenCalled();
  });

  it('saves under the source file name when the menu returns save', async () => {
    const bridge = createBridge('save');
    installImageIpc(bridge);
    stubImageFetch('image/png');

    const photo = renderViewer();
    await rightClick(photo, bridge.finished);

    expect(bridge.saveAs).toHaveBeenCalledTimes(1);
    expect(bridge.saveAs.mock.calls[0]![0]!.fileName).toBe('diagram.png');
    expect(bridge.copyToClipboard).not.toHaveBeenCalled();
  });

  it('does nothing further when the menu is dismissed', async () => {
    const bridge = createBridge(null);
    installImageIpc(bridge);
    stubImageFetch('image/png');

    const photo = renderViewer();
    const event = await rightClick(photo, bridge.finished);
    expect(event.defaultPrevented).toBe(true);

    expect(bridge.showMenu).toHaveBeenCalledTimes(1);
    expect(bridge.copyToClipboard).not.toHaveBeenCalled();
    expect(bridge.saveAs).not.toHaveBeenCalled();
  });

  it('leaves the browser context menu alone without the desktop bridge', async () => {
    // No `window.ipc`: web and older preload builds keep their own menu.
    stubImageFetch('image/png');

    const photo = renderViewer();
    const event = await rightClick(photo);

    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps a tap on the zoom surface from closing the viewer', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const photo = renderViewer(onClose);

    await act(async () => {
      photo.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
      );
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(350);
    });

    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  });
});

describe('resolveExportFileName', () => {
  it('keeps the source name when it already carries an extension', () => {
    expect(resolveExportFileName('diagram.png', 'image/png')).toBe('diagram.png');
    expect(resolveExportFileName('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg');
  });

  it('reduces a path to its base name', () => {
    expect(resolveExportFileName('docs/assets/diagram.png', 'image/png')).toBe('diagram.png');
  });

  it('appends an extension only when the source name has none', () => {
    expect(resolveExportFileName('pasted-image', 'image/webp')).toBe('pasted-image.webp');
    expect(resolveExportFileName('pasted-image', 'application/octet-stream')).toBe('pasted-image');
  });

  it('falls back to a generic name when there is no source name', () => {
    expect(resolveExportFileName(undefined, 'image/jpeg')).toBe('image.jpg');
    expect(resolveExportFileName(undefined, undefined)).toBe('image.png');
  });
});
