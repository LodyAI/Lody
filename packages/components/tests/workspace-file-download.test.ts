import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import type {
  FileWorkspaceOpenResult,
  FileWorkspaceProvider,
} from '../src/lib/file-workspace-provider';
import {
  buildFolderArchiveFileName,
  buildWorkspaceFolderArchive,
  readWorkspaceFileBytes,
} from '../src/lib/workspace-file-download';

type StubFile =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary'; readonly bytes: Uint8Array }
  | { readonly kind: 'unavailable'; readonly message: string };

function createProvider(files: Record<string, StubFile>): FileWorkspaceProvider {
  return {
    kind: 'code-collab',
    async openFile(path: string): Promise<FileWorkspaceOpenResult> {
      const file = files[path];
      if (!file || file.kind === 'unavailable') {
        return {
          status: 'unavailable',
          reason: 'transient-io',
          message: file?.message ?? 'missing',
        };
      }
      const entry = { path, kind: 'text' as const, sourceState: 'live-readonly' as const };
      return file.kind === 'text'
        ? { status: 'ready', entry, snapshot: { kind: 'text', text: file.text } }
        : { status: 'ready', entry, snapshot: { kind: 'binary', bytes: file.bytes } };
    },
  } as unknown as FileWorkspaceProvider;
}

describe('readWorkspaceFileBytes', () => {
  it('encodes text as UTF-8, keeping a BOM the machine left in the string', () => {
    const provider = createProvider({ 'a.txt': { kind: 'text', text: '﻿hi' } });
    return readWorkspaceFileBytes(provider, 'a.txt').then((result) => {
      expect(result.ok).toBe(true);
      expect(result.ok && Array.from(result.bytes)).toEqual([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    });
  });

  it('passes binary bytes through untouched', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const provider = createProvider({ 'a.png': { kind: 'binary', bytes } });
    const result = await readWorkspaceFileBytes(provider, 'a.png');
    expect(result.ok && result.bytes).toEqual(bytes);
  });

  // An empty file reads successfully with zero bytes — it is not an unavailable
  // one. The save bridge accepts that buffer; only the image export refuses it.
  it('reads an empty file as a successful zero-byte read', async () => {
    const provider = createProvider({ 'empty.txt': { kind: 'text', text: '' } });
    const result = await readWorkspaceFileBytes(provider, 'empty.txt');
    expect(result.ok).toBe(true);
    expect(result.ok && result.bytes.byteLength).toBe(0);
  });

  it('surfaces the machine message when the file is unavailable', async () => {
    const provider = createProvider({ 'a.txt': { kind: 'unavailable', message: 'too big' } });
    expect(await readWorkspaceFileBytes(provider, 'a.txt')).toEqual({
      ok: false,
      message: 'too big',
    });
  });
});

describe('buildWorkspaceFolderArchive', () => {
  it('packs every file under the folder, rooted at the folder itself', async () => {
    const provider = createProvider({
      'src/lib/a.ts': { kind: 'text', text: 'a' },
      'src/lib/b.ts': { kind: 'text', text: 'b' },
    });

    const archive = await buildWorkspaceFolderArchive({
      provider,
      folderPath: 'src/lib',
      filePaths: ['src/lib/a.ts', 'src/lib/b.ts'],
    });

    expect(archive.ok).toBe(true);
    if (!archive.ok) return;
    const unpacked = unzipSync(archive.bytes);
    expect(Object.keys(unpacked).sort()).toEqual(['lib/a.ts', 'lib/b.ts']);
    expect(strFromU8(unpacked['lib/a.ts']!)).toBe('a');
    expect(archive.fileCount).toBe(2);
    expect(archive.skippedPaths).toEqual([]);
  });

  // A short archive is indistinguishable from a complete one on disk, so the
  // unreadable paths have to come back to the caller.
  it('reports the files it could not read instead of dropping them silently', async () => {
    const provider = createProvider({
      'src/a.ts': { kind: 'text', text: 'a' },
      'src/big.bin': { kind: 'unavailable', message: 'over the preview limit' },
    });

    const archive = await buildWorkspaceFolderArchive({
      provider,
      folderPath: 'src',
      filePaths: ['src/a.ts', 'src/big.bin'],
    });

    expect(archive.ok).toBe(true);
    if (!archive.ok) return;
    expect(Object.keys(unzipSync(archive.bytes))).toEqual(['src/a.ts']);
    expect(archive.skippedPaths).toEqual(['src/big.bin']);
  });

  it('refuses once the read bytes pass the total budget', async () => {
    const provider = createProvider({
      'src/a.ts': { kind: 'text', text: 'x'.repeat(64) },
      'src/b.ts': { kind: 'text', text: 'y'.repeat(64) },
    });

    const archive = await buildWorkspaceFolderArchive({
      provider,
      folderPath: 'src',
      filePaths: ['src/a.ts', 'src/b.ts'],
      maxTotalBytes: 100,
    });

    expect(archive.ok).toBe(false);
    expect(!archive.ok && archive.reason).toBe('too-large');
  });

  // The read loop bounds the RAW bytes, which does not bound the ARCHIVE: every
  // entry adds a local header plus a central-directory record, and deflate grows
  // incompressible data (64 MiB of random bytes zips to ~64.01 MiB). The save
  // bridge takes the finished archive, so an archive that passed the raw check
  // could still be rejected there as a malformed payload — after paying for
  // every remote read. Four 1-byte files are 4 raw bytes and a 402-byte zip.
  it('refuses when the finished archive outgrows the budget the raw bytes fit', async () => {
    const provider = createProvider(
      Object.fromEntries(
        ['a', 'b', 'c', 'd'].map((name) => [`src/${name}.ts`, { kind: 'text', text: 'x' } as const])
      )
    );

    const archive = await buildWorkspaceFolderArchive({
      provider,
      folderPath: 'src',
      filePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      maxTotalBytes: 200,
    });

    expect(archive.ok).toBe(false);
    expect(!archive.ok && archive.reason).toBe('too-large');
    // The reported size is the ARCHIVE's, not the 4 raw bytes that passed.
    expect(!archive.ok && (archive.totalBytes ?? 0)).toBeGreaterThan(200);
  });

  it('reports empty when nothing could be read at all', async () => {
    const provider = createProvider({ 'src/a.ts': { kind: 'unavailable', message: 'gone' } });
    const archive = await buildWorkspaceFolderArchive({
      provider,
      folderPath: 'src',
      filePaths: ['src/a.ts'],
    });
    expect(archive.ok).toBe(false);
    expect(!archive.ok && archive.reason).toBe('empty');
  });
});

describe('buildFolderArchiveFileName', () => {
  it('names the archive after the folder', () => {
    expect(buildFolderArchiveFileName('src/lib')).toBe('lib.zip');
    expect(buildFolderArchiveFileName('')).toBe('archive.zip');
  });
});
