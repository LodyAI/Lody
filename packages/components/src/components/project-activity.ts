export type ProjectActivityCounts = { permission: number; unread: number; active: number };
type ProjectActivitySource = {
  isWaitingPermission?: boolean;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
  projectActivityCounts?: ProjectActivityCounts;
};

export function getProjectActivityCounts(sessions: ProjectActivitySource[]): ProjectActivityCounts {
  const counts = { permission: 0, unread: 0, active: 0 };
  for (const session of sessions) {
    const current = session.projectActivityCounts ?? {
      permission: Number(Boolean(session.isWaitingPermission)),
      unread: Number(Boolean(session.hasUnreadMessages)),
      active: Number(Boolean(session.isWorking && !session.isWaitingPermission)),
    };
    counts.permission += current.permission;
    counts.unread += current.unread;
    counts.active += current.active;
  }
  return counts;
}

export function getProjectActivityItems(counts: ProjectActivityCounts) {
  const items = (['permission', 'unread', 'active'] as const)
    .map((status) => ({ status, count: counts[status] }))
    .filter(({ count }) => count > 0);
  return items.length < 3
    ? items
    : [items[0]!, { status: 'more' as const, count: items[1]!.count + items[2]!.count }];
}
