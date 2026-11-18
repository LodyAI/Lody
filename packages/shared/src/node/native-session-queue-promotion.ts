import type { SessionHistoryInput } from '@lody/shared';
import type {
  SessionBackend,
  QueuePromotionInput,
  QueuePromotionResult,
} from './native-session-contract';
type PromotionBackend = Pick<
  SessionBackend,
  | 'getQueueOperationId'
  | 'getQueuePromotionRecord'
  | 'setQueuePromotionRecord'
  | 'readTurn'
  | 'publishUserTurnActivation'
  | 'removeMessageQueueItem'
>;
/** Shared legacy/native dispatch receipt sequence. A rejected receipt never
 * becomes proof of delivery; history witnesses an accepted append on retry. */
export async function promoteSessionQueuedTurn(
  backend: PromotionBackend,
  appendHistory: (entry: SessionHistoryInput) => Promise<void>,
  input: QueuePromotionInput,
  now: () => number = Date.now
): Promise<QueuePromotionResult> {
  const { item, entry, operationId } = input;
  if (operationId !== backend.getQueueOperationId(item)) {
    throw new Error(`Queue promotion operation does not match queue row ${item.$cid}`);
  }
  if (entry.role !== 'user' || entry.id.trim().length === 0 || entry.id !== entry.id.trim()) {
    throw new Error(`Queue promotion requires a user entry with a stable id`);
  }

  const prior = await backend.getQueuePromotionRecord(operationId);
  let existing =
    input.existingEntry?.role === 'user' && input.existingEntry.id === entry.id
      ? input.existingEntry
      : undefined;
  if (!existing) {
    const read = await backend.readTurn(entry.id);
    existing =
      read.state === 'ready' && read.turn.role === 'user'
        ? (read.turn as SessionHistoryInput)
        : undefined;
  }
  const alreadyAccepted =
    existing !== undefined ||
    prior?.state === 'history_accepted' ||
    prior?.state === 'activation_published' ||
    prior?.state === 'queue_consumed';

  if (!alreadyAccepted) {
    let preparedReceiptError: unknown;
    try {
      await backend.setQueuePromotionRecord(operationId, {
        queueCid: item.$cid,
        userTurnId: entry.id,
        state: 'prepared',
        updatedAt: now(),
      });
    } catch (error) {
      // History is itself an exact idempotency witness. If the control-plane
      // receipt is temporarily unavailable, still accept the turn once so a
      // retry can discover that precise row instead of losing the queue item.
      preparedReceiptError = error;
    }
    await appendHistory(entry);
    if (preparedReceiptError) throw preparedReceiptError;
    await backend.setQueuePromotionRecord(operationId, {
      queueCid: item.$cid,
      userTurnId: entry.id,
      state: 'history_accepted',
      updatedAt: now(),
    });
  }

  // Activation is deliberately replayable. If the process died after the
  // history commit, this write repairs the pointer before consuming the row.
  await backend.publishUserTurnActivation(entry.id);
  await backend.setQueuePromotionRecord(operationId, {
    queueCid: item.$cid,
    userTurnId: entry.id,
    state: 'activation_published',
    updatedAt: now(),
  });
  await backend.removeMessageQueueItem(item.$cid);
  await backend.setQueuePromotionRecord(operationId, {
    queueCid: item.$cid,
    userTurnId: entry.id,
    state: 'queue_consumed',
    updatedAt: now(),
  });

  return {
    status: alreadyAccepted ? 'already-applied' : 'applied',
    operationId,
    entry: existing ?? entry,
  };
}
