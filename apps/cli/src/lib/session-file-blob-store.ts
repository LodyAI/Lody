import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SessionImagePayloadSchema } from '@lody/shared/message-schemas';
import type { SessionImagePayload } from '@lody/shared';
import { EncryptedAttachmentSchema, type EncryptedAttachment } from '@lody/shared';
import os from 'os';
import fs from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import { getServerNow } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

/**
 * Local blob store for desktop local-transport session file attachments.
 *
 * Layout: `<active installation data root>/session-files/<workspaceId>/<sessionId>/<fileId>`
 *
 * The desktop fast path copies the sender's bytes here so the agent can read
 * them immediately (via the attachments materialize path) while the runtime
 * backfills the bytes to the relay store in the background. Once backfill flips
 * the history block to `transport: 'r2'`, the blob is moved into `_backfilled/`
 * and purged after a retention window (or sooner under quota pressure).
 *
 * The store is a flat content cache keyed by the server-generated `fileId`; it
 * never holds user-supplied names, so there is no path-traversal surface from
 * `fileName`. Callers MUST pass validated identifiers.
 */

const SESSION_FILES_DIR_NAME = 'session-files';
const BACKFILLED_DIR_NAME = '_backfilled';
export const SESSION_FILE_BLOB_DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const SESSION_FILE_BLOB_DEFAULT_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_FILE_BLOB_WARN_RATIO = 0.8;

/**
 * Thrown when a new pending blob would exceed the store quota even after
 * purging already-backfilled blobs. The message is user-facing; frontends may
 * match on `code` for localization.
 */
export class SessionFileBlobQuotaError extends Error {
  readonly code = 'session_file_blob_quota_exceeded';

  constructor(
    public readonly usedBytes: number,
    public readonly quotaBytes: number
  ) {
    super(
      'Offline attachment storage is full. Space is freed automatically once pending attachments sync online.'
    );
    this.name = 'SessionFileBlobQuotaError';
  }
}

/** Reject identifiers that could escape the store root or break the layout. */
const isSafeId = (value: string): boolean =>
  value.length > 0 &&
  !value.includes('/') &&
  !value.includes('\\') &&
  value !== '.' &&
  value !== '..';

export const getSessionFilesRoot = (homeDir: string = os.homedir()): string =>
  path.join(getLodyDataDir(undefined, homeDir), SESSION_FILES_DIR_NAME);

const getQuotaBytes = (): number => {
  const raw = process.env.LODY_SESSION_FILE_BLOB_QUOTA_BYTES;
  if (!raw) {
    return SESSION_FILE_BLOB_DEFAULT_QUOTA_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Invalid LODY_SESSION_FILE_BLOB_QUOTA_BYTES');
  }
  return Math.floor(parsed);
};

const getRetainMs = (): number => {
  const raw = process.env.LODY_SESSION_FILE_BLOB_RETAIN_DAYS;
  if (!raw) {
    return SESSION_FILE_BLOB_DEFAULT_RETAIN_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Invalid LODY_SESSION_FILE_BLOB_RETAIN_DAYS');
  }
  return Math.floor(parsed * 24 * 60 * 60 * 1000);
};

const mkdirPrivate = async (dir: string): Promise<void> => {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700);
};

export const getSessionFileBlobDir = (args: {
  workspaceId: string;
  sessionId: string;
  homeDir?: string;
}): string => {
  if (!isSafeId(args.workspaceId) || !isSafeId(args.sessionId)) {
    throw new Error('Invalid workspaceId or sessionId for blob store');
  }
  return path.join(getSessionFilesRoot(args.homeDir), args.workspaceId, args.sessionId);
};

export const getSessionFileBlobPath = (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  homeDir?: string;
}): string => {
  if (!isSafeId(args.fileId)) {
    throw new Error('Invalid fileId for blob store');
  }
  return path.join(getSessionFileBlobDir(args), args.fileId);
};

const getBackfilledSessionFileBlobPath = (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  homeDir?: string;
}): string => {
  if (!isSafeId(args.workspaceId) || !isSafeId(args.sessionId) || !isSafeId(args.fileId)) {
    throw new Error('Invalid blob identifier');
  }
  return path.join(
    getSessionFilesRoot(args.homeDir),
    BACKFILLED_DIR_NAME,
    args.workspaceId,
    args.sessionId,
    args.fileId
  );
};

