import { querySessions } from './workspace-sessions';
import { useSyncExternalStore, useEffect, useState } from 'react';
import type {
  AgentRoleSummary,
  MachineSummary,
  InstalledPluginSummary,
  WorktreeEntry,
  ScheduleSummary,
  RepositoryGitState,
  SessionSummary,
  WorkspaceMemberSummary,
  ProjectSummary,
  PluginScope,
  ScopeTarget,
  LodyQueryDescriptor,
} from '@lody/plugin-sdk';
import type { ClientHostBindings, LodyClient } from '@lody/plugin-sdk/client';

const resources = new Set(['skills', 'pullRequests', 'filePreview', 'sessionDiff', 'automations']);
type Catalog = {
  resource?: (
    target: ScopeTarget<PluginScope>,
    id: string,
    input: unknown,
    signal: AbortSignal
  ) => Promise<unknown>;
  schedules?: readonly ScheduleSummary[];
  worktrees?: readonly WorktreeEntry[];
  git?: (target: ScopeTarget<PluginScope>) => Promise<RepositoryGitState>;
  sessions?: readonly SessionSummary[];
  history?: (
    s: SessionSummary,
    id: string,
    input: unknown,
    signal: AbortSignal
  ) => Promise<unknown>;
  plugins?: readonly InstalledPluginSummary[];
  machines?: readonly MachineSummary[];
  members?: readonly WorkspaceMemberSummary[];
  projects: readonly ProjectSummary[];
  agentRoles: { items: readonly AgentRoleSummary[]; synced: boolean };
};
export class WorkspacePluginReads {
  private catalog?: Catalog;
  private listeners = new Set<() => void>();
  constructor(private readonly workspaceId: string) {}
  publish(catalog?: Catalog) {
    this.catalog = catalog;
    for (const fn of this.listeners) fn();
  }
  bindings(signal: AbortSignal, pluginId = '') {
    const subscribe = (fn: () => void) => {
      this.listeners.add(fn);
      signal.addEventListener('abort', fn);
      return () => {
        this.listeners.delete(fn);
        signal.removeEventListener('abort', fn);
      };
    };
    const snapshot = () => (signal.aborted ? undefined : this.catalog);
    const resolve = (
      target: ScopeTarget<PluginScope>,
      id: string,
      input?: unknown,
      requestSignal = signal
    ) => {
      signal.throwIfAborted();
      if (target.workspaceId !== this.workspaceId) throw Error('Workspace target mismatch');
      if (resources.has(id) && this.catalog?.resource)
        return this.catalog.resource(target, id, input, requestSignal).then((x) => {
          requestSignal.throwIfAborted();
          return x;
        });
      if (id === 'sessionDetail' || id === 'sessionTurns' || id === 'subagentRun') {
        const s = this.catalog?.sessions?.find(
          (s) =>
            'sessionId' in target &&
            target.sessionId === s.session.sessionId &&
            target.machineId === s.session.machineId
        );
        if (!s || !this.catalog?.history) throw Error('Session unavailable');
        return this.catalog.history(s, id, input, requestSignal);
      }
      if (id === 'gitState' && this.catalog?.git)
        return this.catalog.git(target).then((x) => {
          requestSignal.throwIfAborted();
          return x;
        });
      if (id === 'worktrees' && this.catalog) {
        if (!('projectId' in target)) throw Error('Project target required');
        const rows = (this.catalog.worktrees ?? []).filter(
          (w) =>
            w.rootSession.machineId === target.machineId &&
            w.rootSession.projectId === target.projectId
        );
        const { limit = 100, cursor = '0' } = (input ?? {}) as { limit?: number; cursor?: string };
        const start = Number(cursor);
        if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1)
          throw Error('Invalid worktree page');
        return structuredClone({
          items: rows.slice(start, start + limit),
          ...(start + limit < rows.length ? { nextCursor: String(start + limit) } : {}),
        });
      }
      if (id === 'schedules' && this.catalog)
        return {
          items: structuredClone(
            (this.catalog.schedules ?? []).filter(
              (s) =>
                (!('machineId' in target) || s.machine?.machineId === target.machineId) &&
                (!('projectId' in target) || s.project?.projectId === target.projectId) &&
                (!(input as { enabledOnly?: boolean })?.enabledOnly || s.enabled)
            )
          ),
        };
      if (this.catalog && id === 'sessions')
        return querySessions(this.catalog.sessions ?? [], target, pluginId, input);
      if (this.catalog && id === 'plugins')
        return { items: structuredClone(this.catalog.plugins ?? []) };
      if (this.catalog && id === 'agentConfigs')
        return {
          items: (this.catalog.machines ?? []).flatMap((m) =>
            m.agentConfigs.map((c) => ({
              providerId: c.agentConfigId,
              cliType: c.cliType,
              label: c.label,
              source: c.agentConfigId.startsWith('plugin:') ? 'plugin' : 'builtin',
              machine: structuredClone(m.machine),
              availability: m.presence === 'online' ? 'ready' : 'offline',
            }))
          ),
        };
      if (this.catalog && id === 'members')
        return { items: structuredClone(this.catalog.members ?? []) };
      if (this.catalog && id === 'machines') {
        const limit = (input as { limit?: number } | undefined)?.limit;
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
          throw Error('Invalid machine limit');
        return { items: structuredClone(this.catalog.machines?.slice(0, limit) ?? []) };
      }
      if (this.catalog && id === 'projects') {
        const { cursor, limit } = (input ?? {}) as { cursor?: string; limit?: number };
        const start = cursor === undefined ? 0 : Number(cursor);
        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
        )
          throw Error('Invalid project page');
        const items = structuredClone(this.catalog.projects.slice(start, start + (limit ?? 100)));
        const next = start + items.length;
        return {
          items,
          ...(next < this.catalog.projects.length ? { nextCursor: String(next) } : {}),
        };
      }
      if (!this.catalog || id !== 'agentRoles') throw Error(`Workspace query unavailable: ${id}`);
      return structuredClone(this.catalog.agentRoles);
    };
    const read: LodyClient['read'] = async <S extends PluginScope, I, O>(
      target: ScopeTarget<S>,
      query: LodyQueryDescriptor<S, I, O>,
      ...args: [void] extends [I] ? [input?: I] : [input: I]
    ) => resolve(target, query.id, args[0]) as O;
    const useLodyQuery: ClientHostBindings['useLodyQuery'] = <S extends PluginScope, I, O>(
      target: ScopeTarget<S>,
      query: LodyQueryDescriptor<S, I, O>,
      ...args: [void] extends [I] ? [input?: I] : [input: I]
    ) => {
      const current = useSyncExternalStore(subscribe, snapshot, snapshot);
      const history =
        query.id === 'sessionDetail' ||
        query.id === 'sessionTurns' ||
        query.id === 'subagentRun' ||
        query.id === 'gitState' ||
        resources.has(query.id);
      const key = JSON.stringify([target, query.id, args[0]]);
      const [result, setResult] = useState<{
        key: string;
        catalog: typeof current;
        value: import('@lody/plugin-sdk/client').QueryResult<O>;
      }>();
      const [revision, setRevision] = useState(0);
      useEffect(() => {
        if (!history || !current || signal.aborted) return;
        const controller = new AbortController();
        const req = AbortSignal.any([signal, controller.signal]);
        const [ref, id, input] = JSON.parse(key);
        const refresh = () => setRevision((r) => r + 1);
        Promise.resolve()
          .then(() => resolve(ref, id, input, req))
          .then(
            (data) => {
              if (!req.aborted)
                setResult({
                  key,
                  catalog: current,
                  value: { status: 'ready', data: data as O, refresh },
                });
            },
            (error) => {
              if (!req.aborted)
                setResult({
                  key,
                  catalog: current,
                  value: { status: 'error', message: String(error), refresh },
                });
            }
          );
        return () => controller.abort();
      }, [current, history, key, revision]);
      const refresh = () => {}; // The workspace store pushes every change.
      if (signal.aborted || target.workspaceId !== this.workspaceId)
        return { status: 'unavailable', reason: 'forbidden', refresh };
      if (history)
        return result?.key === key && result.catalog === current
          ? result.value
          : { status: 'loading' };
      if (!this.catalog) return { status: 'loading' };
      if (
        ![
          'agentRoles',
          'projects',
          'machines',
          'members',
          'sessions',
          'worktrees',
          'schedules',
          'plugins',
          'agentConfigs',
        ].includes(query.id)
      )
        return { status: 'unavailable', reason: 'unknown', refresh };
      return {
        status: 'ready',
        data: resolve(target, query.id, args[0]) as O,
        refresh,
      };
    };
    return { read, useLodyQuery };
  }
}
