import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  share: vi.fn(),
  readdir: vi.fn(),
  platform: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: native.platform } }));
vi.mock('@capacitor/filesystem', () => ({ Directory: { Cache: 'CACHE' }, Filesystem: native }));
vi.mock('@capacitor/share', () => ({ Share: native }));
import { exportMobileRecoveryFile } from '../../src/recovery/recovery-file';
beforeEach(() => native.platform.mockReturnValue('ios'));
afterEach(() => vi.resetAllMocks());

it.each(['saved', 'cancelled', 'failed'] as const)(
  'recovery export retains its temporary until native sharing settles, then removes it when %s',
  async (outcome) => {
    const bytes = new Uint8Array([0, 255, 19, 128]);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    native.writeFile.mockResolvedValue({ uri: 'file:///synthetic/recovery.lodyrecovery' });
    native.share.mockImplementation(() => {
      started();
      return new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
    });
    native.deleteFile.mockResolvedValue(undefined);
    const exported = exportMobileRecoveryFile(bytes, () => {});
    await entered;
    expect(native.writeFile).toHaveBeenCalledWith({
      path: expect.stringMatching(/^lody-recovery-.*\.lodyrecovery$/),
      directory: 'CACHE',
      data: Buffer.from(bytes).toString('base64'),
    });
    expect(native.share).toHaveBeenCalledWith({
      files: ['file:///synthetic/recovery.lodyrecovery'],
    });
    expect(native.deleteFile).not.toHaveBeenCalled();
    if (outcome === 'saved') resolve();
    else reject(new Error(outcome === 'cancelled' ? 'Share canceled' : 'synthetic native detail'));
    if (outcome === 'failed') await expect(exported).rejects.toThrow('e2ee_recovery_storage');
    else expect(await exported).toBe(outcome === 'saved');
    expect(native.deleteFile).toHaveBeenCalledWith({
      path: native.writeFile.mock.calls[0]![0].path,
      directory: 'CACHE',
    });
  }
);

it('a retired login cannot publish a written recovery file through the share sheet', async () => {
  let live = true;
  native.writeFile.mockImplementation(async () => {
    live = false;
    return { uri: 'file:///synthetic' };
  });
  native.deleteFile.mockResolvedValue(undefined);
  await expect(
    exportMobileRecoveryFile(new Uint8Array([1]), () => {
      if (!live) throw new Error('e2ee_recovery_cancelled');
    })
  ).rejects.toThrow('e2ee_recovery_cancelled');
  expect(native.share).not.toHaveBeenCalled();
  expect(native.deleteFile).toHaveBeenCalledOnce();
});

it('an export cannot report success when its secret temporary could not be removed', async () => {
  native.writeFile.mockResolvedValue({ uri: 'file:///synthetic' });
  native.share.mockResolvedValue({ activityType: 'synthetic' });
  native.deleteFile.mockRejectedValue(new Error('synthetic native detail'));
  await expect(exportMobileRecoveryFile(new Uint8Array([1]), () => {})).rejects.toThrow(
    'e2ee_recovery_storage'
  );
});

it('Android keeps shared bytes readable after chooser completion and cleans only older recovery files on next export', async () => {
  native.platform.mockReturnValue('android');
  const old = 'lody-recovery-11111111-1111-4111-8111-111111111111.lodyrecovery';
  const files = new Map([
    [old, 'previous export'],
    ['unrelated.txt', 'keep'],
  ]);
  native.readdir.mockImplementation(async () => ({
    files: [...files.keys()].map((name) => ({ name, type: 'file' })),
  }));
  native.writeFile.mockImplementation(async ({ path, data }) => {
    files.set(path, data);
    return { uri: `file:///cache/${path}` };
  });
  native.deleteFile.mockImplementation(async ({ path }) => {
    files.delete(path);
  });
  native.share.mockResolvedValue({});
  const bytes = new Uint8Array([1, 2, 255]);
  expect(await exportMobileRecoveryFile(bytes, () => {})).toBe(true);
  const shared = native.writeFile.mock.calls[0]![0].path;
  expect(Buffer.from(files.get(shared)!, 'base64')).toEqual(Buffer.from(bytes));
  expect(files.has(old)).toBe(false);
  expect(await exportMobileRecoveryFile(new Uint8Array([42]), () => {})).toBe(true);
  expect(files.has(shared)).toBe(false);
  const next = native.writeFile.mock.calls[1]![0].path;
  expect(Buffer.from(files.get(next)!, 'base64')).toEqual(Buffer.from([42]));
  expect(files.get('unrelated.txt')).toBe('keep');
});
