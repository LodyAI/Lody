import { mkdtemp, rm, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupBackfilledSessionFileBlobs,
  copyIntoSessionFileBlobStore,
  getSessionFileBlobDir,
  getSessionFileBlobPath,
  getSessionFileBlobStoreUsage,
  listPendingLocalSessionFiles,
  markSessionFileBlobBackfilled,
  readSessionFileBlobBackfillReceipt,
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

  it('rejects path-traversal identifiers', () => {
    expect(() =>
      getSessionFileBlobPath({ workspaceId: 'ws', sessionId: 'sess', fileId: '../escape', homeDir })
    ).toThrow();
    expect(() =>
      getSessionFileBlobDir({ workspaceId: '..', sessionId: 'sess', homeDir })
    ).toThrow();
  });

  it('stores attachment bytes with private file and directory permissions', async () => {
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
    expect((await stat(getSessionFileBlobDir(args))).mode & 0o777).toBe(0o700);
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
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

  it('retains the exact encrypted backfill receipt for restart adoption', async () => {
    const source = await makeSource('private.txt', 'hello');
    const args = { workspaceId: 'ws', sessionId: 'sess', fileId: 'encrypted-local', homeDir };
    const encryption = {
      v: 1 as const,
      key: '12'.repeat(32),
      resourceId: '34'.repeat(16),
      kind: 'file' as const,
      sizeBytes: 5,
      fileName: 'private.txt',
      mimeType: 'text/plain',
      parts: ['relay-1'],
    };
    await copyIntoSessionFileBlobStore({ ...args, sourcePath: source });
    await writeSessionFileBlobBackfillMarker({ ...args, relayFileId: 'relay-1', encryption });
    expect(await readSessionFileBlobBackfillReceipt(args)).toEqual({
      relayFileId: 'relay-1',
      encryption,
    });
    expect(await sessionFileBlobExists(args)).toBe(true);
    await markSessionFileBlobBackfilled(args);
    expect(await readSessionFileBlobBackfillReceipt(args)).toBeNull();
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
});
