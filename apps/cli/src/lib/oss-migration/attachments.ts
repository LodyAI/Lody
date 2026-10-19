import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { LoroDoc, type Change } from 'loro-crdt';
import {
  createSessionMirror,
  SESSION_FILE_MAX_SIZE_BYTES,
  type SessionHistoryInput,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { SessionAttachmentTransfer } from '../session-attachment-transfer';
import { atomicJson } from './source';
import { canonical, hashBytes, safeId, type Journal, type Manifest } from './model';

const fileSchema = z
  .object({
    type: z.literal('file'),
    transport: z.enum(['local', 'r2']),
    fileId: safeId,
    fileName: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().nonnegative().max(SESSION_FILE_MAX_SIZE_BYTES),
    sha256: z.string().length(64),
    storageSessionId: safeId.optional(),
    machineId: z.string().optional(),
  })
  .passthrough();
type LocalFile = z.infer<typeof fileSchema>;
// Legacy contents is opaque to HistoryWriter; never silently retain local-only references.
function assertNoLegacyAttachments(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoLegacyAttachments(item);
    return;
  }
  const record = value as Record<string, unknown>;
  if (['file', 'image', 'image_group', 'image_url'].includes(String(record.type)))
    throw new Error('Legacy attachment references require conversion before migration.');
  for (const item of Object.values(record)) assertNoLegacyAttachments(item);
}
function fileItems(history: readonly SessionHistoryInput[]): LocalFile[] {
  const files: LocalFile[] = [];
  for (const turn of history) {
    if ('contents' in turn) assertNoLegacyAttachments(turn.contents);
    for (const item of [...(turn.items ?? []), ...(turn.inputConfig?.inputBlocks ?? [])]) {
      if (item.type === 'image' || item.type === 'image_group')
        throw new Error('Cloud image references cannot be migrated from an OSS snapshot.');
      if (item.type === 'file') files.push(fileSchema.parse(item));
    }
  }
  return files;
}
export function collectAttachmentFiles(doc: LoroDoc): LocalFile[] {
  const mirror = createSessionMirror({ doc, initialState: {} });
  try {
    return fileItems(mirror.historyWriter.readStored());
  } finally {
    mirror.dispose();
  }
}
/**
 * Walk historical map-write runs on an isolated replica, including removed turns.
 * Loro coalesces commits, so a Change is not an application transaction. HistoryWriter
 * writes each map field once per update: a repeated key or container transition ends
 * a run. Never interpret the interior of a descriptor replacement as a real file.
 * Ambiguous conflicting descriptors fail integrity validation; disk bytes never
 * decide which historical hash to trust.
 */
