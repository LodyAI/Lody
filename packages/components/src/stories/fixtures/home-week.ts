import { createElement, type ReactNode } from 'react';
import { AgentIcon } from '@/components/icons/agent-icon';
import type { AgentConfigCliType } from '@lody/shared';
import type { HomeWeekUsage, HomeWeekUsageSource } from '@/lib/home-week-usage';
import {
  buildHomeWeek,
  type HomeWeekAgent,
  type HomeWeekModel,
  type HomeWeekRow,
} from '@/lib/home-week';
import { buildHomeNow, type HomeNowModel, type HomeNowPr, type HomeNowRow } from '@/lib/home-now';

/** A fixed Friday, so the week in Storybook never drifts with the real calendar. */
export const HOME_WEEK_NOW = new Date(2026, 9, 16, 10, 0, 0);

export type HomeWeekFixtureKind = 'busy' | 'quiet' | 'new';

const at = (daysBack: number, hour: number): number =>
  new Date(2026, 9, 16 - daysBack, hour).getTime();

const row = (
  created: [number, number],
  lastBack: number,
  add: number,
  del: number,
  agentType: string,
  mergedPrs = 0,
  repo: string | null = 'LodyAI/lody'
): HomeWeekRow => ({
  createdAt: at(created[0], created[1]),
  lastAt: at(lastBack, 18),
  add,
  del,
  mergedPrs,
  cliType: 'builtin',
  agentType,
  repo,
});

/** Synthetic rows: made-up work, never a captured session. */
function weekRows(kind: HomeWeekFixtureKind): HomeWeekRow[] {
  if (kind === 'new') return [];
  if (kind === 'quiet') {
    return [row([2, 10], 2, 120, 30, 'claude'), row([1, 15], 1, 60, 12, 'claude')];
  }
  return [
    row([0, 9], 0, 310, 40, 'claude'),
    row([0, 23], 0, 220, 85, 'claude', 1),
    row([1, 11], 1, 540, 120, 'claude', 1),
    row([1, 14], 1, 180, 20, 'codex'),
    row([2, 10], 2, 260, 45, 'claude'),
    row([2, 22], 2, 140, 60, 'codex', 1),
    row([3, 16], 3, 90, 10, 'claude'),
    row([4, 3], 4, 410, 95, 'claude', 0, 'LodyAI/lody'),
    row([4, 13], 4, 160, 30, 'claude'),
    row([5, 12], 5, 70, 8, 'claude', 0, 'LodyAI/site-docs'),
    row([6, 17], 6, 130, 25, 'codex', 0, 'LodyAI/site-docs'),
    row([10, 11], 10, 800, 200, 'claude'),
    row([12, 14], 12, 300, 60, 'claude'),
  ];
}

