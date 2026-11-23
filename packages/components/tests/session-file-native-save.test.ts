import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nativeShareState as state, Share } from './stubs/native-share';
import { runTouchImagePreviewAction } from '../src/lib/image-preview-export';
import { saveBytesAsFile } from '../src/lib/download-file';
import { shareFileBytesNatively } from '../src/lib/session-file-native-save';

const platform = vi.hoisted(() => ({ native: true }));
vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: () => platform.native }));

vi.mock('../src/lib/session-file-upload', () => ({
  buildSessionFileDownloadUrl: () => {
    throw new Error('Snapshot export must not download an attachment');
  },
}));

vi.mock('@capacitor/filesystem');
vi.mock('@capacitor/share');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  platform.native = true;
  state.files.clear();
  state.received = [];
  state.failure = null;
  state.failWrite = false;
  state.failUri = false;
});

it.each([0, 7, 3 * 1024 * 1024 + 5])(
  'shares all %i bytes with a safe extension and cleans up',
  async (size) => {
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256);
    await expect(shareFileBytesNatively('../package.deb', bytes)).resolves.toEqual({
      shared: true,
    });
    // Compare every byte without generic deep equality enumerating millions of keys.
    expect(state.received[0].bytes.equals(Buffer.from(bytes))).toBe(true);
    expect(state.received[0].name.split('/')).toHaveLength(3);
    expect(state.received[0].name).toMatch(/package\.deb$/);
    expect(state.files.size).toBe(0);
  }
);

it('isolates concurrent exports of the same filename', async () => {
  await Promise.all([
    shareFileBytesNatively('package.deb', Uint8Array.of(1)),
    shareFileBytesNatively('package.deb', Uint8Array.of(2)),
  ]);
  expect(new Set(state.received.map((file) => file.name)).size).toBe(2);
  expect(state.received.map((file) => [...file.bytes])).toEqual([[1], [2]]);
  expect(state.files.size).toBe(0);
});

it.each(['cancel', 'write', 'uri', 'share'])(
  'cleans only its own decrypted staging file on %s, never an existing user file',
  async (step) => {
    const original = Buffer.from('existing-user-file');
    state.files.set('user-target/notes.md', original);
    state.failWrite = step === 'write';
    state.failUri = step === 'uri';
    state.failure = step === 'cancel' ? 'Share canceled' : step === 'share' ? 'Share failed' : null;
    const copy = shareFileBytesNatively('../notes.md', new TextEncoder().encode('approved-copy'));
    if (step === 'cancel') await expect(copy).resolves.toEqual({ shared: false });
    else await expect(copy).rejects.toThrow();
    expect([...state.files]).toEqual([['user-target/notes.md', original]]);
    expect(state.received).toEqual([]);
  }
);

it.each(['save', 'share'] as const)(
  'image %s hands off original bytes, never claims an album save',
  async (action) => {
    const image = new File([Uint8Array.of(255, 216, 255, 1)], 'photo.jpeg', { type: 'image/jpeg' });
    expect(await runTouchImagePreviewAction(action, 'blob:photo', image)).toEqual({
      kind: 'shared',
    });
    expect(state.received[0].name).toMatch(/photo\.jpeg$/);
    expect([...state.received[0].bytes]).toEqual([255, 216, 255, 1]);
    expect(state.files.size).toBe(0);
    state.failure = 'Share canceled';
    expect(await runTouchImagePreviewAction(action, 'blob:photo', image)).toEqual({
      kind: 'dismissed',
    });
    expect(state.files.size).toBe(0);
  }
);

it('saves generated native bytes and reports share dismissal without a browser fallback', async () => {
  const bytes = Uint8Array.of(7, 8, 9);
  await expect(saveBytesAsFile('/workspace/diagram.svg', bytes)).resolves.toEqual({ saved: true });
  expect([...state.received[0].bytes]).toEqual([...bytes]);
  expect(state.received[0].name).toMatch(/diagram\.svg$/);
  state.failure = 'Share canceled';
  await expect(saveBytesAsFile('diagram.svg', bytes)).resolves.toEqual({ saved: false });
  expect(state.received).toHaveLength(1);
  expect(state.files.size).toBe(0);
});

it('propagates native save failure and cleans staging bytes', async () => {
  const failure = new Error('Share failed');
  vi.spyOn(Share, 'share').mockRejectedValueOnce(failure);
  await expect(saveBytesAsFile('diagram.png', Uint8Array.of(1))).rejects.toBe(failure);
  expect(state.files.size).toBe(0);
  expect(state.received).toEqual([]);
});

it('saves browser bytes with the basename through a download link', async () => {
  platform.native = false;
  vi.useFakeTimers();
  let blob: Blob | undefined;
  let downloaded: { name: string; href: string } | undefined;
  const anchor = {
    href: '',
    download: '',
    rel: '',
    click() {
      downloaded = { name: this.download, href: this.href };
    },
    remove() {},
  };
  vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild() {} } });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    blob = value as Blob;
    return 'blob:generated-download';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await expect(saveBytesAsFile('/workspace/diagram.mmd', Uint8Array.of(4, 5))).resolves.toEqual({
    saved: true,
  });
  expect(downloaded).toEqual({ name: 'diagram.mmd', href: 'blob:generated-download' });
  expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([4, 5]);
  expect(state.received).toEqual([]);
  vi.runAllTimers();
});
