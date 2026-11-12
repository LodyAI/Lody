import type {
  PrStatus,
  SessionPullRequestCiState,
  SessionPullRequestReadiness,
} from '@lody/shared';
import { homeNowReason, type HomeNowPr, type HomeNowReason } from '@/lib/home-now';

/**
 * The sidebar's "Status" groups in display order, matching the native mobile Home's status view
 * (iOS `HomeStatusGroup`). Classification is the new-chat page's (`homeNowReason`), so a session
 * sits under the same reason everywhere; running sessions list just above idle ones, after the
 * groups that need a look.
 */
export const SIDEBAR_STATUS_GROUPS = [
  'attention',
  'finished',
  'pullRequest',
  'running',
  'idle',
] as const;

export type SidebarStatusGroup = (typeof SIDEBAR_STATUS_GROUPS)[number];

/** What classification needs of one sidebar row; its children's live state is already rolled in. */
export type SidebarStatusGroupInput = {
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  hasUnreadMessages?: boolean;
  prStatus?: PrStatus | null;
  prCiState?: SessionPullRequestCiState | null;
  prReadiness?: SessionPullRequestReadiness | null;
};

const GROUP_BY_REASON: Record<HomeNowReason, SidebarStatusGroup> = {
  waiting: 'attention',
  ciFailed: 'attention',
  draft: 'attention',
  working: 'running',
  finished: 'finished',
  readyToMerge: 'pullRequest',
  openPr: 'pullRequest',
  recent: 'idle',
};

function toHomeNowPr(input: SidebarStatusGroupInput): HomeNowPr | null {
  if (!input.prStatus) return null;
  const ci = input.prCiState;
  return {
    number: null,
    status: input.prStatus,
    ci:
      ci === 's'
        ? 'pass'
        : ci === 'f' || ci === 'e'
          ? 'fail'
          : ci === 'p' || ci === 'x'
            ? 'pending'
            : null,
    ready: input.prReadiness === 'y',
  };
}

/**
 * Every row lands in exactly one group. Rows the new-chat page leaves out (quiet for days, or
 * whose pull request is merged or closed) are idle here: the sidebar lists every session.
 */
export function sidebarStatusGroup(input: SidebarStatusGroupInput): SidebarStatusGroup {
  const reason = homeNowReason(
    {
      id: '',
      title: null,
      cliType: '',
      agentType: '',
      // Recency only separates "recent" from "left out", which are both idle here.
      lastAt: 0,
      working: Boolean(input.isWorking),
      waiting: Boolean(input.isWaitingPermission),
      unread: Boolean(input.hasUnreadMessages),
      pr: toHomeNowPr(input),
    },
    0
  );
  return reason ? GROUP_BY_REASON[reason] : 'idle';
}