const dayKey = (back: number): string => {
  const d = new Date(2026, 9, 16 - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Made-up history for the activity wall: a steady pattern with quiet days and lighter weekends,
 * and a busy last week. Deterministic, so a story never changes between renders.
 */
function activity(kind: HomeWeekFixtureKind): [string, number][] {
  if (kind === 'new') return [];
  if (kind === 'quiet') return [dayKey(2), dayKey(1)].map((day) => [day, 1]);
  const days: [string, number][] = [];
  for (let back = 0; back < 200; back += 1) {
    const weekday = (new Date(2026, 9, 16 - back).getDay() + 6) % 7;
    const step = (back * 7 + (back % 5) * 3) % 9;
    let count = step < 3 ? 0 : step - 2;
    if (weekday >= 5) count = Math.floor(count / 2);
    if (back < 7) count = Math.max(count, 2);
    if (count > 0) days.push([dayKey(back), count]);
  }
  return days.sort(([left], [right]) => (left < right ? -1 : 1));
}

export function homeWeekFixture(kind: HomeWeekFixtureKind): HomeWeekModel {
  const days = activity(kind);
  return buildHomeWeek(
    { rows: weekRows(kind), activeDays: days.map(([day]) => day), activity: days },
    HOME_WEEK_NOW
  );
}

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

export function homeWeekAgentLabel(agent: HomeWeekAgent): string {
  return NAMES[agent.agentType] ?? agent.agentType;
}

export function homeWeekAgentIcon(agent: { cliType: string; agentType: string }): ReactNode {
  return createElement(AgentIcon, {
    cliType: agent.cliType as AgentConfigCliType,
    agentType: agent.agentType,
    className: 'size-4',
  });
}

const HOUR_SECONDS = 60 * 60;

/** A Codex plan part-way through its 5-hour and weekly windows, counted from `HOME_WEEK_NOW`. */
export function homeWeekUsageFixture(kind: 'steady' | 'nearReset' = 'steady'): HomeWeekUsage {
  const nowSeconds = HOME_WEEK_NOW.getTime() / 1000;
  return {
    name: null,
    windows: [
      {
        usedPercent: kind === 'nearReset' ? 91 : 38,
        remainingPercent: kind === 'nearReset' ? 9 : 62,
        windowDurationSeconds: 5 * HOUR_SECONDS,
        resetsAtEpochSeconds: nowSeconds + (kind === 'nearReset' ? 0.4 : 2.5) * HOUR_SECONDS,
      },
      {
        usedPercent: kind === 'nearReset' ? 72 : 21,
        remainingPercent: kind === 'nearReset' ? 28 : 79,
        windowDurationSeconds: 7 * 24 * HOUR_SECONDS,
        resetsAtEpochSeconds: nowSeconds + (kind === 'nearReset' ? 20 : 98) * HOUR_SECONDS,
      },
    ],
  };
}

/** The providers a machine can report a plan for; the first is the one the composer has picked. */
export const HOME_WEEK_USAGE_SOURCES: readonly HomeWeekUsageSource[] = [
  { id: 'codex-work', cliType: 'builtin', agentType: 'codex', name: 'Codex' },
  { id: 'claude-main', cliType: 'builtin', agentType: 'claude', name: 'Claude' },
];

const MINUTE_MS = 60_000;

function nowRow(
  id: string,
  title: string,
  minutesAgo: number,
  state: Partial<Pick<HomeNowRow, 'working' | 'waiting' | 'unread' | 'pr'>> = {}
): HomeNowRow {
  return {
    id,
    title,
    cliType: 'builtin',
    agentType: id.length % 2 === 0 ? 'codex' : 'claude',
    lastAt: HOME_WEEK_NOW.getTime() - minutesAgo * MINUTE_MS,
    working: false,
    waiting: false,
    unread: false,
    pr: null,
    ...state,
  };
}

const pr = (number: number, status: HomeNowPr['status'], ci: HomeNowPr['ci'], ready = false) => ({
  pr: { number, status, ci, ready },
});

/** A synthetic afternoon: agents running, two asking for the person, a failed check, drafts. */
export function homeNowFixture(kind: 'busy' | 'quiet' | 'starting' = 'busy'): HomeNowModel {
  if (kind === 'quiet') return buildHomeNow({ rows: [] }, HOME_WEEK_NOW.getTime());
  if (kind === 'starting') {
    // The first agent of the afternoon: the board's quiet card gives way to the lists.
    return buildHomeNow(
      { rows: [nowRow('s-first', 'Refactor presence sync', 1, { working: true })] },
      HOME_WEEK_NOW.getTime()
    );
  }
  const rows: HomeNowRow[] = [
    // Needs you: waiting on a reply.
    nowRow('s-auth', 'Fix token refresh on wake', 2, { waiting: true }),
    nowRow('s-reply-2', 'Reply to the design review', 6, { waiting: true }),
    nowRow('s-reply-3', 'Approve the migration plan', 11, { waiting: true }),
    nowRow('s-reply-4', 'Answer the flaky test question', 18, { waiting: true }),
    nowRow('s-reply-5', 'Confirm the release notes', 25, { waiting: true }),
    nowRow('s-reply-6', 'Unblock the CI permission prompt', 42, { waiting: true }),
    // Needs you: a failed check.
    nowRow('s-ci-1', 'Migrate sidebar rows to StyleX', 40, pr(812, 'open', 'fail')),
    nowRow('s-ci-2', 'Fix the desktop bootstrap race', 55, pr(819, 'open', 'fail')),
    nowRow('s-ci-3', 'Repair session sync on wake', 70, pr(823, 'open', 'fail')),
    nowRow('s-ci-4', 'Resolve type errors in chat landing', 95, pr(827, 'open', 'fail')),
    // Needs you: a draft waiting to be sent.
    nowRow('s-draft-1', 'Week tiles on the new-chat page', 90, pr(820, 'draft', 'pass')),
    nowRow('s-draft-2', 'Paste precedence for images', 300, pr(821, 'draft', 'pending')),
    nowRow('s-draft-3', 'Add the provider import flow', 140, pr(824, 'draft', 'pass')),
    nowRow('s-draft-4', 'Refactor presence sync', 210, pr(828, 'draft', 'pending')),
    // Running.
    nowRow('s-run-1', 'Refactor presence sync', 1, { working: true }),
    nowRow('s-run-2', 'Write the changelog for 0.107', 6, { working: true }),
    nowRow('s-run-3', 'Rebuild the home dashboard', 9, { working: true }),
    nowRow('s-run-4', 'Index the local project files', 14, { working: true }),
    nowRow('s-run-5', 'Sync workspace metadata', 22, { working: true }),
    nowRow('s-run-6', 'Update onboarding copy', 35, { working: true }),
    // Just finished.
    nowRow('s-done-1', 'Docs site landing shader', 12, { unread: true }),
    nowRow('s-done-2', 'Investigate flaky e2e', 55, { unread: true }),
    nowRow('s-done-3', 'Clean up dead code', 75, { unread: true }),
    nowRow('s-done-4', 'Add the Storybook fixture', 100, { unread: true }),
    nowRow('s-done-5', 'Improve the error boundary', 130, { unread: true }),
    // Worth continuing: ready to merge.
    nowRow('s-ready-1', 'Composer focus after menus', 180, pr(799, 'open', 'pass', true)),
    nowRow('s-ready-2', 'Local project removal cleanup', 260, pr(805, 'open', 'pass', true)),
    nowRow('s-ready-3', 'Try the Pi provider import', 340, pr(810, 'open', 'pass', true)),
    nowRow('s-ready-4', 'Add the usage tile', 420, pr(815, 'open', 'pass', true)),
    // Worth continuing: in review.
    nowRow('s-review-1', 'Local project removal cleanup', 600, pr(805, 'open', 'pending')),
    nowRow('s-review-2', 'Review the migration diff', 720, pr(811, 'open', 'pending')),
    nowRow('s-review-3', 'Validate the release notes', 900, pr(816, 'open', 'pending')),
    // Worth continuing: recent.
    nowRow('s-recent-1', 'Try the Pi provider import', 1500),
    nowRow('s-recent-2', 'Explore the codebase', 1800),
    nowRow('s-recent-3', 'Read the README', 2100),
    nowRow('s-recent-4', 'Run the test suite', 2400),
  ];
  return buildHomeNow({ rows }, HOME_WEEK_NOW.getTime());
}
