import type { UnstableSnapshotTarget } from '@lody/plugin-sdk';
import type { SessionMeta, AgentRole, ScheduleRegistryRow } from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import type { VisibleLocalProjectIndex } from '../lib/visible-local-project-index';
import type { SnapshotSource, SnapshotSlice } from './raw-snapshots';
const forbidden = () => {
  throw Object.assign(Error('Snapshot target unavailable'), { code: 'forbidden' });
};
export function workspaceSnapshotSource(
  runtime: WorkspaceRuntime,
  account: string | null,
  active: readonly SessionMeta[],
  archived: readonly SessionMeta[],
  projects: VisibleLocalProjectIndex['projects'],
  roles: readonly AgentRole[],
  schedules: readonly ScheduleRegistryRow[],
  extra: Readonly<Record<string, unknown>> = {}
): SnapshotSource {
  const find = (t: Extract<UnstableSnapshotTarget, { session: unknown }>) => {
    const s =
      active.find((x) => x.id === t.session.sessionId) ??
      archived.find((x) => x.id === t.session.sessionId);
    if (!s || s.machineId !== t.session.machineId) return forbidden();
    return s;
  };
  const project = (t: Extract<UnstableSnapshotTarget, { kind: 'project-state' }>) =>
    projects.get(`${t.project.machineId}:${t.project.projectId}`)?.project ?? forbidden();
  function identity(t: UnstableSnapshotTarget) {
    if (t.kind === 'project-state' && !t.path?.length) return forbidden();
    if (!account) return forbidden();
    let refs: readonly unknown[];
    switch (t.kind) {
      case 'workspace-state': {
        const [collection, key] = t.path ?? [];
        if (!key) return forbidden();
        const data =
          collection === 'sessions'
            ? (active.find((s) => s.id === key) ?? archived.find((s) => s.id === key))
            : collection === 'projects'
              ? projects.get(key)?.project
              : collection === 'roles'
                ? roles.find((r) => r.id === key)
                : collection === 'schedules'
                  ? schedules.find((r) => r.scheduleId === key)
                  : collection === 'machines' || collection === 'rateLimits'
                    ? Object.getOwnPropertyDescriptor(extra[collection] ?? {}, key)?.value
                    : undefined;
        refs = [data];
        break;
      }
      case 'session-meta':
        refs = [find(t)];
        break;
      case 'session-transcript':
        refs = [find(t).id];
        break;
      case 'project-state':
        refs = [project(t)];
        break;
      default:
        return forbidden();
    }
    if (refs.some((ref) => ref === undefined)) return forbidden();
    return [runtime, account, ...refs];
  }
  async function open(
    t: UnstableSnapshotTarget,
    notify: () => void,
    signal: AbortSignal
  ): Promise<SnapshotSlice> {
    const id = identity(t);
    await runtime.waitForContentAdmission?.(signal);
    signal.throwIfAborted();
    switch (t.kind) {
      case 'workspace-state':
        return {
          identity: id,
          read: () => {
            const [k, key] = t.path;
            return { [k]: { [key]: id[2] } };
          },
        };
      case 'project-state':
        return { identity: id, read: () => project(t) };
      case 'session-meta':
        return { identity: id, read: () => find(t) };
      case 'session-transcript': {
        const s = find(t);
        const limit = t.limit ?? 20;
        if (
          (t.limit === undefined) === (t.turnIds === undefined) ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          (t.turnIds &&
            (!t.turnIds.length ||
              t.turnIds.length > 100 ||
              t.turnIds.some((id) => typeof id !== 'string' || !id)))
        )
          throw Error('Invalid transcript window');
        const store = await runtime.acquireSessionStore(s.id);
        const reader = store.sessionData.history;
        let keys = new Set(t.turnIds);
        let tailStart = 0;
        const off = store.history.subscribe((change) => {
          if (
            change.kind === 'structure'
              ? (!t.turnIds && change.to >= tailStart) || !!t.turnIds
              : change.ids.some((id) => keys.has(id)) || change.indexIds?.some((id) => keys.has(id))
          )
            notify();
        });
        return {
          identity: id,
          read: async () => {
            signal.throwIfAborted();
            const count = t.turnIds ? 0 : await reader.count();
            tailStart = Math.max(0, count - limit);
            const rows = t.turnIds
              ? await Promise.all(t.turnIds.map((id) => reader.readTurn(id)))
              : await reader.readRange(tailStart, count);
            signal.throwIfAborted();
            const turns = rows.flatMap((r) => (r.state === 'ready' ? [r.turn] : []));
            keys = new Set(t.turnIds ?? turns.map((r) => r.id));
            return { turns };
          },
          release: () => {
            off();
            runtime.releaseSessionStoreRef(s.id);
          },
        };
      }
    }
  }
  return { identity, open };
}
