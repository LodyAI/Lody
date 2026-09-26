import { isSyncingRoomSyncState, type RoomSyncState } from './room-sync-state';

/**
 * What the reader should be told about how current an open conversation is.
 *
 * - `opening`: the local copy (IndexedDB) is still being read, so whether
 *   anything is cached is not known yet. A cached conversation usually appears
 *   within a frame or two; a skeleton now would only flash.
 * - `cold`: the local copy has been read, holds nothing, and the conversation is
 *   known to have messages — show a skeleton instead of a blank pane.
 * - `catching-up`: a cached copy is shown while this open is still actively
 *   catching up with the server — newer messages may still arrive.
 * - `current`: nothing to say.
 *
 * Degraded connections (reconnecting, disconnected, error) deliberately map to
 * `current`: the reconnect loop owns recovery and a "may be out of date" state
 * was removed as noise (docs/sessions-auto-review.md, status slot). A browser
 * that is offline is announced by the info bar's status chip.
 */
export type SessionContentSyncState = 'opening' | 'cold' | 'catching-up' | 'current';

export type SessionContentSyncInput = {
  /** The local copy has been read (its history is readable). */
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
  // A new, genuinely empty conversation must never show a loading skeleton.
  if (!knownToHaveMessages && historyLength === 0) return 'current';
  if (!docReady) return 'opening';
  if (historyLength === 0) return 'cold';
  return isSyncingRoomSyncState(syncState) ? 'catching-up' : 'current';
}
