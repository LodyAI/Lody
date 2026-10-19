import { atom } from 'jotai';
import { findFreshSessionPresenceState, type SessionMeta, type SessionStatus } from '@lody/shared';
import {
  getEffectiveSessionActivitySummary,
  getLatestPullRequestInfo,
} from '@/components/sessions/session-list-rows';
import {
  EMPTY_HOME_NOW_INPUT,
  homeNowInputEqual,
  type HomeNowInput,
  type HomeNowPr,
  type HomeNowRow,
} from '@/lib/home-now';
import { userAtom } from './index';
import { docMetaCacheReadyAtom, sessionMetaCacheAtom } from './doc-meta';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from './presence';

/** Quiet sessions older than this cannot be on the page, so they are not carried. */
const ROW_HORIZON_MS = 14 * 24 * 60 * 60_000;

let previous: HomeNowInput = EMPTY_HOME_NOW_INPUT;

function toMs(value: string | number | undefined): number | null {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function latestPr(session: SessionMeta): HomeNowPr | null {
  const info = getLatestPullRequestInfo(session);
  if (!info.url || !info.status) return null;
  return {
    number: info.number,
    status: info.status,
    ci:
      info.ciState === 's'
        ? 'pass'
        : info.ciState === 'f' || info.ciState === 'e'
          ? 'fail'
          : info.ciState === 'p' || info.ciState === 'x'
            ? 'pending'
            : null,
    ready: info.readiness === 'y',
  };
}

/**
 * What the new-chat page's "now" needs of the signed-in user's open root sessions: live state
 * from presence (a child tab's running or waiting agent counts for its parent, as in the
 * sidebar), unread output, and the latest pull request. It reads presence, which ticks, but
 * keeps its previous reference until a row the page shows changes, so the tiles re-render only
 * then.
 */
export const homeNowInputAtom = atom((get) => {
  const userId = get(userAtom)?.id;
  if (!userId || !get(docMetaCacheReadyAtom)) return EMPTY_HOME_NOW_INPUT;

  const presence = get(lodyPresenceStatesAtom);
  const nowMs = get(lodyPresenceNowMsAtom);
  const sessions = Object.values(get(sessionMetaCacheAtom));
  const children = new Map<string, SessionMeta[]>();
  const live = new Map<string, SessionStatus>();
  for (const session of sessions) {
    if (session.parentSessionId) {
      const siblings = children.get(session.parentSessionId) ?? [];
      siblings.push(session);
      children.set(session.parentSessionId, siblings);
    }
    const status = findFreshSessionPresenceState(presence, session.id, nowMs)?.status;
    if (status) live.set(session.id, status);
  }

  const horizon = nowMs - ROW_HORIZON_MS;
  const rows: HomeNowRow[] = [];
  for (const session of sessions) {
    if (session.parentSessionId || session.userId !== userId) continue;
    if (session.isArchived || session.isTabClosed) continue;
    const activity = getEffectiveSessionActivitySummary(session, children, live);
    const lastAt = activity.latestMessageAt || toMs(session.createdAt) || 0;
    if (!activity.isWorking && !activity.isWaitingPermission && lastAt < horizon) continue;
    rows.push({
      id: session.id,
      title: session.title?.trim() || null,
      cliType: session.cliType,
      agentType: session.agentType,
      lastAt,
      working: activity.isWorking,
      waiting: activity.isWaitingPermission,
      unread: activity.hasUnreadMessages,
      pr: latestPr(session),
    });
  }

  const next: HomeNowInput = {
    rows: rows.sort((left, right) => right.lastAt - left.lastAt || (left.id < right.id ? -1 : 1)),
  };
  if (homeNowInputEqual(previous, next)) return previous;
  previous = next;
  return next;
});
