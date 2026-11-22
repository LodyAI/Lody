import type { SessionMeta, SessionStatus } from '@lody/shared';
import { formatSnoozeCountdown, statusViewTier, type StatusViewTier } from '@lody/shared';
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';

/** The one leading icon a mention shows, in priority order. */
export type TodaySessionState = 'waiting' | 'running' | 'later' | 'done' | 'unread' | 'idle';

export type TodaySessionDisplay =
  | { state: 'loading' }
  | { state: 'missing' }
  | {
      state: 'ok';
      title: string;
      status: TodaySessionState;
      /** The sidebar's status group: Move to Focus is offered from Later and Settled. */
      group: StatusViewTier;
      /** Has unread output (agent-managed sessions never do): the menu offers Mark as read. */
      unread: boolean;
      lastMessageAt: number | null;
      /** The sidebar's wake-up countdown while Later, e.g. `2h`. */
      snoozeCountdown: string | null;
    };

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * What a conversation mention shows, from the same signals as the sidebar row:
 * live presence for running/waiting, `statusViewTier` for Later and
 * Settled, read receipts for unread (hidden for agent-managed sessions), and
 * archive. Priority: waiting > running > later > done > unread > idle.
 * Metadata absence means deleted or no access only once the metadata
 * projection has settled.
 * Behavior: specs/today-outline.md (Conversation mentions).
 */
export function todaySessionDisplay(input: {
  meta: SessionMeta | undefined;
  metaSettled: boolean;
  live: SessionStatus | null;
  nowMs: number;
}): TodaySessionDisplay {
  const { meta, live, nowMs } = input;
  if (!meta) return { state: input.metaSettled ? 'missing' : 'loading' };
  const extra = meta as SessionMeta & { agentManaged?: unknown };
  const waiting = live?.type === 'requestPermission';
  const running = live != null;
  const lastMessageAt = finite(meta.lastMessageAt);
  const snoozedUntil = finite(meta.snoozedUntil);
  const group = statusViewTier(
    {
      activityAt: lastMessageAt,
      isWorking: running,
      isWaitingPermission: waiting,
      snoozedUntil,
      settledAt: finite(meta.settledAt),
      focusRestoredAt: finite(meta.focusRestoredAt),
    },
    nowMs
  );
  const unread = extra.agentManaged !== true && sessionHasUnreadMessages(meta, nowMs);
  const status: TodaySessionState = waiting
    ? 'waiting'
    : running
      ? 'running'
      : group === 'later'
        ? 'later'
        : meta.isArchived === true || group === 'settled'
          ? 'done'
          : unread
            ? 'unread'
            : 'idle';
  return {
    state: 'ok',
    title: meta.title?.trim() || '',
    status,
    group,
    unread,
    lastMessageAt,
    snoozeCountdown:
      status === 'later' && snoozedUntil !== null
        ? formatSnoozeCountdown(snoozedUntil, nowMs)
        : null,
  };
}
