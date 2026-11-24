import type { SessionMeta } from '@lody/shared';
import type { SessionSummary, ScopeTarget, PluginScope, lodyQueries } from '@lody/plugin-sdk';
import { eventRefs } from './session-events';
export function summarizeSession(
  workspaceId: string,
  s: SessionMeta,
  account: string | null,
  online: boolean
): SessionSummary {
  const { session, project } = eventRefs(workspaceId, s);
  const createdAt = Date.parse(s.createdAt);
  return {
    session,
    project,
    title: s.title ?? '',
    status: s.collaborationStopped
      ? 'stopped'
      : s.status?.type === 'requestPermission'
        ? 'waiting'
        : s.status?.type === 'running' || s.status?.type === 'initializing'
          ? 'busy'
          : 'idle',
    machinePresence: online ? 'online' : 'offline',
    isMine: s.userId === account,
    userId: s.userId,
    archived: !!s.isArchived,
    createdByPluginId: s.createdByPluginId,
    businessKey: s.businessKey,
    createdAt,
    updatedAt: Math.max(createdAt, s.lastMessageAt ?? 0, s.lastRunningSeen ?? 0),
    openedByRootSessionId: s.openedByRootSessionId,
    openedBySessionId: s.openedBySessionId ?? s.parentSessionId,
    agentRoleId: s.agentRoleId,
    agentRoleRevision: s.agentRoleRevision,
    cliType: s.cliType,
    lastModel: s.lastModel,
    contextWindowUsage: s.contextWindowUsage
      ? { usedTokens: s.contextWindowUsage.used, maxTokens: s.contextWindowUsage.size }
      : undefined,
    branchName: s.branchName,
    baseBranch: s.baseBranch,
    isWorktree: s.isWorktree,
    isPinned: s.isPinned,
    pinSectionId: s.pinSectionId,
    orderKey: s.orderKey,
    snoozedUntil: s.snoozedUntil,
    settledAt: s.settledAt,
    scheduleId: s.scheduleId,
    pullRequests: (s.pullRequests ?? []).map((p) => ({
      url: p.url,
      state: p.status === 'draft' ? 'open' : p.status,
      draft: p.status === 'draft',
      project,
    })),
  };
}
type Filter = Exclude<NonNullable<(typeof lodyQueries.sessions)['__types']>['input'], void>;
export function querySessions(
  rows: readonly SessionSummary[],
  target: ScopeTarget<PluginScope>,
  pluginId: string,
  raw: unknown
) {
  const f = (raw ?? {}) as Filter;
  const filtered = rows
    .filter(
      (s) =>
        (!('machineId' in target) || s.session.machineId === target.machineId) &&
        (!('projectId' in target) || s.project?.projectId === target.projectId) &&
        (!f.machineId || s.session.machineId === f.machineId) &&
        (!f.sessionIds || f.sessionIds.includes(s.session.sessionId)) &&
        (f.archived === undefined || s.archived === f.archived) &&
        (!f.status || s.status === f.status) &&
        (!f.agentRoleId || s.agentRoleId === f.agentRoleId) &&
        (!f.createdByMe || s.isMine) &&
        (!f.createdByPlugin || s.createdByPluginId === pluginId) &&
        (!f.businessKey || s.businessKey === f.businessKey) &&
        (!f.rootSessionId ||
          s.session.sessionId === f.rootSessionId ||
          (s.openedByRootSessionId ?? s.openedBySessionId) === f.rootSessionId) &&
        (f.updatedAfter === undefined || s.updatedAt >= f.updatedAfter) &&
        (!f.search || s.title.toLowerCase().includes(f.search.toLowerCase()))
    )
    .sort(
      (a, b) => b.updatedAt - a.updatedAt || a.session.sessionId.localeCompare(b.session.sessionId)
    );
  const start = Number(f.cursor ?? 0),
    limit = f.limit ?? 100;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1)
    throw Error('Invalid sessions page');
  const items = filtered.slice(start, start + limit);
  return structuredClone({
    items,
    ...(start + items.length < filtered.length ? { nextCursor: String(start + items.length) } : {}),
  });
}
