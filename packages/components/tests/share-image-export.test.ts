// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyShareImage, exportShareImage } from '../src/lib/share-image-export';

const mocks = vi.hoisted(() => ({
  toBlob: vi.fn(),
  bridge: vi.fn(),
  native: vi.fn(),
  files: new Map<string, Uint8Array>(),
  shared: [] as { path: string; bytes: Uint8Array }[],
  shareError: null as string | null,
}));
vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: mocks.native }));
vi.mock('../src/lib/session-file-upload', () => ({
  buildSessionFileDownloadUrl: () => {
    throw new Error('PNG export must stay local');
  },
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    async writeFile({ path, data }: { path: string; data: string }) {
      mocks.files.set(
        path,
        Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0))
      );
    },
    async appendFile({ path, data }: { path: string; data: string }) {
      mocks.files.set(
        path,
        Uint8Array.from([
          ...mocks.files.get(path)!,
          ...Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0)),
        ])
      );
    },
    async getUri({ path }: { path: string }) {
      return { uri: `file://${path}` };
    },
    async deleteFile({ path }: { path: string }) {
      mocks.files.delete(path);
    },
  },
}));
vi.mock('@capacitor/share', () => ({
  Share: {
    async share({ files }: { files: string[] }) {
      const path = files[0].slice('file://'.length);
      const bytes = mocks.files.get(path);
      if (!bytes) throw new Error('Missing PNG');
      if (mocks.shareError) throw new Error(mocks.shareError);
      mocks.shared.push({ path, bytes });
    },
  },
}));
vi.mock('@zumer/snapdom', () => ({ snapdom: { toBlob: mocks.toBlob } }));
vi.mock('../src/lib/image-preview-export', () => ({ getImagePreviewExportBridge: mocks.bridge }));
// Route the lazy product module through Vitest so its native plugin imports
// use this file's I/O boundary rather than Node's external module cache.
vi.mock('../src/lib/session-file-native-save', async (importOriginal) =>
  importOriginal<typeof import('../src/lib/session-file-native-save')>()
);

