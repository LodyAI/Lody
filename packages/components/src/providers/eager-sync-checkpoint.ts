import { VersionVector, type LoroDoc } from 'loro-crdt';
import type { RemoteCursor } from '@loro-dev/streams-crdt';
import type { ResilientRemoteCursorStore } from './resilient-remote-cursor-store';
import type { EagerSyncSnapshot } from './eager-sync-snapshot-cache';

function decodeVersion(value: unknown): VersionVector | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const entries = Object.entries(value);
  if (
    !entries.every(
      ([peer, counter]) =>
        /^\d+$/.test(peer) &&
        typeof counter === 'number' &&
        Number.isSafeInteger(counter) &&
        counter >= 0
    )
  )
    return;
  try {
    return new VersionVector(new Map(entries as Array<[`${number}`, number]>));
  } catch {
    return;
  }
}

/** Replay progress is usable only with the replica state it certifies. */
export function coveredEagerSyncCursor(
  entry: EagerSyncSnapshot | undefined,
  scope: string,
  roomId: string,
  streamUrl: string,
  doc: LoroDoc
): RemoteCursor | undefined {
  if (entry?.scope !== scope || entry.roomId !== roomId || entry.plane !== 'cloud') return;
  const checkpoint = entry.cloudCheckpoint;
  if (checkpoint?.format !== 1) return;
  const cursor = checkpoint.cursor;
  if (
    cursor?.streamUrl !== streamUrl ||
    typeof cursor.nextOffset !== 'string' ||
    !cursor.nextOffset ||
    !Number.isFinite(cursor.updatedAtMs)
  )
    return;
  const lower = decodeVersion(cursor.serverLowerBoundVersion);
  const snapshotVersion = decodeVersion(checkpoint.snapshotVersion);
  if (!lower || !snapshotVersion || doc.exportPendingUpdates() !== undefined) return;
  const snapshotOrder = snapshotVersion.compare(lower);
  const docOrder = doc.oplogVersion().compare(snapshotVersion);
  if ((snapshotOrder === 0 || snapshotOrder === 1) && (docOrder === 0 || docOrder === 1))
    return cursor;
}

/** Called only for a cold, storage-loaded document after its merge is durable. */
export async function adoptEagerSyncCheckpoint(
  entry: EagerSyncSnapshot | undefined,
  scope: string,
  roomId: string,
  streamUrl: string,
  doc: LoroDoc,
  store: Pick<ResilientRemoteCursorStore, 'saveIfAbsent'>
): Promise<void> {
  const cursor = coveredEagerSyncCursor(entry, scope, roomId, streamUrl, doc);
  if (!cursor) return;
  await store.saveIfAbsent(cursor);
}
