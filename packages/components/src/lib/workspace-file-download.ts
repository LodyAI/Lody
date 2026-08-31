import { zipSync } from 'fflate';
import type { FileWorkspaceProvider, FileWorkspaceSnapshot } from './file-workspace-provider';
import { getIpcServices } from './electron-ipc-client';
import { isElectronRenderer } from './electron';
import { getBasename } from './utils';
import { FILE_TREE_DOWNLOAD_LIMITS, toArchiveEntryName } from './file-tree-download';

/**
 * Downloading a workspace file or folder that lives on ANOTHER machine.
 *
 * There is no download for a file that is already on this machine — the user
 * has the file; the tree offers "reveal in the file manager" there instead.
 * Remotely, the only channel that carries file bytes to this renderer is File
 * Preview v3 (`provider.openFile`), so a download is one preview read per file,
 * and a folder is those reads plus a zip assembled here. That is also where the
 * limits in `file-tree-download.ts` come from.
 *
 * The bytes never pass through the main process until the user has a
 * destination: Electron gets a native save dialog through `app.saveFileAs`,
 * every other host falls back to an anchor download.
 */

export type WorkspaceFileBytesResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly message?: string };

export type WorkspaceFileSaveOutcome =
  | { readonly kind: 'saved' }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'failed'; readonly error: string };

/** How many preview reads a folder download keeps outstanding at once. */
const FOLDER_DOWNLOAD_READ_CONCURRENCY = 4;

const textEncoder = new TextEncoder();

function snapshotToBytes(snapshot: FileWorkspaceSnapshot): WorkspaceFileBytesResult {
  if (snapshot.kind === 'text') {
    // The machine decodes with `ignoreBOM`, so a leading U+FEFF is still in the
    // string and re-encoding reproduces the original bytes exactly.
    return { ok: true, bytes: textEncoder.encode(snapshot.text) };
  }
  if (snapshot.kind === 'binary') {
    return snapshot.bytes
      ? { ok: true, bytes: snapshot.bytes }
      : { ok: false, message: undefined };
  }
  return { ok: false, ...(snapshot.message === undefined ? {} : { message: snapshot.message }) };
}

export async function readWorkspaceFileBytes(
  provider: FileWorkspaceProvider,
  path: string
): Promise<WorkspaceFileBytesResult> {
  try {
    const result = await provider.openFile(path);
    if (result.status !== 'ready') {
      return { ok: false, ...(result.message === undefined ? {} : { message: result.message }) };
    }
    return snapshotToBytes(result.snapshot);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export type FolderArchiveResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly fileCount: number;
      /** Paths whose bytes the machine refused; the archive omits them. */
      readonly skippedPaths: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'empty' | 'too-large'; readonly totalBytes?: number };

/**
 * Read every planned file and pack it into one zip.
 *
 * A file the machine refuses (over the preview limit, unreadable, deleted since
 * the index was written) is reported by path rather than dropped quietly: the
 * caller has to be able to tell the user that the archive is short.
 */
export async function buildWorkspaceFolderArchive({
  provider,
  folderPath,
  filePaths,
  maxTotalBytes = FILE_TREE_DOWNLOAD_LIMITS.maxTotalBytes,
}: {
  readonly provider: FileWorkspaceProvider;
  readonly folderPath: string;
  readonly filePaths: readonly string[];
  readonly maxTotalBytes?: number;
}): Promise<FolderArchiveResult> {
  const entries: Record<string, Uint8Array> = {};
  const skippedPaths: string[] = [];
  let totalBytes = 0;
  let overBudget = false;

  let nextIndex = 0;
  const readNext = async (): Promise<void> => {
    for (;;) {
      if (overBudget) return;
      const index = nextIndex;
      nextIndex += 1;
      const filePath = filePaths[index];
      if (filePath === undefined) return;

      const read = await readWorkspaceFileBytes(provider, filePath);
      if (!read.ok) {
        skippedPaths.push(filePath);
        continue;
      }
      totalBytes += read.bytes.byteLength;
      if (totalBytes > maxTotalBytes) {
        overBudget = true;
        return;
      }
      entries[toArchiveEntryName(filePath, folderPath)] = read.bytes;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FOLDER_DOWNLOAD_READ_CONCURRENCY, filePaths.length) }, readNext)
  );

  if (overBudget) {
    return { ok: false, reason: 'too-large', totalBytes };
  }
  const fileCount = Object.keys(entries).length;
  if (fileCount === 0) {
    return { ok: false, reason: 'empty' };
  }

  // Synchronous on purpose: fflate's async entry points create their worker from
  // a blob URL, which the packaged renderer's CSP does not allow.
  const archiveBytes = zipSync(entries);

  // The read loop bounded the RAW bytes, which does not bound the archive.
  // Deflate GROWS incompressible data slightly, and every entry adds a local
  // header plus a central-directory record: 64 MiB of random bytes zips to about
  // 64.01 MiB. The save bridge takes the finished archive, so the archive is
  // what has to fit — otherwise it is rejected there as a malformed payload and
  // the user gets a bare "failed to download" after paying for every read.
  if (archiveBytes.byteLength > maxTotalBytes) {
    return { ok: false, reason: 'too-large', totalBytes: archiveBytes.byteLength };
  }

  return { ok: true, bytes: archiveBytes, fileCount, skippedPaths };
}

/** Exactly the archive's bytes, so a pooled view never ships its whole buffer. */
function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = bytes.buffer;
  if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

export async function saveDownloadedFile(input: {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}): Promise<WorkspaceFileSaveOutcome> {
  const services = isElectronRenderer() ? getIpcServices() : null;
  if (services) {
    try {
      const result = await services.app.saveFileAs({
        fileName: input.fileName,
        bytes: toTransferableBuffer(input.bytes),
      });
      if (result.saved) return { kind: 'saved' };
      if (result.canceled) return { kind: 'canceled' };
      return { kind: 'failed', error: result.error ?? 'save_failed' };
    } catch (error) {
      return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { kind: 'failed', error: 'unsupported_host' };
  }

  // `bytes` is a plain Uint8Array over an ArrayBuffer, which BlobPart accepts;
  // the cast only satisfies lib.dom's ArrayBufferLike narrowing.
  const url = URL.createObjectURL(new Blob([input.bytes as BlobPart]));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = input.fileName;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return { kind: 'saved' };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type RevealLocalPathOutcome =
  | { readonly kind: 'revealed' }
  | { readonly kind: 'failed'; readonly error: string };

export async function revealLocalPathInFileManager(
  absolutePath: string
): Promise<RevealLocalPathOutcome> {
  const services = isElectronRenderer() ? getIpcServices() : null;
  if (!services) {
    return { kind: 'failed', error: 'native_bridge_unavailable' };
  }
  try {
    const result = await services.app.revealLocalPath({ path: absolutePath });
    return result.revealed
      ? { kind: 'revealed' }
      : { kind: 'failed', error: result.error ?? 'reveal_failed' };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/** `<folder>.zip`, or `archive.zip` for the workspace root (which has no name). */
export function buildFolderArchiveFileName(folderPath: string): string {
  const name = getBasename(folderPath).trim();
  return name ? `${name}.zip` : 'archive.zip';
}
