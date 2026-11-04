import { parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';
import {
  CODE_COLLAB_DIFF_BLOB_LIMITS,
  type CodeCollabDiffBlob,
  type CodeCollabDiffBlobKey,
  type CodeCollabDiffManifestEntry,
  type CodeCollabReadBlobResponse,
  type CodeCollabV2Error,
} from '@lody/shared';
import type { SessionFileDiffResult, SessionFileSnapshot } from './session-file-provider';
import { DiffBlobCache } from './diff-blob-cache';

export class DiffBlobReadError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export async function verifyDiffBlob(
  key: CodeCollabDiffBlobKey,
  bytes: Uint8Array
): Promise<boolean> {
  const [kind, hash] = key.split(':');
  const algorithm = kind === 'git' && hash?.length === 40 ? 'SHA-1' : 'SHA-256';
  let content = bytes;
  if (kind === 'git') {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    content = new Uint8Array(header.length + bytes.length);
    content.set(header);
    content.set(bytes, header.length);
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(algorithm, Uint8Array.from(content).buffer)
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') === hash;
}

export async function readDiffBlob(input: {
  signal?: AbortSignal;
  blob: CodeCollabDiffBlob;
  scope: string;
  persist: boolean;
  cache: DiffBlobCache;
  read: (
    key: CodeCollabDiffBlobKey,
    offset: number,
    length: number
  ) => Promise<CodeCollabReadBlobResponse | CodeCollabV2Error | null>;
}): Promise<Uint8Array> {
  const { blob, cache, scope, persist, read, signal } = input;
  signal?.throwIfAborted();
  const cacheEpoch = cache.epoch;
  const cached = await cache.get(scope, blob.key, persist);
  signal?.throwIfAborted();
  if (cached) {
    if (cached.length === blob.rawBytes && (await verifyDiffBlob(blob.key, cached))) return cached;
    await cache.delete(scope, blob.key, persist);
  }
  if (blob.rawBytes > CODE_COLLAB_DIFF_BLOB_LIMITS.maxRawBytes)
    throw new DiffBlobReadError('too_large', 'Diff blob exceeds its raw byte limit.');
  const bytes = new Uint8Array(blob.rawBytes);
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const page = await read(blob.key, offset, CODE_COLLAB_DIFF_BLOB_LIMITS.pageBytes);
    signal?.throwIfAborted();
    if (!page) throw new DiffBlobReadError('transient_io', 'Diff blob request timed out.');
    if ('status' in page)
      throw new DiffBlobReadError(page.code, page.message ?? 'Diff blob is unavailable.');
    if (
      page.offset !== offset ||
      page.totalBytes !== blob.rawBytes ||
      page.length < 1 ||
      page.length > CODE_COLLAB_DIFF_BLOB_LIMITS.pageBytes ||
      offset + page.length > bytes.length
    )
      throw new DiffBlobReadError('stale', 'Invalid diff blob page.');
    const compressed = Uint8Array.from(atob(page.data), (char) => char.charCodeAt(0));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    let consumed = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (consumed + next.value.length > page.length)
          throw new DiffBlobReadError(
            'decode_error',
            'Diff blob page expanded beyond its declared size.'
          );
        bytes.set(next.value, offset + consumed);
        consumed += next.value.length;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (consumed !== page.length)
      throw new DiffBlobReadError('decode_error', 'Incomplete diff blob page.');
    offset += page.length;
  }
  if (!(await verifyDiffBlob(blob.key, bytes)))
    throw new DiffBlobReadError('digest_mismatch', 'File changed while its diff was being read.');
  signal?.throwIfAborted();
  if (cache.epoch === cacheEpoch) await cache.put(scope, blob.key, bytes, persist);
  return bytes;
}

export async function manifestEntryToDiff(
  entry: CodeCollabDiffManifestEntry,
  read: (blob: CodeCollabDiffBlob, signal?: AbortSignal) => Promise<Uint8Array>,
  renew?: (signal?: AbortSignal) => Promise<CodeCollabDiffManifestEntry>
): Promise<SessionFileDiffResult> {
  const contentKey = JSON.stringify([entry.base?.key ?? null, entry.head?.key ?? null]);
  if (entry.status === 'not_changed' || entry.status === 'missing')
    return {
      status: 'unavailable',
      path: entry.path,
      reason: 'metadata-only',
      message: 'No changed content is available.',
    };
  if (entry.status === 'binary' || entry.status === 'too_large') {
    const snapshot: SessionFileSnapshot =
      entry.status === 'binary'
        ? { kind: 'binary' }
        : { kind: 'unavailable', reason: 'text-too-large' };
    return { status: 'ready', path: entry.path, oldSnapshot: snapshot, newSnapshot: snapshot };
  }
  const text = async (blob: CodeCollabDiffBlob | null, signal?: AbortSignal) =>
    blob
      ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await read(blob, signal))
      : '';
  if (entry.hunks !== undefined) {
    const fileDiff = parsePatchFiles(entry.hunks, `${contentKey}:${entry.path}`, true)[0]?.files[0];
    if (!fileDiff) throw new DiffBlobReadError('decode_error', 'Invalid remote diff patch.');
    return {
      status: 'ready-parsed',
      path: entry.path,
      fileDiff,
      contentKey,
      oldTextLength: entry.base?.rawBytes ?? 0,
      newTextLength: entry.head?.rawBytes ?? 0,
      loadDiffFiles: async (diff, signal) => {
        let selected = entry;
        for (let attempt = 0; ; attempt++) {
          try {
            const files = {
              oldFile: {
                name: selected.path,
                contents: await text(selected.base, signal),
                cacheKey: selected.base ? `${selected.base.key}:${selected.path}` : undefined,
              },
              newFile: {
                name: selected.path,
                contents: await text(selected.head, signal),
                cacheKey: selected.head ? `${selected.head.key}:${selected.path}` : undefined,
              },
            };
            signal?.throwIfAborted();
            if (selected.base?.key !== entry.base?.key || selected.head?.key !== entry.head?.key) {
              // Pierre hydrates in place and preserves hunk coordinates. Replace those
              // coordinates before it hydrates a newly observed version of the file.
              Object.assign(diff, parseDiffFromFile(files.oldFile, files.newFile), {
                isPartial: true,
              });
            }
            return files;
          } catch (error) {
            if (
              attempt !== 0 ||
              !renew ||
              !(error instanceof DiffBlobReadError) ||
              !['stale', 'digest_mismatch'].includes(error.code)
            )
              throw error;
            signal?.throwIfAborted();
            selected = await renew(signal);
            if (!['ok', 'not_changed', 'missing'].includes(selected.status))
              throw new DiffBlobReadError(selected.status, 'Diff content is no longer text.');
          }
        }
      },
    };
  }
  const snapshot = async (blob: CodeCollabDiffBlob | null): Promise<SessionFileSnapshot> =>
    blob ? { kind: 'text', text: await text(blob) } : { kind: 'unavailable', reason: 'deleted' };
  return {
    status: 'ready',
    path: entry.path,
    contentKey,
    oldSnapshot: await snapshot(entry.base),
    newSnapshot: await snapshot(entry.head),
  };
}
