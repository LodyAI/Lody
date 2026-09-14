import { beforeEach, expect, it, vi } from 'vitest';
import { shareFileBytesNatively } from '../src/lib/session-file-native-save';

vi.mock('../src/lib/session-file-upload', () => ({
  buildSessionFileDownloadUrl: () => {
    throw new Error('Snapshot export must not download an attachment');
  },
}));

const state = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  received: [] as { name: string; bytes: Buffer }[],
  failure: null as string | null,
  failWrite: false,
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    async writeFile({ path, data }: { path: string; data: string }) {
      state.files.set(path, Buffer.from(data, 'base64'));
      if (state.failWrite) throw new Error('Disk full');
    },
    async appendFile({ path, data }: { path: string; data: string }) {
      state.files.set(path, Buffer.concat([state.files.get(path)!, Buffer.from(data, 'base64')]));
    },
    async getUri({ path }: { path: string }) {
      return { uri: `file://${path}` };
    },
    async deleteFile({ path }: { path: string }) {
      state.files.delete(path);
    },
  },
}));

vi.mock('@capacitor/share', () => ({
  Share: {
    async share({ files }: { files: string[] }) {
      const path = files[0].slice('file://'.length);
      const bytes = state.files.get(path);
      if (!bytes) throw new Error('Missing staged file');
      if (state.failure) throw new Error(state.failure);
      state.received.push({ name: path, bytes });
    },
  },
}));

beforeEach(() => {
  state.files.clear();
  state.received = [];
  state.failure = null;
  state.failWrite = false;
});

it.each([0, 7, 3 * 1024 * 1024 + 5])(
  'shares all %i bytes with a safe extension and cleans up',
  async (size) => {
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256);
    await shareFileBytesNatively('../package.deb', bytes);
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

it('treats cancellation as dismissal and cleans up', async () => {
  state.failure = 'Share canceled';
  await expect(shareFileBytesNatively('package.deb', Uint8Array.of(1))).resolves.toBeUndefined();
  expect(state.files.size).toBe(0);
});

it.each(['write', 'share'])('cleans up and reports a %s failure', async (step) => {
  state.failWrite = step === 'write';
  state.failure = step === 'share' ? 'Share failed' : null;
  await expect(shareFileBytesNatively('package.deb', Uint8Array.of(1))).rejects.toThrow();
  expect(state.files.size).toBe(0);
  expect(state.received).toEqual([]);
});
