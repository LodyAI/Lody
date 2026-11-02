/**
 * The new-chat page's "now": what the person's agents are doing and what is waiting on them,
 * as four short lists. This module is the arithmetic only; the tiles are
 * `components/chat/home/now-board.tsx` and the rows come from `atoms/home-now.ts`.
 *
 * Every session lands in exactly one list, under the first reason that applies, in this order:
 * waiting on the person, running, CI failed, finished but unread, a draft pull request, a pull
 * request ready to merge, an open pull request, recently active. A running agent is never asked
 * of the person, even when its CI is red: it may be fixing exactly that.
 */

/** What the page needs of one session's latest pull request. */
export type HomeNowPr = {
  number: number | null;
  status: 'open' | 'draft' | 'merged' | 'closed';
  /** CI on the head commit; `null` when unknown. */
  ci: 'pass' | 'fail' | 'pending' | null;
  /** Cleanly mergeable with green (or no) CI. */
  ready: boolean;
};

/** One root session of the signed-in user, with its children's live state rolled in. */
export type HomeNowRow = {
  id: string;
  title: string | null;
  cliType: string;
  agentType: string;
  lastAt: number;
  working: boolean;
  waiting: boolean;
  unread: boolean;
  pr: HomeNowPr | null;
};

export type HomeNowInput = { rows: readonly HomeNowRow[] };

export type HomeNowReason =
  | 'waiting'
  | 'working'
  | 'ciFailed'
  | 'finished'
  | 'draft'
  | 'readyToMerge'
  | 'openPr'
  | 'recent';

export type HomeNowItem = {
  id: string;
  title: string | null;
  cliType: string;
  agentType: string;
  lastAt: number;
  reason: HomeNowReason;
  prNumber: number | null;
};

/** A whole list, most pressing first; how much of it shows is the layout's call. */
export type HomeNowList = { items: HomeNowItem[]; total: number };

export type HomeNowModel = {
  /** Waiting on the person, CI failed, drafts. */
  attention: HomeNowList;
  running: HomeNowList;
  /** Finished since the person last looked. */
  finished: HomeNowList;
  /** Ready to merge, open pull requests, then what was active in the last few days. */
  next: HomeNowList;
};

const REASON_ORDER: readonly HomeNowReason[] = [
  'waiting',
  'working',
  'ciFailed',
  'finished',
  'draft',
  'readyToMerge',
  'openPr',
  'recent',
];

/** A quiet session counts as worth continuing only this long after it was last active. */
export const HOME_NOW_RECENT_MS = 3 * 24 * 60 * 60_000;

export const EMPTY_HOME_NOW_INPUT: HomeNowInput = { rows: [] };

/** Why a session is on the page, or `null` when it is not. */
export function homeNowReason(row: HomeNowRow, nowMs: number): HomeNowReason | null {
  if (row.waiting) return 'waiting';
  if (row.working) return 'working';
  const pr = row.pr && (row.pr.status === 'open' || row.pr.status === 'draft') ? row.pr : null;
  if (pr?.ci === 'fail') return 'ciFailed';
  if (row.unread) return 'finished';
  if (pr?.status === 'draft') return 'draft';
  if (pr?.ready) return 'readyToMerge';
  if (pr) return 'openPr';
  // A session whose pull request is merged or closed is done, not something to pick back up.
  if (row.pr) return null;
  return nowMs - row.lastAt <= HOME_NOW_RECENT_MS ? 'recent' : null;
}

function list(items: HomeNowItem[]): HomeNowList {
  items.sort(
    (left, right) =>
      REASON_ORDER.indexOf(left.reason) - REASON_ORDER.indexOf(right.reason) ||
      right.lastAt - left.lastAt
  );
  return { items, total: items.length };
}

export function buildHomeNow(input: HomeNowInput, nowMs: number): HomeNowModel {
  const attention: HomeNowItem[] = [];
  const running: HomeNowItem[] = [];
  const finished: HomeNowItem[] = [];
  const next: HomeNowItem[] = [];
  for (const row of input.rows) {
    const reason = homeNowReason(row, nowMs);
    if (!reason) continue;
    const item: HomeNowItem = {
      id: row.id,
      title: row.title,
      cliType: row.cliType,
      agentType: row.agentType,
      lastAt: row.lastAt,
      reason,
      prNumber: row.pr?.number ?? null,
    };
    if (reason === 'waiting' || reason === 'ciFailed' || reason === 'draft') attention.push(item);
    else if (reason === 'working') running.push(item);
    else if (reason === 'finished') finished.push(item);
    else next.push(item);
  }
  return {
    attention: list(attention),
    running: list(running),
    finished: list(finished),
    next: list(next),
  };
}

function prEqual(left: HomeNowPr | null, right: HomeNowPr | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.number === right.number &&
    left.status === right.status &&
    left.ci === right.ci &&
    left.ready === right.ready
  );
}

/** Structural equality, so the atom keeps its reference while nothing the page shows changed. */
export function homeNowInputEqual(left: HomeNowInput, right: HomeNowInput): boolean {
  if (left.rows.length !== right.rows.length) return false;
  return left.rows.every((row, index) => {
    const other = right.rows[index]!;
    return (
      row.id === other.id &&
      row.title === other.title &&
      row.cliType === other.cliType &&
      row.agentType === other.agentType &&
      row.lastAt === other.lastAt &&
      row.working === other.working &&
      row.waiting === other.waiting &&
      row.unread === other.unread &&
      prEqual(row.pr, other.pr)
    );
  });
}
