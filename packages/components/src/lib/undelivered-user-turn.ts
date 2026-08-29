import {
  historyItemsToInputBlocks,
  isSessionHistoryDelivered,
  normalizeSessionInputBlocks,
  type SessionHistoryInput,
  type SessionInputBlock,
} from '@lody/shared';

/**
 * Missing-history negative acknowledgement (`SessionMeta.lastMissingHistoryUserMsgId`)
 * display derivation. The marker permanently excludes its exact turn from every
 * dispatch path; the row surfaces that turn as a clickable "not delivered"
 * label whose confirmation dialog resends the same content as a NEW message —
 * the old turn is never revived.
 */

type UserTurnStatusReadable = Pick<SessionHistoryInput, 'id' | 'role' | 'read' | 'status'>;

/**
 * True when the missing-history marker names this exact entry and the entry is
 * still non-terminal (pending / unseen) — i.e. it visibly never executed.
 * Exact-id match only: a marker naming a different turn must not leak onto
 * unrelated rows, and an entry that later reached a terminal state shows its
 * real outcome instead.
 */
export const isUndeliveredUserTurnEntry = (
  missingHistoryUserMsgId: string | undefined,
  entry: UserTurnStatusReadable | null | undefined
): boolean => {
  if (!missingHistoryUserMsgId || !entry || entry.role !== 'user') {
    return false;
  }
  return entry.id === missingHistoryUserMsgId && !isSessionHistoryDelivered(entry);
};

/**
 * Rebuild the input blocks of an undelivered user turn so its exact content
 * (text, attachment references) can be resent as a NEW message through the
 * ordinary composer send path. Mirrors the CLI's `resolveDispatchTurnInput`
 * block precedence: the turn's canonical `inputConfig.inputBlocks` first
 * (they carry attachment references), then the rendered history items, then
 * the plain prompt string.
 */
export const buildResendInputBlocks = (entry: {
  items?: SessionHistoryInput['items'] | readonly unknown[] | null | undefined;
  inputConfig?: { inputBlocks?: unknown; prompt?: string | undefined } | null | undefined;
}): SessionInputBlock[] => {
  const configuredBlocks = normalizeSessionInputBlocks(entry.inputConfig?.inputBlocks, '');
  if (configuredBlocks.length > 0) {
    return configuredBlocks;
  }
  const historyBlocks = historyItemsToInputBlocks(entry.items);
  if (historyBlocks.length > 0) {
    return historyBlocks;
  }
  return normalizeSessionInputBlocks(undefined, entry.inputConfig?.prompt ?? '');
};