export function collectHistoricalAttachmentFiles(source: LoroDoc): LocalFile[] {
  if (source.isShallow()) throw new Error('Cannot enumerate attachments in shallow history');
  const files = new Map<string, LocalFile>();
  const add = (file: LocalFile) => {
    // Mirror builds file maps field by field. An earlier state missing an optional
    // storageSessionId is not a second blob in the current session. Retain complete
    // supersets; conflicting complete descriptors must all pass integrity preflight.
    const subset = (a: LocalFile, b: LocalFile) =>
      Object.entries(a).every(([key, value]) => canonical(value) === canonical(b[key]));
    for (const [key, previous] of files) {
      if (subset(file, previous)) return;
      if (subset(previous, file)) files.delete(key);
    }
    files.set(canonical(file), file);
  };
  for (const file of collectAttachmentFiles(source)) add(file);
  const doc = new LoroDoc();
  doc.import(source.export({ mode: 'snapshot' }));
  const scan = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'image' || record.type === 'image_group' || record.type === 'image_url')
      throw new Error('Historical image references cannot be migrated from an OSS snapshot.');
    if (record.type === 'file') {
      const parsed = fileSchema.safeParse(record);
      if (
        parsed.success &&
        typeof record.uploadedAt === 'number' &&
        (parsed.data.transport !== 'local' || parsed.data.machineId)
      )
        add(parsed.data);
    }
    for (const item of Object.values(record)) scan(item);
  };
  const updates = doc.exportJsonUpdates(undefined, undefined, false);
  const mayContainAttachment = (value: unknown): boolean => {
    if (typeof value === 'string')
      return ['file', 'image', 'image_group', 'image_url'].includes(value);
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some(mayContainAttachment);
  };
  if (
    !updates.changes.some((change) =>
      change.ops.some((op) => 'value' in op.content && mayContainAttachment(op.content.value))
    )
  )
    return [...files.values()];
  const changeEnds = new Map<string, Change>();
  for (const changes of doc.getAllChanges().values())
    for (const change of changes) changeEnds.set(`${change.counter}@${change.peer}`, change);
  for (const change of updates.changes) {
    const span = changeEnds.get(change.id);
    if (span === undefined) throw new Error('Cannot enumerate migration history boundaries');
    let container: string | undefined;
    let keys = new Set<string>();
    for (let index = 0; index < change.ops.length; index++) {
      const op = change.ops[index]!;
      const key = 'key' in op.content ? String(op.content.key) : undefined;
      if (container !== op.container || (key !== undefined && keys.has(key))) keys = new Set();
      container = op.container;
      if (key !== undefined) keys.add(key);
      const next = change.ops[index + 1];
      const nextKey = next && 'key' in next.content ? String(next.content.key) : undefined;
      const endsRun =
        !next ||
        next.container !== container ||
        key === undefined ||
        nextKey === undefined ||
        keys.has(nextKey);
      if (!endsRun) continue;
      const counter = (next?.counter ?? span.counter + span.length) - 1;
      doc.checkout([{ peer: span.peer, counter }]);
      scan(doc.getList('history').toJSON());
    }
  }

  return [...files.values()];
}

// Stored at HEAD, separately from immutable historical operations. Pass the HEAD
// document when resolving a file obtained by checking out an older frontier.
export const attachmentArchiveRoot = 'ossMigrationAttachments';
export function resolveArchivedAttachment(
  head: LoroDoc,
  file: LocalFile,
  sessionId: string
): LocalFile {
  const archived = head.getMap(attachmentArchiveRoot).get(attachmentKey(file, sessionId));
  if (!archived || typeof archived !== 'object' || !('target' in archived))
    throw new Error(`Missing migration attachment archive: ${file.fileId}`);
  const target = fileSchema.parse(archived.target);
  if (target.sha256 !== file.sha256 || target.sizeBytes !== file.sizeBytes)
    throw new Error('Migration attachment archive integrity mismatch');
  return target;
}

