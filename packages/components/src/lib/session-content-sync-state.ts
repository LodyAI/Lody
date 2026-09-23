import { isSyncingRoomSyncState, type RoomSyncState } from './room-sync-state';

/**
 * What the reader should be told about how current an open conversation is.
 *
 * - `cold`: nothing is cached locally yet and the conversation is known to have
 *   messages — show a skeleton in the content area instead of a blank pane.
 * - `catching-up`: a cached copy is shown while this open is still actively
 *   catching up with the server — newer messages may still arrive.
 * - `current`: nothing to say.
 *
 * Degraded connections (reconnecting, disconnected, error) deliberately map to
 * `current`: the reconnect loop owns recovery and a "may be out of date" state
 * was removed as noise (docs/sessions-auto-review.md, status slot). A browser
 * that is offline is announced by the info bar's status chip.
 */
export type SessionContentSyncState = 'cold' | 'catching-up' | 'current';

export type SessionContentSyncInput = {
  /** The session document has been opened (its history is readable). */
  docReady: boolean;
  /** Turns in the local copy. */
  historyLength: number;
  syncState: RoomSyncState;
  /**
   * This open reached `synced` at least once. Later `syncing` blips are live
   * updates arriving on a current copy, not a stale copy catching up.
   */
  hasCaughtUp: boolean;
  /** Session metadata says the conversation has messages (`lastMessageAt`). */
  knownToHaveMessages: boolean;
};

export function resolveSessionContentSyncState(
  input: SessionContentSyncInput
): SessionContentSyncState {
  const { docReady, historyLength, syncState, hasCaughtUp, knownToHaveMessages } = input;
  if (hasCaughtUp) return 'current';
  if (!docReady || historyLength === 0) {
    // A new, genuinely empty conversation must never show a loading skeleton.
    return knownToHaveMessages ? 'cold' : 'current';
  }
  return isSyncingRoomSyncState(syncState) ? 'catching-up' : 'current';
}
