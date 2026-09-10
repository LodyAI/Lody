// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyShareImage, exportShareImage } from '../src/lib/share-image-export';

const mocks = vi.hoisted(() => ({ toBlob: vi.fn(), bridge: vi.fn() }));
vi.mock('@zumer/snapdom', () => ({ snapdom: { toBlob: mocks.toBlob } }));
vi.mock('../src/lib/image-preview-export', () => ({ getImagePreviewExportBridge: mocks.bridge }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  mocks.toBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  mocks.bridge.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('share image export', () => {
  it('pins ordinary, nested, and explicitly restarted list numbers during capture', async () => {
    const card = document.createElement('div');
    card.innerHTML =
      '<ol><li>First<ol start="3"><li>Nested</li><li>Nested</li></ol></li><li>Second</li><li value="7">Restart</li><li>Next</li></ol>';
    const original = card.innerHTML;
    let captured: number[] = [];
    mocks.toBlob.mockImplementation(async (element: HTMLElement) => {
      captured = Array.from(element.querySelectorAll('li')).map((item) => item.value);
      return new Blob([]);
    });
    await expect(exportShareImage(card, undefined, 'lody-conversation')).rejects.toThrow('PNG encoding failed');
    expect(captured).toEqual([1, 3, 4, 2, 7, 8]);
    expect(card.innerHTML).toBe(original);
  });

  it('preserves reversed numbering and restores attributes even when capture fails', async () => {
    const card = document.createElement('div');
    card.innerHTML =
      '<ol reversed><li>Three</li><li>Two</li><li>One</li></ol><ol reversed start="9"><li>Nine</li><li value="0">Zero</li><li>Negative</li></ol>';
    const original = card.innerHTML;
    let captured: number[] = [];
    mocks.toBlob.mockImplementation(async (element: HTMLElement) => {
      captured = Array.from(element.querySelectorAll('li')).map((item) => item.value);
      throw new Error('Capture failed');
    });
    await expect(exportShareImage(card, undefined, 'lody-conversation')).rejects.toThrow('Capture failed');
    expect(captured).toEqual([3, 2, 1, 9, 0, -1]);
    expect(card.innerHTML).toBe(original);
  });

  it('downloads a PNG with a sanitized title and releases the object URL afterward', async () => {
    const downloads: { name: string; url: string }[] = [];
    const revoked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      downloads.push({ name: this.download, url: this.href });
    });
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:share-image',
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    await exportShareImage(document.createElement('div'), 'Review / rendering', 'lody-conversation');
    expect(downloads).toEqual([{ name: 'Review - rendering.png', url: 'blob:share-image' }]);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(['blob:share-image']);
  });

  it('hands PNG bytes to the native save dialog and accepts cancellation', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
    mocks.toBlob.mockResolvedValue({
      type: 'image/png',
      size: bytes.byteLength,
      arrayBuffer: async () => bytes,
    });
    let saved: unknown;
    mocks.bridge.mockReturnValue({
      saveAs: async (input: unknown) => {
        saved = input;
        return { saved: false, canceled: true };
      },
    });
    await exportShareImage(document.createElement('div'), undefined, 'lody-conversation');
    expect(saved).toEqual({ fileName: 'lody-conversation.png', bytes });
  });

  it('propagates native save failure so the dialog can offer retry', async () => {
    mocks.toBlob.mockResolvedValue({
      type: 'image/png',
      size: 1,
      arrayBuffer: async () => new ArrayBuffer(1),
    });
    mocks.bridge.mockReturnValue({ saveAs: async () => ({ saved: false, error: 'Disk full' }) });
    await expect(exportShareImage(document.createElement('div'), undefined, 'lody-conversation')).rejects.toThrow('Disk full');
  });

  it('hands PNG bytes to Electron clipboard and propagates copy failure', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
    const copyToClipboard = vi.fn(async () => ({ copied: true }));
    mocks.toBlob.mockResolvedValue({
      type: 'image/png',
      size: bytes.byteLength,
      arrayBuffer: async () => bytes,
    });
    mocks.bridge.mockReturnValue({ copyToClipboard });

    await copyShareImage(document.createElement('div'));
    expect(copyToClipboard).toHaveBeenCalledWith({ pngBytes: bytes });

    mocks.bridge.mockReturnValue({
      copyToClipboard: async () => ({ copied: false, error: 'Clipboard busy' }),
    });
    await expect(copyShareImage(document.createElement('div'))).rejects.toThrow(
      'Clipboard busy'
    );
  });

  it('writes the captured PNG with the browser clipboard when no native bridge exists', async () => {
    const write = vi.fn(async () => undefined);
    class TestClipboardItem {
      constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    vi.stubGlobal('ClipboardItem', TestClipboardItem);

    await copyShareImage(document.createElement('div'));

    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0]![0]![0] as TestClipboardItem;
    await expect(item.items['image/png']).resolves.toBeInstanceOf(Blob);
  });

  it('starts the browser clipboard write before the image capture resolves', async () => {
    let releaseFonts: (() => void) | undefined;
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: new Promise<void>((resolve) => {
          releaseFonts = resolve;
        }),
      },
    });
    const write = vi.fn(async () => undefined);
    class TestClipboardItem {
      constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    vi.stubGlobal('ClipboardItem', TestClipboardItem);

    const copy = copyShareImage(document.createElement('div'));

    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0]![0]![0] as TestClipboardItem;
    const png = item.items['image/png'];
    expect(png).toBeInstanceOf(Promise);

    releaseFonts?.();
    await Promise.all([copy, png]);
  });

  it('rejects empty or non-PNG captures before saving', async () => {
    for (const blob of [
      new Blob([], { type: 'image/png' }),
      new Blob(['svg'], { type: 'image/svg+xml' }),
    ]) {
      mocks.toBlob.mockResolvedValue(blob);
      await expect(exportShareImage(document.createElement('div'), undefined, 'lody-conversation')).rejects.toThrow(
        'PNG encoding failed'
      );
    }
  });
});
