import { createSessionMirror } from '@lody/shared/session-mirror';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoroDoc } from 'loro-crdt';
import { getSessionFileBlobPath } from '@/lib/session-file-blob-store';
import type { BundleWriter, OpenBundle } from './bundle-file';
import { sha256 } from './manifest';
import type { ImportPlan } from './import';

/** Carries local session files; relay-hosted files and images are recorded as gaps. */
const SESSION_FILE_REF = 'session-file:';
const MAX_FILE_BYTES = 512 * 1024 * 1024;

type FileItem = {
  type: 'file';
  transport?: string;
  fileId?: unknown;
  storageSessionId?: unknown;
  sha256?: unknown;
  sizeBytes?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
};

function attachmentItems(doc: LoroDoc): Array<FileItem | { type: 'image' | 'image_group' }> {
  const mirror = createSessionMirror({ doc, initialState: {} });
  try {
    const items: Array<FileItem | { type: 'image' | 'image_group' }> = [];
    for (const turn of mirror.historyWriter.readStored()) {
      for (const item of [...(turn.items ?? []), ...(turn.inputConfig?.inputBlocks ?? [])]) {
        if (item.type === 'file') items.push(item as FileItem);
        else if (item.type === 'image' || item.type === 'image_group')
          items.push({ type: item.type });
      }
    }
    return items;
  } finally {
    mirror.dispose();
  }
}

const safeId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9._-]{1,200}$/.test(value) &&
  value !== '.' &&
  value !== '..';

/** Export hook: adds this workspace's local session files referenced by a session's history. */
export function localSessionFileBlobs(workspaceId: string) {
  return async (sessionId: string, doc: LoroDoc, writer: BundleWriter): Promise<void> => {
    let images = 0;
    for (const item of attachmentItems(doc)) {
      if (item.type !== 'file') {
        images += 1;
        continue;
      }
      const storageSessionId = safeId(item.storageSessionId) ? item.storageSessionId : sessionId;
      if (!safeId(item.fileId) || !safeId(storageSessionId)) continue;
      const ref = `${SESSION_FILE_REF}${storageSessionId}/${item.fileId}`;
      if (item.transport !== 'local') {
        writer.addGap({
          id: ref,
          kind: 'attachment',
          reason: 'Relay-hosted files are not copied into bundles yet',
        });
        continue;
      }
      let bytes: Buffer;
      try {
        const file = getSessionFileBlobPath({
          workspaceId,
          sessionId: storageSessionId,
          fileId: item.fileId,
        });
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('not a regular file');
        bytes = await fs.readFile(file);
      } catch {
        writer.addGap({
          id: ref,
          kind: 'attachment',
          reason: 'File bytes are not available on this device',
        });
        continue;
      }
      if (typeof item.sha256 === 'string' && sha256(bytes) !== item.sha256) {
        writer.addGap({
          id: ref,
          kind: 'attachment',
          reason: 'Stored file does not match its history record',
        });
        continue;
      }
      await writer.addBlob(
        {
          kind: 'session-file',
          ...(typeof item.fileName === 'string' ? { name: item.fileName.slice(0, 1024) } : {}),
          ...(typeof item.mimeType === 'string' ? { mime: item.mimeType.slice(0, 256) } : {}),
          refs: [ref],
        },
        bytes
      );
    }
    if (images > 0)
      writer.addGap({
        id: `session-${sessionId}`,
        kind: 'images',
        reason: `${images} image reference(s) are not copied into bundles yet`,
      });
  };
}

/** Restores bundled session files for imported sessions; existing files are kept. */
export async function restoreSessionFileBlobs(input: {
  bundle: OpenBundle;
  plan: ImportPlan;
}): Promise<{ written: number; existing: number }> {
  const imported = new Set(
    input.plan.rooms
      .filter((room) => room.action === 'merge' && room.codec === 'session/v1')
      .map((room) => room.targetId.slice('session-'.length))
  );
  const result = { written: 0, existing: 0 };
  for (const blob of input.bundle.manifest.blobs) {
    let bytes: Uint8Array | undefined;
    for (const ref of blob.refs ?? []) {
      if (!ref.startsWith(SESSION_FILE_REF)) continue;
      const [sessionId, fileId, ...rest] = ref.slice(SESSION_FILE_REF.length).split('/');
      if (rest.length > 0 || !safeId(sessionId) || !safeId(fileId) || !imported.has(sessionId))
        continue;
      const destination = getSessionFileBlobPath({
        workspaceId: input.plan.targetWorkspaceId,
        sessionId,
        fileId,
      });
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      // Read lazily and once per blob, however many references it has.
      bytes ??= await input.bundle.readBlob(blob.sha256);
      try {
        await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        result.written += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        result.existing += 1;
      }
    }
  }
  return result;
}
