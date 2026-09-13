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

/** Adapter-side selection for a consistent output observation. `scalars` never
 * reads items; only the selected assistant (and failure notices) needs a body. */
export function selectTurnOutput(
  count: number,
  userTurnId: string,
  scalars: (index: number) => import('./domain').SessionDirectoryScalars | undefined,
  body: (index: number) => SessionEntry | undefined
): SessionEntry[] {
  for (let i = 0; i < count; i++) {
    const user = scalars(i);
    if (user?.id !== userTurnId || user.role !== 'user') continue;
    const selected: SessionEntry[] = [{ ...user, role: 'user', items: [], fileDiff: [] }];
    let assistantFound = false;
    for (let j = i + 1; j < count; j++) {
      const row = scalars(j);
      const assistant =
        !assistantFound && row?.role === 'assistant' && row.userTurnId === userTurnId;
      if (assistant || (user.status === 'failed' && row?.role === 'system')) {
        const turn = body(j);
        if (turn) selected.push(turn);
        if (assistant) assistantFound = true;
      }
      if (assistantFound && user.status !== 'failed') break;
    }
    return selected;
  }
  return [];
}
