import type { MessageContent } from '../ai';

import type { SessionEntry as SessionHistoryInput } from './domain';

/**
 * Settle the context-compaction markers a finishing turn leaves open.
 *
 * A `context_compaction` tool call is synthetic: the ACP adapter mints it from
 * the provider's compaction signals, and nothing but a later notification for
 * the same `toolCallId` can move it to a terminal status. Once the owning turn
 * is over no such notification is coming, so a marker left `pending`/
 * `in_progress` spins forever in the conversation.
 *
 * Two shapes reach this point, and they need opposite treatment:
 *
 * - **Superseded** — another compaction marker follows it in the same entry.
 *   The adapter minted a fresh `toolCallId` for a compaction that was already
 *   in flight (Claude Code repeats `status: "compacting"` while one compaction
 *   runs; the Kimi server re-opens on every `compaction.started`), so every
 *   marker but the last is a duplicate identity for the same episode. History
 *   merges tool calls by id, so each duplicate renders as its own row — which
 *   is how one compaction surfaced as n stacked "Compacting context" spinners.
 *   Drop them: the surviving marker carries the episode's real outcome, and a
 *   duplicate that never reported one has nothing of its own to say.
 * - **Trailing** — nothing follows it. The compaction genuinely never reported
 *   an outcome (cancel, provider error, a dropped notification stream), so
 *   `failed` is the honest terminal status.
 *
 * Adapters are versioned and shipped independently of the host, so this runs
 * unconditionally rather than only on the paths that already know the provider
 * failed: a marker still open on a finished turn is stale regardless of why.
 */
const settleContextCompactionMarkers = (items: MessageContent[]): MessageContent[] | undefined => {
  let lastMarkerIndex = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === 'tool_call' && item.activityKind === 'context_compaction') {
      lastMarkerIndex = i;
      break;
    }
  }
  if (lastMarkerIndex < 0) return undefined;

  let changed = false;
  const settled: MessageContent[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (
      item.type !== 'tool_call' ||
      item.activityKind !== 'context_compaction' ||
      (item.status !== 'pending' && item.status !== 'in_progress')
    ) {
      settled.push(item);
      continue;
    }
    changed = true;
    // Superseded duplicates are dropped; only the last marker is settled.
    if (i === lastMarkerIndex) settled.push({ ...item, status: 'failed' as const });
  }
  return changed ? settled : undefined;
};

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
    force?: boolean;
  }
): SessionHistoryInput[] => {
  const { turnId, endedAt, permissionWaitMs } = options;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && entry.role === 'assistant' && (!turnId || entry.id === turnId)) {
      // A terminal turn cannot retain an actionable question. The existing
      // history subscription releases its permission waiter from this outcome.
      for (const item of entry.items ?? []) {
        if (
          item.type === 'tool_call' &&
          item.permissionRequest &&
          !item.permissionRequest.outcome
        ) {
          item.permissionRequest = { ...item.permissionRequest, outcome: { outcome: 'cancelled' } };
        }
      }
      if (entry.items) {
        const settled = settleContextCompactionMarkers(entry.items);
        if (settled) entry.items = settled;
      }
      // Already finalized: its terminal timing is the truth, not this call's clock.
      if (entry.finished === true && !options.force) break;
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
