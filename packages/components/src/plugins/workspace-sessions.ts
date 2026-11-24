import { filterPluginSessions, sessionSummaryFacts } from '@lody/shared/plugins/history';
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
  return { session, project, ...sessionSummaryFacts(s, account, online, project) };
}
type Filter = Exclude<NonNullable<(typeof lodyQueries.sessions)['__types']>['input'], void>;
export function querySessions(
  rows: readonly SessionSummary[],
  target: ScopeTarget<PluginScope>,
  pluginId: string,
  raw: unknown
) {
  return filterPluginSessions(rows, target, pluginId, (raw ?? {}) as Filter);
}
