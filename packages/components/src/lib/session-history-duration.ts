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

/**
 * The same quantity for a turn that has NOT ended yet: wall clock since the
 * turn's start, minus the permission wait recorded so far. Callers pass `nowMs`
 * (rather than reading the clock here) so the value ticks from one shared timer
 * and stays testable.
 *
 * Unlike the finished form this clamps instead of returning null when the start
 * is in the future — a machine clock running ahead should print `0s` in the
 * slot, not leave it blank, since the slot's whole job is to be occupied.
 *
 * `permissionWaitMs` is read for symmetry but is absent on a live entry: the CLI
 * keeps the running wait in its transient store and writes the field through
 * `finish-assistant`. So a turn that waited on permission reads HIGH here by the
 * length of the wait, and steps down when the finished label takes over.
 */
export const resolveLiveSessionHistoryDurationMs = (
  message: Pick<SessionHistoryParsed, 'timestamp' | 'permissionWaitMs'>,
  nowMs: number
): number | null => {
  const startedAt = Date.parse(message.timestamp);
  if (!Number.isFinite(startedAt) || !Number.isFinite(nowMs)) return null;

  const span = Math.max(0, nowMs - startedAt);
  const wait = message.permissionWaitMs;
  if (typeof wait !== 'number' || !Number.isFinite(wait) || wait <= 0) return span;
  return Math.max(0, span - wait);
};