const sumFileSizes = async (dir: string): Promise<number> => {
  let entries: Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  let total = 0;
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sumFileSizes(child);
    } else if (entry.isFile() && !entry.name.endsWith('.part')) {
      total += (await fs.promises.stat(child)).size;
    }
  }
  return total;
};

export const getSessionFileBlobStoreUsage = async (
  args: {
    homeDir?: string;
  } = {}
): Promise<{ usedBytes: number; quotaBytes: number; warn: boolean }> => {
  const quotaBytes = getQuotaBytes();
  const usedBytes = await sumFileSizes(getSessionFilesRoot(args.homeDir));
  return {
    usedBytes,
    quotaBytes,
    warn: usedBytes >= quotaBytes * SESSION_FILE_BLOB_WARN_RATIO,
  };
};

const removeEmptyParents = async (dir: string, stopAt: string): Promise<void> => {
  let current = dir;
  while (current !== stopAt && current.startsWith(stopAt + path.sep)) {
    try {
      await fs.promises.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
};

export const cleanupBackfilledSessionFileBlobs = async (
  args: {
    homeDir?: string;
    now?: number;
    retainMs?: number;
  } = {}
): Promise<number> => {
  const root = path.join(getSessionFilesRoot(args.homeDir), BACKFILLED_DIR_NAME);
  const now = args.now ?? getServerNow();
  const retainMs = args.retainMs ?? getRetainMs();
  let removed = 0;

  const visit = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
        await fs.promises.rmdir(child).catch(() => undefined);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(child);
        if (now - stat.mtimeMs >= retainMs) {
          await fs.promises.unlink(child);
          removed += 1;
        }
      }
    }
  };

  await visit(root);
  await fs.promises.rmdir(root).catch(() => undefined);
  return removed;
};

/**
 * Copy a source file into the blob store. Idempotent: the destination is created
 * atomically via a temp file + rename, so a re-copy of the same fileId simply
 * overwrites the prior content. Returns the destination path plus post-copy
 * usage (so callers don't need a second full-tree walk to warn on pressure).
 *
 * Quota: when the copy would exceed the quota, already-backfilled blobs (safe
 * to delete — their bytes are in R2) are purged first; only if the store is
 * still over after that is the write rejected. Pending blobs are never evicted.
 */
// Serialize all writes through one process-wide chain: the quota check
// (read-usage → copy → rename) is otherwise TOCTOU, so concurrent sends — the
// message processor allows many in flight, and every workspace shares one store
// root — could each read the same pre-write usage and collectively blow the
// quota. `.part` temp files are also excluded from usage, widening the window.
let blobStoreWriteChain: Promise<unknown> = Promise.resolve();

export const copyIntoSessionFileBlobStore = (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  sourcePath: string;
  homeDir?: string;
}): Promise<{ destPath: string; usedBytes: number; quotaBytes: number; warn: boolean }> => {
  const run = blobStoreWriteChain.then(
    () => copyIntoSessionFileBlobStoreUnlocked(args),
    () => copyIntoSessionFileBlobStoreUnlocked(args)
  );
  // Keep the chain alive regardless of this write's outcome.
  blobStoreWriteChain = run.catch(() => undefined);
  return run;
};

