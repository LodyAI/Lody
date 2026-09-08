// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportChatShareImage } from '../src/lib/chat-share-image-export';

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

describe('chat share image export', () => {
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
    await exportChatShareImage(document.createElement('div'), 'Review / rendering');
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
    await exportChatShareImage(document.createElement('div'));
    expect(saved).toEqual({ fileName: 'lody-conversation.png', bytes });
  });

  it('propagates native save failure so the dialog can offer retry', async () => {
    mocks.toBlob.mockResolvedValue({
      type: 'image/png',
      size: 1,
      arrayBuffer: async () => new ArrayBuffer(1),
    });
    mocks.bridge.mockReturnValue({ saveAs: async () => ({ saved: false, error: 'Disk full' }) });
    await expect(exportChatShareImage(document.createElement('div'))).rejects.toThrow('Disk full');
  });

  it('rejects empty or non-PNG captures before saving', async () => {
    for (const blob of [
      new Blob([], { type: 'image/png' }),
      new Blob(['svg'], { type: 'image/svg+xml' }),
    ]) {
      mocks.toBlob.mockResolvedValue(blob);
      await expect(exportChatShareImage(document.createElement('div'))).rejects.toThrow(
        'PNG encoding failed'
      );
    }
  });
});
