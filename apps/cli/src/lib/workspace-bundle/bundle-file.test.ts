import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleFormatError, createBundleWriter, openBundle } from './bundle-file';

const source = {
  workspaceId: 'ws_source',
  exporterUserId: 'user-a',
  exporterMachineId: 'machine-a',
  lodyVersion: '0.0.0-test',
  startedAt: '2026-11-19T00:00:00.000Z',
};

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-bundle-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeSample(file: string) {
  const writer = await createBundleWriter(file, { chunkSize: 4 });
  await writer.addRoom(
    { id: 'session-1', model: 'loro', codec: 'session-loro/v1', encoding: 'loro-snapshot/v1' },
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  );
  await writer.addRoom(
    {
      id: 'ws_source:wf:workspace',
      model: 'flock',
      codec: 'flock-room/v1',
      encoding: 'flock-file/v1',
    },
    new Uint8Array([42])
  );
  const blobSha = await writer.addBlob(
    { kind: 'image', name: 'a.png', mime: 'image/png' },
    new Uint8Array([7, 7, 7])
  );
  writer.addGap({ id: 'session-2', kind: 'roost', reason: 'unsupported' });
  const manifest = await writer.finish({ ...source, finishedAt: '2026-11-19T00:01:00.000Z' });
  return { manifest, blobSha };
}

describe('workspace bundle file', () => {
  it('round-trips chunked rooms, blobs and gaps', async () => {
    const file = path.join(dir, 'a.lodybundle');
    const { manifest, blobSha } = await writeSample(file);
    expect(manifest.rooms[0]?.chunks.length).toBe(3);

    const bundle = await openBundle(file);
    try {
      expect(bundle.manifest.digest).toBe(manifest.digest);
      expect(bundle.manifest.gaps).toEqual([
        { id: 'session-2', kind: 'roost', reason: 'unsupported' },
      ]);
      const [session, flock] = bundle.manifest.rooms;
      expect([...(await bundle.readRoom(session!))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect([...(await bundle.readRoom(flock!))]).toEqual([42]);
      expect([...(await bundle.readBlob(blobSha))]).toEqual([7, 7, 7]);
      await bundle.verifyAll();
    } finally {
      await bundle.close();
    }
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual(['a.lodybundle']);
  });

  it('rejects a modified chunk', async () => {
    const file = path.join(dir, 'a.lodybundle');
    await writeSample(file);
    const bytes = await fs.readFile(file);
    // The second chunk of session-1 holds 5,6,7,8; flip the 6.
    const at = bytes.indexOf(Buffer.from([5, 6, 7, 8]));
    expect(at).toBeGreaterThan(0);
    bytes[at + 1] = 99;
    await fs.writeFile(file, bytes);
    const bundle = await openBundle(file);
    try {
      await expect(bundle.readRoom(bundle.manifest.rooms[0]!)).rejects.toBeInstanceOf(
        BundleFormatError
      );
      await expect(bundle.verifyAll()).rejects.toBeInstanceOf(BundleFormatError);
    } finally {
      await bundle.close();
    }
  });

  it('rejects an unfinished bundle and leaves no destination file', async () => {
    const file = path.join(dir, 'a.lodybundle');
    const writer = await createBundleWriter(file);
    await writer.addRoom(
      { id: 'session-1', model: 'loro', codec: 'session-loro/v1', encoding: 'loro-snapshot/v1' },
      new Uint8Array([1])
    );
    await writer.abort();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('rejects a manifest with an edited field or a newer major version', async () => {
    const file = path.join(dir, 'a.lodybundle');
    await writeSample(file);
    const bytes = await fs.readFile(file);
    const tampered = Buffer.from(
      bytes.toString('latin1').replace('ws_source"', 'ws_sourcX"'),
      'latin1'
    );
    await fs.writeFile(file, tampered);
    await expect(openBundle(file)).rejects.toBeInstanceOf(BundleFormatError);

    await fs.rm(file);
    await writeSample(file);
    const newer = Buffer.from(
      (await fs.readFile(file)).toString('latin1').replace('"version":1', '"version":2'),
      'latin1'
    );
    await fs.writeFile(file, newer);
    await expect(openBundle(file)).rejects.toThrow(/version/);
  });

  it('refuses to overwrite an existing destination', async () => {
    const file = path.join(dir, 'a.lodybundle');
    await fs.writeFile(file, 'keep');
    await expect(createBundleWriter(file)).rejects.toThrow(/exists/);
    expect(await fs.readFile(file, 'utf8')).toBe('keep');
  });
});