const copyIntoSessionFileBlobStoreUnlocked = async (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  sourcePath: string;
  homeDir?: string;
}): Promise<{ destPath: string; usedBytes: number; quotaBytes: number; warn: boolean }> => {
  const dir = getSessionFileBlobDir(args);
  await mkdirPrivate(getSessionFilesRoot(args.homeDir));
  await mkdirPrivate(dir);
  const destPath = getSessionFileBlobPath(args);
  const sourceSize = (await fs.promises.stat(args.sourcePath)).size;
  let existingSize = 0;
  try {
    existingSize = (await fs.promises.stat(destPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  let usage = await getSessionFileBlobStoreUsage({ homeDir: args.homeDir });
  const projectedBytes = () => usage.usedBytes - existingSize + sourceSize;
  if (projectedBytes() > usage.quotaBytes) {
    await cleanupBackfilledSessionFileBlobs({ homeDir: args.homeDir, retainMs: 0 }).catch(
      () => undefined
    );
    usage = await getSessionFileBlobStoreUsage({ homeDir: args.homeDir });
    if (projectedBytes() > usage.quotaBytes) {
      throw new SessionFileBlobQuotaError(usage.usedBytes, usage.quotaBytes);
    }
  }
  const tempPath = `${destPath}.${process.pid}.${getServerNow()}.part`;
  try {
    await fs.promises.copyFile(args.sourcePath, tempPath);
    await fs.promises.chmod(tempPath, 0o600);
    await fs.promises.rename(tempPath, destPath);
  } catch (error) {
    // A failed copy/rename (ENOSPC, interrupted write) would otherwise strand the
    // `.part` temp: it is excluded from usage, the pending scan, and retention
    // cleanup, so nothing else would ever reclaim it.
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await fs.promises.chmod(destPath, 0o600);
  const usedBytes = projectedBytes();
  return {
    destPath,
    usedBytes,
    quotaBytes: usage.quotaBytes,
    warn: usedBytes >= usage.quotaBytes * SESSION_FILE_BLOB_WARN_RATIO,
  };
};

// Sidecar recording the relay fileId a blob was (about to be) flipped to. Written
// BEFORE the history flip so restart recovery can tell a crash window apart:
//  - marker present, local block still in history → flip didn't finish → re-flip.
//  - marker present, no local block            → flip finished, mark didn't →
//    finalize (this is the R5.3 stranded-blob case).
// The `.r2meta` suffix keeps it out of the pending-blob scan.
const getBackfillMarkerPath = (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  homeDir?: string;
}): string => `${getSessionFileBlobPath(args)}.r2meta`;

export const writeSessionFileBlobBackfillMarker = async (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  relayFileId: string;
  encryption?: EncryptedAttachment;
  homeDir?: string;
}): Promise<void> => {
  const markerPath = getBackfillMarkerPath(args);
  const tempPath = `${markerPath}.${process.pid}.${getServerNow()}.tmp`;
  await fs.promises.writeFile(
    tempPath,
    JSON.stringify({
      relayFileId: args.relayFileId,
      ...(args.encryption ? { encryption: args.encryption } : {}),
    }),
    {
      mode: 0o600,
    }
  );
  await fs.promises.rename(tempPath, markerPath);
};

export const readSessionFileBlobBackfillReceipt = async (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  homeDir?: string;
}): Promise<{ relayFileId: string; encryption?: EncryptedAttachment } | null> => {
  let raw: string;
  try {
    raw = await fs.promises.readFile(getBackfillMarkerPath(args), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as { relayFileId?: unknown; encryption?: unknown };
  if (typeof parsed.relayFileId !== 'string' || !parsed.relayFileId)
    throw new Error('Invalid attachment backfill receipt');
  return {
    relayFileId: parsed.relayFileId,
    ...(parsed.encryption === undefined
      ? {}
      : { encryption: EncryptedAttachmentSchema.parse(parsed.encryption) }),
  };
};

export const readSessionFileBlobBackfillMarker = async (
  args: Parameters<typeof readSessionFileBlobBackfillReceipt>[0]
): Promise<string | null> =>
  (await readSessionFileBlobBackfillReceipt(args).catch(() => null))?.relayFileId ?? null;

/** Age of a blob on disk in ms (from mtime), or null when it does not exist. */
export const getSessionFileBlobAgeMs = async (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  homeDir?: string;
}): Promise<number | null> => {
  try {
    const stat = await fs.promises.stat(getSessionFileBlobPath(args));
    return Math.max(0, getServerNow() - stat.mtimeMs);
  } catch {
    return null;
  }
};

/** Max age of a never-persisted (draft) blob before it is reclaimed (R5.4). */
export const getDraftSessionFileBlobMaxAgeMs = (): number => getRetainMs();

/** Best-effort removal of a blob (and its backfill marker) once it is no longer needed. */
export const removeSessionFileBlob = async (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  homeDir?: string;
}): Promise<void> => {
  try {
    await fs.promises.unlink(getSessionFileBlobPath(args));
  } catch {
    // Already gone (or never written) — nothing to clean up.
  }
  await fs.promises.unlink(getBackfillMarkerPath(args)).catch(() => undefined);
};

export const markSessionFileBlobBackfilled = async (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  homeDir?: string;
}): Promise<void> => {
  // Retention cleanup is opportunistic; a cleanup failure must not block the
  // backfill bookkeeping below.
  await cleanupBackfilledSessionFileBlobs({ homeDir: args.homeDir }).catch(() => undefined);
  const source = getSessionFileBlobPath(args);
  const dest = getBackfilledSessionFileBlobPath(args);
  await mkdirPrivate(path.dirname(dest));
  await fs.promises.rename(source, dest);
  const now = new Date(getServerNow());
  await fs.promises.utimes(dest, now, now);
  // The flip is committed; the crash-recovery marker is no longer needed.
  await fs.promises.unlink(getBackfillMarkerPath(args)).catch(() => undefined);
  await removeEmptyParents(path.dirname(source), getSessionFilesRoot(args.homeDir));
};

