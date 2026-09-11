const activityStatuses = ['permission', 'unread', 'active'] as const;
type ProjectActivityStatus = (typeof activityStatuses)[number];
export type ProjectActivityCounts = Record<ProjectActivityStatus, number> & {
  sessionIds?: Record<ProjectActivityStatus, string[]>;
};
type ProjectActivitySource = {
  sessionId?: string;
  isWaitingPermission?: boolean;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
  projectActivityCounts?: ProjectActivityCounts;
};

export function getProjectActivityCounts(sessions: ProjectActivitySource[]): ProjectActivityCounts {
  const ids = Object.fromEntries(
    activityStatuses.map((status) => [status, new Set<string>()])
  ) as Record<ProjectActivityStatus, Set<string>>;
  for (const [sourceIndex, session] of sessions.entries()) {
    if (session.projectActivityCounts) {
      for (const status of activityStatuses) {
        const nestedIds = session.projectActivityCounts.sessionIds?.[status];
        if (nestedIds) nestedIds.forEach((id) => ids[status].add(id));
        else
          for (let index = 0; index < session.projectActivityCounts[status]; index++)
            ids[status].add(`${sourceIndex}:${status}:${index}`);
      }
      continue;
    }
    const id = session.sessionId ?? String(sourceIndex);
    if (session.isWaitingPermission) ids.permission.add(id);
    if (session.hasUnreadMessages) ids.unread.add(id);
    if (session.isWorking && !session.isWaitingPermission) ids.active.add(id);
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
  const items = activityStatuses
    .map((status) => ({ status, count: counts[status] }))
    .filter(({ count }) => count > 0);
  if (items.length < 2) return items;
  if (!counts.sessionIds)
    return items.length < 3
      ? items
      : [items[0]!, { status: 'more' as const, count: items[1]!.count + items[2]!.count }];
  const primaryIds = new Set(counts.sessionIds[items[0]!.status]);
  const remaining = items
    .slice(1)
    .map(({ status }) => {
      const sessionIds = counts.sessionIds![status].filter((id) => !primaryIds.has(id));
      return { status, count: sessionIds.length, sessionIds };
    })
    .filter(({ sessionIds }) => sessionIds.length > 0);
  if (remaining.length < 2)
    return [items[0]!, ...remaining.map(({ status, count }) => ({ status, count }))];
  return [
    items[0]!,
    {
      status: 'more' as const,
      count: new Set(remaining.flatMap(({ sessionIds }) => sessionIds)).size,
    },
  ];
}
