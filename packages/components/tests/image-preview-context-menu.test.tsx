// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { ZoomableImageViewer } from '../src/components/shared/zoomable-image-viewer';
import { resolveExportFileName } from '../src/lib/image-preview-export';
import { initI18n } from '../src/i18n';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const IMAGE_SRC = 'blob:lody/preview-image';

type ImagePreviewBridge = NonNullable<NonNullable<Window['api']>['imagePreview']>;

function createBridge(action: 'copy' | 'save' | null) {
  return {
    showMenu: vi.fn(async () => ({ action })),
    copyToClipboard: vi.fn(async () => ({ copied: true })),
    saveAs: vi.fn(async () => ({ saved: true as const, path: '/tmp/shot.png' })),
  } satisfies ImagePreviewBridge;
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
    delete window.api;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderViewer = () => {
    root = createRoot(container!);
    act(() => {
      root!.render(
        <ZoomableImageViewer
          open
          onClose={() => {}}
          images={[{ key: 'shot', src: IMAGE_SRC, fileName: 'diagram.png' }]}
          index={0}
        />
      );
    });
    const photo = document.querySelector<HTMLImageElement>('img.lody-photo-slider-image');
    expect(photo).not.toBeNull();
    return photo!;
  };

  /**
   * Drains the menu → fetch → blob → bridge chain. Every step of it settles on
   * the microtask/task queue (no timers), so draining the task queue a fixed
   * number of times is deterministic rather than a timed wait.
   */
  const flushAsync = async () => {
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const rightClick = async (photo: HTMLImageElement) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => {
      photo.dispatchEvent(event);
      await flushAsync();
    });
    return event;
  };

  it('copies the previewed image when the menu returns copy', async () => {
    const bridge = createBridge('copy');
    window.api = { imagePreview: bridge };
    stubImageFetch('image/png');

    const photo = renderViewer();
    const event = await rightClick(photo);

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
    window.api = { imagePreview: bridge };
    stubImageFetch('image/png');

    const photo = renderViewer();
    await rightClick(photo);

    expect(bridge.saveAs).toHaveBeenCalledTimes(1);
    expect(bridge.saveAs.mock.calls[0]![0]!.fileName).toBe('diagram.png');
    expect(bridge.copyToClipboard).not.toHaveBeenCalled();
  });

  it('does nothing further when the menu is dismissed', async () => {
    const bridge = createBridge(null);
    window.api = { imagePreview: bridge };
    stubImageFetch('image/png');

    const photo = renderViewer();
    await rightClick(photo);

    expect(bridge.showMenu).toHaveBeenCalledTimes(1);
    expect(bridge.copyToClipboard).not.toHaveBeenCalled();
    expect(bridge.saveAs).not.toHaveBeenCalled();
  });

  it('leaves the browser context menu alone without the desktop bridge', async () => {
    // No `window.api`: web and older preload builds keep their own menu.
    stubImageFetch('image/png');

    const photo = renderViewer();
    const event = await rightClick(photo);

    expect(event.defaultPrevented).toBe(false);
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