/** Whether a blob for the given fileId exists on disk. */
export const sessionFileBlobExists = async (args: {
  workspaceId: string;
  sessionId: string;
  fileId: string;
  homeDir?: string;
}): Promise<boolean> => {
  try {
    const stat = await fs.promises.stat(getSessionFileBlobPath(args));
    return stat.isFile();
  } catch {
    return false;
  }
};

export type PendingLocalSessionFile = {
  sessionId: string;
  fileId: string;
};

/**
 * Enumerate every blob currently on disk for a workspace. Each present blob is a
 * durable record of a pending backfill (blobs are removed only after a successful
 * `local -> r2` flip), so this is the source of truth for CLI-restart recovery.
 * `.part` temp files (interrupted copies) and non-files are skipped.
 */
export const listPendingLocalSessionFiles = async (args: {
  workspaceId: string;
  homeDir?: string;
}): Promise<PendingLocalSessionFile[]> => {
  if (!isSafeId(args.workspaceId)) {
    return [];
  }
  const workspaceDir = path.join(getSessionFilesRoot(args.homeDir), args.workspaceId);
  let sessionEntries: Dirent[];
  try {
    sessionEntries = await fs.promises.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pending: PendingLocalSessionFile[] = [];
  for (const sessionEntry of sessionEntries) {
    if (!sessionEntry.isDirectory() || !isSafeId(sessionEntry.name)) {
      continue;
    }
    const sessionId = sessionEntry.name;
    let fileEntries: Dirent[];
    try {
      fileEntries = await fs.promises.readdir(path.join(workspaceDir, sessionId), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const fileEntry of fileEntries) {
      if (
        fileEntry.isFile() &&
        !fileEntry.name.startsWith('image-') &&
        !fileEntry.name.endsWith('.part') &&
        !fileEntry.name.endsWith('.r2meta') &&
        isSafeId(fileEntry.name)
      ) {
        pending.push({ sessionId, fileId: fileEntry.name });
      }
    }
  }
  return pending;
};

// Images remain pinned after upload: frozen input and offline previews still own the
// snapshot. Their records are deliberately outside the legacy file backfill scan.
type ImageScope = {
  workspaceId: string;
  sessionId: string;
  machineId: string;
  accountId: string;
  homeDir?: string;
};
const ImageRecordSchema = z
  .object({
    version: z.literal(1),
    accountId: z.string(),
    sha256: z.string(),
    image: SessionImagePayloadSchema,
  })
  .strict();
const imageBlobArgs = (scope: ImageScope, localImageId: string) => ({
  ...scope,
  fileId: `image-${z.string().uuid().parse(localImageId)}`,
});
async function publishImageFile(destination: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.part`;
  const handle = await fs.promises.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await fs.promises.readFile(destination)).equals(Buffer.from(bytes)))
        throw new Error('Local image identity conflicts with accepted content');
    }
    // Directory fsync is supported on Unix. Windows rejects directory handles.
    if (process.platform !== 'win32') {
      const directory = await fs.promises.open(path.dirname(destination), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await fs.promises.unlink(temporary).catch(() => undefined);
  }
}
export async function readLocalSessionImage(scope: ImageScope, image: SessionImagePayload) {
  if (image.machineId !== scope.machineId || !image.localImageId || image.encryption)
    throw new Error('Local image is unavailable on this machine');
  const blobPath = getSessionFileBlobPath(imageBlobArgs(scope, image.localImageId));
  const saved = ImageRecordSchema.parse(
    JSON.parse(await fs.promises.readFile(`${blobPath}.imagemeta`, 'utf8'))
  );
  if (
    saved.accountId !== scope.accountId ||
    saved.image.machineId !== scope.machineId ||
    saved.image.localImageId !== image.localImageId ||
    saved.image.mimeType !== image.mimeType ||
    saved.image.sizeBytes !== image.sizeBytes
  )
    throw new Error('Local image reference mismatch');
  const bytes = await fs.promises.readFile(blobPath);
  if (
    bytes.length !== saved.image.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== saved.sha256
  )
    throw new Error('Local image snapshot changed');
  return { path: blobPath, bytes, image: saved.image };
}
export function storeLocalSessionImage(
  scope: ImageScope,
  image: SessionImagePayload,
  bytes: Buffer
): Promise<SessionImagePayload> {
  const work = async () => {
    const parsed = SessionImagePayloadSchema.parse(image);
    if (
      parsed.transport !== 'local' ||
      !parsed.localImageId ||
      parsed.machineId !== scope.machineId ||
      parsed.sizeBytes !== bytes.length
    )
      throw new Error('Invalid local image snapshot');
    const args = imageBlobArgs(scope, parsed.localImageId);
    const destination = getSessionFileBlobPath(args);
    await mkdirPrivate(getSessionFilesRoot(scope.homeDir));
    await mkdirPrivate(getSessionFileBlobDir(args));
    let existingBytes = 0;
    try {
      existingBytes = (await fs.promises.stat(destination)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let usage = await getSessionFileBlobStoreUsage(scope);
    if (usage.usedBytes + bytes.length - existingBytes > usage.quotaBytes) {
      await cleanupBackfilledSessionFileBlobs({ ...scope, retainMs: 0 });
      usage = await getSessionFileBlobStoreUsage(scope);
      if (usage.usedBytes + bytes.length - existingBytes > usage.quotaBytes)
        throw new SessionFileBlobQuotaError(usage.usedBytes, usage.quotaBytes);
    }
    // Persist newly created path components as well as the file entries.
    if (process.platform !== 'win32') {
      for (const directoryPath of [
        path.dirname(destination),
        path.dirname(path.dirname(destination)),
        getSessionFilesRoot(scope.homeDir),
        path.dirname(getSessionFilesRoot(scope.homeDir)),
      ]) {
        const directory = await fs.promises.open(directoryPath, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    }
    await publishImageFile(destination, bytes);
    await publishImageFile(
      `${destination}.imagemeta`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          accountId: scope.accountId,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          image: parsed,
        })
      )
    );
    return parsed;
  };
  const run = blobStoreWriteChain.then(work, work);
  blobStoreWriteChain = run.catch(() => undefined);
  return run;
}
export async function readLocalSessionImageReceipt(
  scope: ImageScope,
  localImageId: string
): Promise<SessionImagePayload | null> {
  try {
    const receipt = SessionImagePayloadSchema.parse(
      JSON.parse(
        await fs.promises.readFile(
          `${getSessionFileBlobPath(imageBlobArgs(scope, localImageId))}.imagereceipt`,
          'utf8'
        )
      )
    );
    if (
      receipt.transport !== 'r2' ||
      receipt.localImageId !== localImageId ||
      receipt.machineId !== scope.machineId
    )
      throw new Error('Invalid image upload receipt');
    await readLocalSessionImage(scope, receipt);
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeLocalSessionImageReceipt(
  scope: ImageScope,
  image: SessionImagePayload
): Promise<void> {
  const parsed = SessionImagePayloadSchema.parse(image);
  if (!parsed.localImageId || parsed.transport !== 'r2')
    throw new Error('Invalid image upload receipt');
  await readLocalSessionImage(scope, parsed);
  await publishImageFile(
    `${getSessionFileBlobPath(imageBlobArgs(scope, parsed.localImageId))}.imagereceipt`,
    Buffer.from(JSON.stringify(parsed))
  );
}
export async function listLocalSessionImages(
  scope: Omit<ImageScope, 'sessionId'>
): Promise<Array<{ sessionId: string; image: SessionImagePayload }>> {
  const workspaceDir = getSessionFileBlobDir({ ...scope, sessionId: '_' });
  let sessions: Dirent[];
  try {
    sessions = await fs.promises.readdir(path.dirname(workspaceDir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const images: Array<{ sessionId: string; image: SessionImagePayload }> = [];
  for (const session of sessions) {
    if (!session.isDirectory() || !isSafeId(session.name)) continue;
    const args = { ...scope, sessionId: session.name };
    const dir = getSessionFileBlobDir(args);
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith('image-') || !entry.name.endsWith('.imagemeta'))
        continue;
      try {
        const record = ImageRecordSchema.parse(
          JSON.parse(await fs.promises.readFile(path.join(dir, entry.name), 'utf8'))
        );
        if (record.accountId === scope.accountId && record.image.machineId === scope.machineId)
          images.push({ sessionId: session.name, image: record.image });
      } catch {
        /* A damaged record cannot authorize an upload; retain its bytes. */
      }
    }
  }
  return images;
}
