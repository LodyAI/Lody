import type { JsonObject, LoroRepo } from 'loro-repo';
import type { BundleWriter } from './bundle-file';
import { classifyRoom, META_ROOM_ID } from './codecs';
import type { BundleManifest, BundleSource } from './manifest';

export type ExportProgress = { phase: 'meta' | 'docs' | 'flocks'; done: number; total: number };

export type ExportWorkspaceBundleInput = {
  repo: LoroRepo<JsonObject>;
  workspaceId: string;
  writer: BundleWriter;
  source: Omit<BundleSource, 'finishedAt'>;
  /** Brings one room up to date before it is read (cloud sync); absent offline. */
  prepareRoom?: (roomId: string, model: 'loro' | 'flock') => Promise<void>;
  /** Checked before every room; throwing aborts the export (for example, role revoked). */
  checkContinue?: () => Promise<void>;
  onProgress?: (progress: ExportProgress) => void;
  now?: () => string;
};

/**
 * Reads every room of the workspace as raw CRDT bytes. Meta is read first, so rooms
 * created later are not included; each room is a complete state of itself.
 * The caller owns the writer: it finishes or aborts it.
 */
export async function exportWorkspaceBundle(input: ExportWorkspaceBundleInput): Promise<BundleManifest> {
  const { repo, workspaceId, writer } = input;
  const check = input.checkContinue ?? (async () => undefined);
  /** A room this device cannot bring up to date is a gap, not a failed export. */
  const prepare = async (roomId: string, model: 'loro' | 'flock'): Promise<boolean> => {
    try {
      await input.prepareRoom?.(roomId, model);
      return true;
    } catch (error) {
      writer.addGap({
        id: roomId,
        kind: 'unreadable',
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
  await check();
  await writer.addRoom(
    { id: META_ROOM_ID, model: 'meta', codec: 'meta/v1', encoding: 'flock-file/v1' },
    repo.getMeta().exportFile()
  );
  input.onProgress?.({ phase: 'meta', done: 1, total: 1 });

  const docs = await repo.listDoc();
  let done = 0;
  for (const entry of docs) {
    done += 1;
    if (entry.deleted) continue; // Meta keeps the deletion record.
    const room = classifyRoom(entry.docId, workspaceId);
    if (room.kind === 'excluded') continue;
    if (room.kind === 'unknown' || room.model !== 'loro') {
      writer.addGap({ id: entry.docId, kind: 'unknown', reason: 'Unknown document kind' });
      continue;
    }
    await check();
    if (!(await prepare(entry.docId, 'loro'))) continue;
    const doc = await repo.openDetachedDoc(entry.docId);
    // After a successful sync an empty body is genuinely empty (machine records, for
    // example, keep every field in Meta); Meta already carries the document.
    if (doc.frontiers().length === 0) continue;
    await writer.addRoom(
      { id: entry.docId, model: 'loro', codec: room.codec, encoding: room.encoding },
      doc.export({ mode: 'snapshot' })
    );
    if (room.codec === 'session/v1' && entry.meta.historyBackend === 'roost')
      writer.addGap({
        id: entry.docId,
        kind: 'roost',
        reason: 'Roost conversation body is exported separately and is not yet supported',
      });
    input.onProgress?.({ phase: 'docs', done, total: docs.length });
  }

  const flocks = await repo.listFlockDoc();
  done = 0;
  for (const entry of flocks) {
    done += 1;
    if (entry.deleted) continue;
    const room = classifyRoom(entry.flockDocId, workspaceId);
    if (room.kind === 'excluded') continue;
    if (room.kind === 'unknown' || room.model !== 'flock') {
      writer.addGap({ id: entry.flockDocId, kind: 'unknown', reason: 'Unknown Flock document' });
      continue;
    }
    await check();
    if (!(await prepare(entry.flockDocId, 'flock'))) continue;
    const flock = await repo.openDetachedFlockDoc(entry.flockDocId);
    await writer.addRoom(
      { id: entry.flockDocId, model: 'flock', codec: room.codec, encoding: room.encoding },
      flock.exportFile()
    );
    input.onProgress?.({ phase: 'flocks', done, total: flocks.length });
  }
  return await writer.finish({ ...input.source, finishedAt: (input.now ?? (() => new Date().toISOString()))() });
}
