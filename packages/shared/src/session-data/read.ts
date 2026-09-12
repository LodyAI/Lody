import { normalizeSessionTurnInputConfig } from '../message-schemas';
import type { SessionEntry } from './domain';
import type { SessionHistoryReader, SessionTurn } from './types';
/** Read the latest matching body after scanning only directory scalars. */
export async function readLatestTurn(
  reader: SessionHistoryReader,
  role: SessionTurn['role']
): Promise<SessionTurn | undefined> {
  const rows = await reader.readDirectory(0, await reader.count());
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row?.turnId || row.scalars?.role !== role) continue;
    const read = await reader.readTurn(row.turnId);
    if (read.state === 'ready' && read.turn.role === role) return read.turn;
  }
  return undefined;
}

/** Legacy business projection. Keep the authoritative readAll/snapshot unchanged
 * for export and hashes; dispatch consumers normalize their input configuration.
 * Invalid raw slots are skipped here, never removed from stored history. */
export async function readSessionHistory(reader: SessionHistoryReader): Promise<SessionEntry[]> {
  const snapshot: readonly unknown[] = await reader.readAll();
  return snapshot
    .filter(
      (entry): entry is SessionEntry =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    )
    .map((entry) => ({
      ...entry,
      inputConfig: normalizeSessionTurnInputConfig(entry.inputConfig),
    }));
}
