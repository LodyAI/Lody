import type { SessionMeta, SessionStatus } from '@lody/shared';
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';

export type TodaySessionDisplay =
  | { state: 'loading' }
  | { state: 'missing' }
  | {
      state: 'ok';
      title: string;
      waiting: boolean;
      working: boolean;
      unread: boolean;
      /** Settled or archived: drawn like a finished to-do. */
      done: boolean;
    };

/**
 * What a session node shows, from the same signals as the sidebar row: live
 * presence for running/waiting, read receipts for unread (hidden for
 * agent-managed sessions), archive and settle for done. Metadata absence means
 * deleted or no access only once the metadata projection has settled.
 * Behavior: specs/today-outline.md (Session nodes).
 */
export function todaySessionDisplay(input: {
  meta: SessionMeta | undefined;
  metaSettled: boolean;
  live: SessionStatus | null;
}): TodaySessionDisplay {
  const { meta, live } = input;
  if (!meta) return { state: input.metaSettled ? 'missing' : 'loading' };
  const extra = meta as SessionMeta & { settledAt?: unknown; agentManaged?: unknown };
  const lastMessageAt = typeof meta.lastMessageAt === 'number' ? meta.lastMessageAt : 0;
  const settled = typeof extra.settledAt === 'number' && extra.settledAt >= lastMessageAt;
  return {
    state: 'ok',
    title: meta.title?.trim() || '',
    waiting: live?.type === 'requestPermission',
    working: live != null,
    unread: extra.agentManaged !== true && sessionHasUnreadMessages(meta),
    done: meta.isArchived === true || settled,
  };
}
