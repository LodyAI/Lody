import type { SessionHistoryParsed } from '@lody/shared';

/**
 * Wall-clock span minus time spent waiting on permission, when that wait was
 * recorded. Schema: effective work = (endedAt - timestamp) - permissionWaitMs.
 * A missing wait field is treated as 0 so turns without a permission card
 * stay endedAt - timestamp.
 */
export const resolveSessionHistoryDurationMs = (
  message: Pick<SessionHistoryParsed, 'endedAt' | 'timestamp' | 'permissionWaitMs'>
): number | null => {
  const endedAt = message.endedAt;
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt)) return null;

  const parsed = Date.parse(message.timestamp);
  if (!Number.isFinite(parsed)) return null;

  if (endedAt < parsed) return null;
  const span = endedAt - parsed;
  const wait = message.permissionWaitMs;
  if (typeof wait !== 'number' || !Number.isFinite(wait) || wait <= 0) return span;
  return Math.max(0, span - wait);
};
