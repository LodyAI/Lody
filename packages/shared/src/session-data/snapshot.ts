import type { StoredHistorySnapshot } from '../history-writer';
import type { SessionTurn } from './domain';
import type { SessionCommandResult } from './types';

/** The writer owns the only provenance registry. Captures are detached from
 * the live document and live as long as the operation holds the handle. */
export type SessionSnapshot = StoredHistorySnapshot;
export interface SessionSnapshotService {
  capture(): Promise<SessionSnapshot>;
  copyFrom(
    snapshot: SessionSnapshot,
    selection: readonly SessionTurn[]
  ): Promise<SessionCommandResult>;
}