export function attachmentKey(file: LocalFile, sessionId: string): string {
  return `${file.storageSessionId ?? sessionId}/${file.fileId}`;
}
// Every historical descriptor must agree with its immutable blob. Never select a
// descriptor based on whichever bytes happen to remain on disk.
export async function validateHistoricalAttachments(
  doc: LoroDoc,
  sessionId: string,
  sourceMachineId: string,
  readBlob: (key: string) => Promise<Uint8Array>
): Promise<LocalFile[]> {
  const groups = new Map<string, LocalFile[]>();
  for (const file of collectHistoricalAttachmentFiles(doc)) {
    if (file.transport !== 'local' || file.machineId !== sourceMachineId)
      throw new Error(`Unsupported non-local attachment in ${sessionId}`);
    const key = attachmentKey(file, sessionId);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const current = collectAttachmentFiles(doc);
  const files: LocalFile[] = [];
  for (const [key, candidates] of groups) {
    const bytes = await readBlob(key);
    const sha256 = hashBytes(bytes);
    const matches = (file: LocalFile) => file.sizeBytes === bytes.length && file.sha256 === sha256;
    const valid = candidates.filter(matches);
    if (
      valid.length !== candidates.length ||
      current.some((file) => attachmentKey(file, sessionId) === key && !matches(file))
    )
      throw new Error(`Missing or corrupt attachment in ${sessionId}: ${key}`);
    // One immutable blob per key. Prefer the current presentation fields.
    files.push(
      current.find((file) => attachmentKey(file, sessionId) === key) ?? valid[valid.length - 1]!
    );
  }
  return files;
}
export async function validateAttachments(
  doc: LoroDoc,
  sessionId: string,
  directory: string,
  sourceMachineId: string
): Promise<LocalFile[]> {
  return validateHistoricalAttachments(doc, sessionId, sourceMachineId, (key) =>
    fs.readFile(path.join(directory, 'blobs', key))
  );
}
export async function migrateAttachments(
  doc: LoroDoc,
  sessionId: string,
  directory: string,
  manifest: Manifest,
  journal: Journal,
  transfer: SessionAttachmentTransfer,
  signal?: AbortSignal
): Promise<void> {
  const mirror = createSessionMirror({ doc, initialState: {} });
  try {
    const history = mirror.historyWriter.readStored();
    const files = await validateAttachments(doc, sessionId, directory, manifest.sourceMachineId);
    for (const file of files) {
      signal?.throwIfAborted();
      const key = attachmentKey(file, sessionId);
      const receipt = journal.attachments[key];
      if (receipt) {
        if (receipt.sha256 !== file.sha256 || receipt.sizeBytes !== file.sizeBytes)
          throw new Error('Attachment receipt does not match frozen history');
        continue;
      }
      const absolutePath = path.join(directory, 'blobs', key);
      const uploaded = await transfer.uploadValidatedSessionFile({
        workspaceId: manifest.targetWorkspaceId as WorkspaceId,
        sessionId: (file.storageSessionId ?? sessionId) as SessionId,
        file: {
          absolutePath,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          textPreview: file.textPreview === true,
        },
        signal,
      });
      signal?.throwIfAborted();
      if (uploaded.sha256 !== file.sha256 || uploaded.sizeBytes !== file.sizeBytes) {
        throw new Error('Uploaded attachment integrity metadata does not match the frozen source');
      }
      journal.attachments[key] = {
        fileId: uploaded.fileId,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      };
      await atomicJson(path.join(directory, 'journal.json'), journal);
    }
    signal?.throwIfAborted();
    // Include historical-only files, not just those that survive in today's visible list.
    for (const file of files) {
      const key = attachmentKey(file, sessionId);
      const receipt = journal.attachments[key];
      if (!receipt || typeof receipt.fileId !== 'string')
        throw new Error('Missing attachment receipt');
      const { machineId: _machine, ...original } = file;
      doc.getMap(attachmentArchiveRoot).set(key, {
        source: file,
        target: {
          ...original,
          fileId: receipt.fileId,
          transport: 'r2',
          storageSessionId: file.storageSessionId ?? sessionId,
        },
      });
    }
    const replace = <T extends { type: string }>(item: T): T => {
      if (item.type !== 'file') return item;
      const file = fileSchema.parse(item);
      const uploaded = journal.attachments[attachmentKey(file, sessionId)];
      if (!uploaded || typeof uploaded.fileId !== 'string')
        throw new Error('Missing uploaded attachment receipt');
      const result = { ...item, fileId: uploaded.fileId, transport: 'r2', machineId: undefined };
      delete (result as { machineId?: unknown }).machineId;
      return result;
    };
    mirror.historyWriter.update(() =>
      history.map((turn) => ({
        ...turn,
        ...(turn.items ? { items: turn.items.map(replace) } : {}),
        ...(turn.inputConfig
          ? {
              inputConfig: {
                ...turn.inputConfig,
                ...(turn.inputConfig.inputBlocks
                  ? { inputBlocks: turn.inputConfig.inputBlocks.map(replace) }
                  : {}),
              },
            }
          : {}),
      }))
    );
    doc.commit();
  } finally {
    mirror.dispose();
  }
}
