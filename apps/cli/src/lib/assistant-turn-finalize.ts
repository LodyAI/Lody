import type { SessionHistoryInput } from '@lody/shared';

/**
 * Stamp the terminal footprint (`finished`/`endedAt`/`permissionWaitMs`) on the
 * assistant entry a finalize call owns. Extracted from `finalizeACPState` so the
 * one rule that matters here is testable: a terminal stamp is written once.
 *
 * `finalizeACPState` has a no-turnId overload used by teardown/cancel paths
 * (session `exit`/`terminated`, error, cleanup). Those callers only check that
 * transient state exists, so on app close they run for sessions whose turn ended
 * long ago — and the loop matched the last assistant entry regardless of state,
 * re-stamping `endedAt = now`. The renderer derives "Worked for …" from
 * `endedAt - timestamp`, so every close inflated a finished turn's duration by
 * the wall-clock time the app stayed open.
 *
 * Skipping an already-finished entry (rather than filling in a missing
 * `endedAt`) is deliberate: `createAssistantImageGroupEntry` and
 * `createAssistantFileEntry` publish assistant entries with `finished: true` and
 * no `endedAt`, so an `endedAt`-only guard would still stamp `now` on an entry
 * that finished whenever it finished. No duration is the honest answer there.
 *
 * A turn genuinely still running is never finished: the teardown stamp on an
 * interrupted turn still lands, and resume clears the footprint through
 * `writeAssistantEntryForTurn`'s reopen branch before streaming into the entry
 * again. See `apps/cli/src/session/AGENTS.md`.
 */
export const markAssistantTurnFinished = (
  history: SessionHistoryInput[],
  options: {
    /** Finalize the entry with this id; absent means "whichever turn is open". */
    turnId?: string | undefined;
    endedAt: number;
    permissionWaitMs?: number | undefined;
  }
): SessionHistoryInput[] => {
  const { turnId, endedAt, permissionWaitMs } = options;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && entry.role === 'assistant' && (!turnId || entry.id === turnId)) {
      // Already finalized: its terminal timing is the truth, not this call's clock.
      if (entry.finished === true) break;
      entry.finished = true;
      entry.endedAt = endedAt;
      if (permissionWaitMs !== undefined) {
        entry.permissionWaitMs = permissionWaitMs;
      }
      break;
    }
  }
  return history;
};
