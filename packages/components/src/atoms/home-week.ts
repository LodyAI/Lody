import { resolveSessionPullRequests } from '@lody/shared';
import { atom } from 'jotai';
import {
  homeWeekDayKey,
  homeWeekInputEqual,
  type HomeWeekInput,
  type HomeWeekRow,
} from '@/lib/home-week';
import { userAtom } from './index';
import { docMetaCacheReadyAtom, sessionMetaCacheAtom } from './doc-meta';

/** Rows older than the two weeks the page compares are not needed. */
const ROW_HORIZON_MS = 15 * 24 * 60 * 60_000;

const EMPTY: HomeWeekInput = { rows: [], activeDays: [] };
let previous: HomeWeekInput = EMPTY;

function toMs(value: string | number | undefined): number | null {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * What the new-chat page's week needs of the signed-in user's root sessions (child tabs
 * fold into their parent and other members' work is not theirs), reduced from the
 * metadata the sidebar already holds. Structurally stable: a running agent rewrites its
 * session metadata constantly, but the rows change only when a number the page shows does.
 */
export const homeWeekInputAtom = atom((get) => {
  const userId = get(userAtom)?.id;
  // Until the session metadata has loaded, a partial cache would show half a week; the
  // tiles read zero instead, and roll up to the real numbers once they are in.
  if (!userId || !get(docMetaCacheReadyAtom)) return EMPTY;

  const horizon = Date.now() - ROW_HORIZON_MS;
  const rows: HomeWeekRow[] = [];
  const activeDays = new Set<string>();
  const activity = new Map<string, number>();

  for (const session of Object.values(get(sessionMetaCacheAtom))) {
    if (session.parentSessionId || session.userId !== userId) continue;
    const createdAt = toMs(session.createdAt);
    if (createdAt == null) continue;
    const lastAt = toMs(session.lastMessageAt) ?? createdAt;

    const createdDay = homeWeekDayKey(createdAt);
    const lastDay = homeWeekDayKey(lastAt);
    activeDays.add(createdDay);
    activeDays.add(lastDay);
    activity.set(createdDay, (activity.get(createdDay) ?? 0) + 1);
    if (lastDay !== createdDay) activity.set(lastDay, (activity.get(lastDay) ?? 0) + 1);
    if (lastAt < horizon && createdAt < horizon) continue;

    const change = session.diffStats?.allChange;
    rows.push({
      createdAt,
      lastAt,
      add: change?.add ?? 0,
      del: change?.del ?? 0,
      mergedPrs: resolveSessionPullRequests(session).filter((pr) => pr.status === 'merged').length,
      cliType: session.cliType,
      agentType: session.agentType,
      repo:
        session.repoFullName ??
        (session.project?.kind === 'github'
          ? session.project.repoFullName
          : session.project?.githubRepoFullName) ??
        null,
    });
  }

  const next: HomeWeekInput = {
    rows: rows.sort(
      (left, right) => left.createdAt - right.createdAt || left.lastAt - right.lastAt
    ),
    activeDays: [...activeDays].sort(),
    activity: [...activity].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  };
  if (homeWeekInputEqual(previous, next)) return previous;
  previous = next;
  return next;
});
