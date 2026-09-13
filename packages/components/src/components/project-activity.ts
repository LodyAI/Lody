const activityStatuses = ['permission', 'unread', 'active'] as const;
const sessionStatusPriority = ['permission', 'active', 'unread'] as const;
type ProjectActivityStatus = (typeof activityStatuses)[number];
export type ProjectActivityCounts = Record<ProjectActivityStatus, number> & {
  sessionIds: Record<ProjectActivityStatus, string[]>;
};
type ProjectActivitySource = {
  sessionId: string;
  isWaitingPermission?: boolean;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
  projectActivityCounts?: ProjectActivityCounts;
};

export function getProjectActivityCounts(sessions: ProjectActivitySource[]): ProjectActivityCounts {
  const ids = Object.fromEntries(
    activityStatuses.map((status) => [status, new Set<string>()])
  ) as Record<ProjectActivityStatus, Set<string>>;
  for (const session of sessions) {
    if (session.projectActivityCounts) {
      for (const status of activityStatuses) {
        session.projectActivityCounts.sessionIds[status].forEach((id) => ids[status].add(id));
      }
      continue;
    }
    const id = session.sessionId;
    if (session.isWaitingPermission) ids.permission.add(id);
    if (session.hasUnreadMessages) ids.unread.add(id);
    if (session.isWorking && !session.isWaitingPermission) ids.active.add(id);
  }
  // A single Session is represented by its highest-priority state. The
  // project row still uses unread before active when choosing its first slot.
  const ownerById = new Map<string, (typeof sessionStatusPriority)[number]>();
  for (const status of sessionStatusPriority) {
    for (const id of ids[status]) {
      if (!ownerById.has(id)) ownerById.set(id, status);
    }
  }
  for (const status of activityStatuses) {
    ids[status] = new Set([...ids[status]].filter((id) => ownerById.get(id) === status));
  }
  return {
    permission: ids.permission.size,
    unread: ids.unread.size,
    active: ids.active.size,
    sessionIds: Object.fromEntries(
      activityStatuses.map((status) => [status, [...ids[status]]])
    ) as Record<ProjectActivityStatus, string[]>,
  };
}

export function getProjectActivityItems(counts: ProjectActivityCounts) {
  const first = activityStatuses.find((status) => counts[status] > 0);
  if (!first) return [];
  const represented = new Set(counts.sessionIds[first]);
  const primary = { status: first, count: represented.size };
  // Exclude primary Sessions before choosing secondary types or counting their union.
  const remaining = activityStatuses
    .map((status) => ({
      status,
      ids: counts.sessionIds[status].filter((id) => !represented.has(id)),
    }))
    .filter(({ ids }) => ids.length > 0);
  const items = remaining.map(({ status, ids }) => ({ status, count: ids.length }));
  if (items.length < 2) return [primary, ...items];
  const count = new Set(remaining.flatMap(({ ids }) => ids)).size;
  return [primary, { status: 'more' as const, count }];
}