// Load the real native handoff and its mocked I/O before fake timers freeze
// the browser scheduler or a test starts measuring its behavior.
beforeAll(async () => {
  await Promise.all([
    import('../src/lib/session-file-native-save'),
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
}, 0);

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.native.mockReturnValue(false);
  mocks.files.clear();
  mocks.shared = [];
  mocks.shareError = null;
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
  it.each(['download', 'native', 'desktop-save', 'desktop-copy', 'web-copy'] as const)(
    'rechecks scope synchronously at the final %s handoff',
    async (destination) => {
      const received: unknown[] = [];
      mocks.native.mockReturnValue(destination === 'native');
      mocks.toBlob.mockResolvedValue({
        type: 'image/png',
        size: 4,
        arrayBuffer: async () => Uint8Array.of(137, 80, 78, 71).buffer,
      } as Blob);
      if (destination.startsWith('desktop'))
        mocks.bridge.mockReturnValue({
          saveAs: async (value: unknown) => {
            received.push(value);
            return { saved: true };
          },
          copyToClipboard: async (value: unknown) => {
            received.push(value);
            return { copied: true };
          },
        });
      class TestClipboardItem {
        constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
      }
      vi.stubGlobal('ClipboardItem', TestClipboardItem);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: async (items: TestClipboardItem[]) => {
            received.push(await items[0]!.items['image/png']!);
          },
        },
      });
      vi.stubGlobal(
        'URL',
        class extends URL {
          static createObjectURL(blob: Blob) {
            received.push(blob);
            return 'blob:copy';
          }
          static revokeObjectURL() {}
        }
      );
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      let current = true;
      let admitted = false;
      const guard = () => {
        if (!current) throw new DOMException('Copy source changed', 'AbortError');
      };
      const admitOutput = async () => {
        admitted = true;
        await Promise.resolve();
        current = false;
      };
      const element = document.createElement('div');
      const output = destination.endsWith('copy')
        ? copyShareImage(element, guard, admitOutput)
        : exportShareImage(element, 'Selected', 'conversation', guard, admitOutput);
      await expect(output).rejects.toThrow('Copy source changed');
      expect(admitted).toBe(true);
      expect(received).toEqual([]);
      expect(mocks.shared).toEqual([]);
      expect([...mocks.files]).toEqual([]);
    }
  );

  it.each([false, true])(
    'rejects a late capture after its source changes (native: %s)',
    async (native) => {
      mocks.native.mockReturnValue(native);
      const started = Promise.withResolvers<void>();
      const captured = Promise.withResolvers<Blob>();
      mocks.toBlob.mockImplementation(() => {
        started.resolve();
        return captured.promise;
      });
      const downloads: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
        downloads.push(this.download);
      });
      vi.stubGlobal('URL', {
        createObjectURL: () => 'blob:late-copy',
        revokeObjectURL: () => {},
      });
      let current = true;
      const pending = exportShareImage(
        document.createElement('div'),
        'Source A',
        'conversation',
        () => {
          if (!current) throw new DOMException('Copy scope changed', 'AbortError');
        }
      );
      await started.promise;
      current = false;
      captured.resolve(new Blob(['approved-source-sentinel'], { type: 'image/png' }));
      await expect(pending).rejects.toThrow('Copy scope changed');
      expect(downloads).toEqual([]);
      expect(mocks.shared).toEqual([]);
      expect([...mocks.files]).toEqual([]);
    }
  );

  it('never hands a late image capture to the desktop clipboard', async () => {
    const started = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<Blob>();
    mocks.toBlob.mockImplementation(() => {
      started.resolve();
      return captured.promise;
    });
    const clipboard: unknown[] = [];
    mocks.bridge.mockReturnValue({
      copyToClipboard: async (copy: unknown) => {
        clipboard.push(copy);
        return { copied: true };
      },
    });
    let current = true;
    const pending = copyShareImage(document.createElement('div'), () => {
      if (!current) throw new DOMException('Copy scope changed', 'AbortError');
    });
    await started.promise;
    current = false;
    captured.resolve({
      type: 'image/png',
      size: 4,
      arrayBuffer: async () => new ArrayBuffer(4),
    } as Blob);
    await expect(pending).rejects.toThrow('Copy scope changed');
    expect(clipboard).toEqual([]);
  });

  it('rejects the pending WebKit clipboard item when its capture scope retires', async () => {
    const started = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<Blob>();
    mocks.toBlob.mockImplementation(() => {
      started.resolve();
      return captured.promise;
    });
    class TestClipboardItem {
      constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
    }
    const received: Blob[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items: TestClipboardItem[]) => {
          received.push(await items[0]!.items['image/png']!);
        },
      },
    });
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    let current = true;
    const pending = copyShareImage(document.createElement('div'), () => {
      if (!current) throw new DOMException('Copy scope changed', 'AbortError');
    });
    await started.promise;
    current = false;
    captured.resolve(new Blob(['retired-source'], { type: 'image/png' }));
    await expect(pending).rejects.toThrow('Copy scope changed');
    expect(received).toEqual([]);
  });

  it.each([null, 'Share canceled', 'Permission denied'])(
    'exports a native PNG through the share sheet and preserves its outcome (%s)',
    async (error) => {
      mocks.native.mockReturnValue(true);
      mocks.shareError = error;
      const bytes = Uint8Array.of(137, 80, 78, 71);
      mocks.toBlob.mockResolvedValue({
        type: 'image/png',
        size: bytes.length,
        arrayBuffer: async () => bytes.buffer,
      });
      const downloads: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
        downloads.push(this.href);
      });
      const exported = exportShareImage(
        document.createElement('div'),
        'Review / rendering',
        'conversation'
      );
      if (error === 'Permission denied') {
        await expect(exported).rejects.toThrow(error);
      } else {
        await expect(exported).resolves.toEqual({ saved: error === null });
      }
      expect(downloads).toEqual([]);
      expect(mocks.files.size).toBe(0);
      if (error === null) {
        expect(mocks.shared).toEqual([
          { path: expect.stringMatching(/^lody-shared\/[^/]+\/Review - rendering\.png$/), bytes },
        ]);
      } else {
        expect(mocks.shared).toEqual([]);
      }
    }
  );

  it('reports a cancelled native save as no save, so callers can leave the preview open', async () => {
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
    const result = await exportShareImage(
      document.createElement('div'),
      undefined,
      'lody-conversation'
    );
    expect(saved).toEqual({ fileName: 'lody-conversation.png', bytes });
    // Not a failure — nothing is thrown — but not a save either. A caller that
    // read this as success would close the surface under someone who was only
    // backing out of the file picker.
    expect(result).toEqual({ saved: false });
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
});
