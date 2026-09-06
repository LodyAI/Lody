import { mkdtemp, mkdir, rm, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupBackfilledSessionFileBlobs,
  copyIntoSessionFileBlobStore,
  getDraftSessionFileBlobMaxAgeMs,
  getSessionFileBlobAgeMs,
  getSessionFileBlobDir,
  getSessionFileBlobPath,
  getSessionFileBlobStoreUsage,
  listPendingLocalSessionFiles,
  markSessionFileBlobBackfilled,
  readSessionFileBlobBackfillMarker,
  removeSessionFileBlob,
  sessionFileBlobExists,
  writeSessionFileBlobBackfillMarker,
} from './session-file-blob-store';

describe('session file blob store', () => {
  let homeDir: string;
  let sourceDir: string;
  let originalQuota: string | undefined;
  let originalRetainDays: string | undefined;
  let originalPlatform: string | undefined;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    originalQuota = process.env.LODY_SESSION_FILE_BLOB_QUOTA_BYTES;
    originalRetainDays = process.env.LODY_SESSION_FILE_BLOB_RETAIN_DAYS;
    originalPlatform = process.env.LODY_PLATFORM;
    originalDataDir = process.env.LODY_DATA_DIR;
    process.env.LODY_PLATFORM = 'local';
    delete process.env.LODY_DATA_DIR;
    delete process.env.LODY_SESSION_FILE_BLOB_QUOTA_BYTES;
    delete process.env.LODY_SESSION_FILE_BLOB_RETAIN_DAYS;
    homeDir = await mkdtemp(join(tmpdir(), 'lody-blob-home-'));
    sourceDir = await mkdtemp(join(tmpdir(), 'lody-blob-src-'));
  });

  afterEach(async () => {
    if (originalQuota === undefined) {
      delete process.env.LODY_SESSION_FILE_BLOB_QUOTA_BYTES;
    } else {
      process.env.LODY_SESSION_FILE_BLOB_QUOTA_BYTES = originalQuota;
    }
    if (originalRetainDays === undefined) {
      delete process.env.LODY_SESSION_FILE_BLOB_RETAIN_DAYS;
    } else {
      process.env.LODY_SESSION_FILE_BLOB_RETAIN_DAYS = originalRetainDays;
    }
    if (originalPlatform === undefined) delete process.env.LODY_PLATFORM;
    else process.env.LODY_PLATFORM = originalPlatform;
    if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = originalDataDir;
    await rm(homeDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  const makeSource = async (name: string, content: string): Promise<string> => {
    const p = join(sourceDir, name);
    await writeFile(p, content);
    return p;
  };

  it('lays out blobs under the local installation data directory', () => {
    const dir = getSessionFileBlobDir({ workspaceId: 'ws', sessionId: 'sess', homeDir });
    expect(dir).toBe(join(homeDir, '.lody-oss', 'session-files', 'ws', 'sess'));
    const file = getSessionFileBlobPath({
      workspaceId: 'ws',
      sessionId: 'sess',
      fileId: 'file-1',
      homeDir,
    });
    expect(file).toBe(join(dir, 'file-1'));
  });

  it('rejects path-traversal identifiers', () => {
    expect(() =>
      getSessionFileBlobPath({ workspaceId: 'ws', sessionId: 'sess', fileId: '../escape', homeDir })
    ).toThrow();
    expect(() =>
      getSessionFileBlobDir({ workspaceId: '..', sessionId: 'sess', homeDir })
    ).toThrow();
  });

  it('copies bytes into the store and is idempotent on re-copy', async () => {
    const source = await makeSource('a.txt', 'hello');
    const args = {
      workspaceId: 'ws',
      sessionId: 'sess',
      fileId: 'file-1',
      sourcePath: source,
      homeDir,
    };

    const { destPath: dest, warn } = await copyIntoSessionFileBlobStore(args);
    expect(warn).toBe(false);
    expect(await readFile(dest, 'utf8')).toBe('hello');
    // POSIX modes do not establish or verify Windows ACLs.
    if (process.platform !== 'win32') {
      expect((await stat(getSessionFileBlobDir(args))).mode & 0o777).toBe(0o700);
      expect((await stat(dest)).mode & 0o777).toBe(0o600);
    }
    expect(
      await sessionFileBlobExists({
        workspaceId: 'ws',
        sessionId: 'sess',
        fileId: 'file-1',
        homeDir,
      })
    ).toBe(true);

    // Re-copy with different content overwrites (same fileId).
    const source2 = await makeSource('a2.txt', 'world!');
    await copyIntoSessionFileBlobStore({ ...args, sourcePath: source2 });
    expect(await readFile(dest, 'utf8')).toBe('world!');
  });

  it('removes blobs idempotently', async () => {
    const source = await makeSource('a.txt', 'hello');
    await copyIntoSessionFileBlobStore({
      workspaceId: 'ws',
      sessionId: 'sess',
      fileId: 'file-1',
      sourcePath: source,
      homeDir,
    });
    await removeSessionFileBlob({
      workspaceId: 'ws',
      sessionId: 'sess',
      fileId: 'file-1',
      homeDir,
    });
    expect(
      await sessionFileBlobExists({
        workspaceId: 'ws',
        sessionId: 'sess',
        fileId: 'file-1',
        homeDir,
      })
    ).toBe(false);
    // Second removal does not throw.
    await expect(
      removeSessionFileBlob({ workspaceId: 'ws', sessionId: 'sess', fileId: 'file-1', homeDir })
    ).resolves.toBeUndefined();
  });

  it('lists pending blobs across sessions and skips .part temp files', async () => {
    const s1 = await makeSource('one', '1');
    const s2 = await makeSource('two', '2');
    await copyIntoSessionFileBlobStore({
      workspaceId: 'ws',
      sessionId: 'sA',
      fileId: 'f1',
      sourcePath: s1,
      homeDir,
    });
    await copyIntoSessionFileBlobStore({
      workspaceId: 'ws',
      sessionId: 'sB',
      fileId: 'f2',
      sourcePath: s2,
      homeDir,
    });
    // Stray temp file from an interrupted copy must be ignored.
    await writeFile(
      join(getSessionFileBlobDir({ workspaceId: 'ws', sessionId: 'sA', homeDir }), 'f3.part'),
      'x'
    );

    const pending = await listPendingLocalSessionFiles({ workspaceId: 'ws', homeDir });
    expect(pending).toEqual(
      expect.arrayContaining([
        { sessionId: 'sA', fileId: 'f1' },
        { sessionId: 'sB', fileId: 'f2' },
      ])
    );
    expect(pending).toHaveLength(2);
  });

  it('round-trips the backfill marker and keeps it out of the pending scan (R5.3)', async () => {
    const source = await makeSource('a.txt', 'hello');
    const args = { workspaceId: 'ws', sessionId: 'sess', fileId: 'file-1', homeDir };
    await copyIntoSessionFileBlobStore({ ...args, sourcePath: source });

    expect(await readSessionFileBlobBackfillMarker(args)).toBeNull();
    await writeSessionFileBlobBackfillMarker({ ...args, relayFileId: 'relay-1' });
    expect(await readSessionFileBlobBackfillMarker(args)).toBe('relay-1');

    // The `.r2meta` sidecar must not surface as a pending blob.
    const pending = await listPendingLocalSessionFiles({ workspaceId: 'ws', homeDir });
    expect(pending).toEqual([{ sessionId: 'sess', fileId: 'file-1' }]);

    // Finalizing the backfill clears the marker.
    await markSessionFileBlobBackfilled(args);
    expect(await readSessionFileBlobBackfillMarker(args)).toBeNull();
  });

  it('removeSessionFileBlob also clears the backfill marker', async () => {
    const source = await makeSource('a.txt', 'hello');
    const args = { workspaceId: 'ws', sessionId: 'sess', fileId: 'file-1', homeDir };
    await copyIntoSessionFileBlobStore({ ...args, sourcePath: source });
    await writeSessionFileBlobBackfillMarker({ ...args, relayFileId: 'relay-1' });

    await removeSessionFileBlob(args);
    expect(await readSessionFileBlobBackfillMarker(args)).toBeNull();
    expect(await sessionFileBlobExists(args)).toBe(false);
  });

  it('reports blob age for draft reclamation (R5.4)', async () => {
    const source = await makeSource('a.txt', 'hello');
    const args = { workspaceId: 'ws', sessionId: 'sess', fileId: 'file-1', homeDir };
    await copyIntoSessionFileBlobStore({ ...args, sourcePath: source });

    expect(await getSessionFileBlobAgeMs(args)).toBeGreaterThanOrEqual(0);
    expect(
      await getSessionFileBlobAgeMs({
        workspaceId: 'ws',
        sessionId: 'sess',
        fileId: 'missing',
        homeDir,
      })
    ).toBeNull();

    // Backdate the blob well past the draft retention window.
    const old = new Date(Date.now() - getDraftSessionFileBlobMaxAgeMs() - 60_000);
    await utimes(getSessionFileBlobPath(args), old, old);
    expect(await getSessionFileBlobAgeMs(args)).toBeGreaterThan(getDraftSessionFileBlobMaxAgeMs());
  });

  it('rejects new writes when the local blob quota is full', async () => {
    process.env.LODY_SESSION_FILE_BLOB_QUOTA_BYTES = '4';
    const source = await makeSource('too-big', 'hello');
    await expect(
      copyIntoSessionFileBlobStore({
        workspaceId: 'ws',
        sessionId: 'sess',
        fileId: 'file-1',
        sourcePath: source,
        homeDir,
      })
    ).rejects.toMatchObject({ code: 'session_file_blob_quota_exceeded' });
  });

  it('purges backfilled blobs before rejecting a quota-pressured write', async () => {
    process.env.LODY_SESSION_FILE_BLOB_QUOTA_BYTES = '6';
    const first = await makeSource('first', 'hello');
    await copyIntoSessionFileBlobStore({
      workspaceId: 'ws',
      sessionId: 'sess',
      fileId: 'file-1',
      sourcePath: first,
      homeDir,
    });
    await markSessionFileBlobBackfilled({
      workspaceId: 'ws',
      sessionId: 'sess',
      fileId: 'file-1',
      homeDir,
    });

    // 5 backfilled bytes + 5 new bytes > 6-byte quota, but the backfilled blob
    // is already in R2 and must be reclaimed instead of rejecting the write.
    const second = await makeSource('second', 'world');
    const copied = await copyIntoSessionFileBlobStore({
      workspaceId: 'ws',
      sessionId: 'sess',
      fileId: 'file-2',
      sourcePath: second,
      homeDir,
    });
    expect(await readFile(copied.destPath, 'utf8')).toBe('world');
    expect((await getSessionFileBlobStoreUsage({ homeDir })).usedBytes).toBe(5);
  });

  it('moves backfilled blobs out of the pending scan and cleans them after retention', async () => {
    const source = await makeSource('a.txt', 'hello');
    await copyIntoSessionFileBlobStore({
      workspaceId: 'ws',
      sessionId: 'sess',
      fileId: 'file-1',
      sourcePath: source,
      homeDir,
    });

    await markSessionFileBlobBackfilled({
      workspaceId: 'ws',
      sessionId: 'sess',
      fileId: 'file-1',
      homeDir,
    });

    expect(await listPendingLocalSessionFiles({ workspaceId: 'ws', homeDir })).toEqual([]);
    const usageBeforeCleanup = await getSessionFileBlobStoreUsage({ homeDir });
    expect(usageBeforeCleanup.usedBytes).toBe(5);

    // Make the retained copy older than the cleanup window.
    const old = new Date(1_000);
    const backfilledPath = join(
      homeDir,
      '.lody-oss',
      'session-files',
      '_backfilled',
      'ws',
      'sess',
      'file-1'
    );
    await utimes(backfilledPath, old, old);
    await expect(
      cleanupBackfilledSessionFileBlobs({ homeDir, now: 10_000, retainMs: 1_000 })
    ).resolves.toBe(1);
    expect((await getSessionFileBlobStoreUsage({ homeDir })).usedBytes).toBe(0);
  });

  it('returns no pending blobs for an empty/absent workspace', async () => {
    await mkdir(join(homeDir, '.lody-oss'), { recursive: true });
    expect(await listPendingLocalSessionFiles({ workspaceId: 'ws', homeDir })).toEqual([]);
  });
});
