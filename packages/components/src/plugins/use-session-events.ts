import { useEffect, useMemo, useRef } from 'react';
import type { SessionHistory, SessionMeta } from '@lody/shared';
import type { SessionRef, WorkspaceRef } from '@lody/plugin-sdk';
import { clientPluginEvents } from './client-events';
import { eventRefs, PluginTurnTransitions, type SessionIdentity } from './session-events';
export function usePluginTurnEvents(
  workspaceId: string | null | undefined,
  session: SessionIdentity,
  ready: boolean,
  history: readonly SessionHistory[]
) {
  const tracker = useMemo(
    () => new PluginTurnTransitions(),
    [workspaceId, session.id, session.machineId]
  );
  useEffect(() => {
    if (workspaceId && ready) tracker.observe(workspaceId, session, history);
    else tracker.reset();
  }, [tracker, workspaceId, session, ready, history]);
}
// Scoped by the mounted workspace provider, not a process-global workspace id.
const viewing = new WeakMap<object, { session?: SessionRef; lease: object }>();
export function usePluginSessionSwitch(
  owner: object | null,
  workspaceId: string | null | undefined,
  session: SessionIdentity | null | undefined
) {
  const id = session?.id,
    machine = session?.machineId,
    project = session?.project;
  useEffect(() => {
    if (!owner || !workspaceId) return;
    const next =
      id && machine
        ? eventRefs(workspaceId, { id, machineId: machine, project }).session
        : undefined;
    const prior = viewing.get(owner);
    const lease = {};
    viewing.set(owner, { session: next, lease });
    const workspace = { workspaceId } as WorkspaceRef;
    if (prior?.session?.sessionId !== next?.sessionId)
      clientPluginEvents.publish('ui.session.switched', {
        workspace,
        session: next,
        previousSession: prior?.session,
      });
    return () => {
      queueMicrotask(() => {
        if (viewing.get(owner)?.lease !== lease) return;
        viewing.delete(owner);
        if (next)
          clientPluginEvents.publish('ui.session.switched', { workspace, previousSession: next });
      });
    };
  }, [owner, workspaceId, id, machine, project]);
}
export function usePluginSessionMetaEvents(
  workspaceId: string | null | undefined,
  ready: boolean,
  sessions: readonly SessionMeta[]
) {
  const previous = useRef<{ id: string; seen: Map<string, string>; since: number } | undefined>(
    undefined
  );
  useEffect(() => {
    if (!workspaceId || !ready) {
      previous.current = undefined;
      return;
    }
    const old = previous.current;
    const seen = new Map<string, string>();
    const since = old?.id === workspaceId ? old.since : Date.now();
    for (const session of sessions) {
      const t = session.status?.type;
      const status = session.collaborationStopped
        ? 'stopped'
        : t === 'requestPermission'
          ? 'waiting'
          : t === 'running' || t === 'initializing'
            ? 'busy'
            : 'idle';
      seen.set(session.id, status);
      if (old?.id !== workspaceId) continue;
      const prior = old.seen.get(session.id);
      if (prior === status) continue;
      const refs = eventRefs(workspaceId, session);
      if (!prior && Date.parse(session.createdAt) >= since)
        clientPluginEvents.publish('session.created', {
          ...refs,
          agentRoleId: session.agentRoleId,
        });
      if (prior && prior !== status)
        clientPluginEvents.publish('session.status.changed', {
          ...refs,
          status,
          previousStatus: prior as typeof status,
        });
    }
    previous.current = { id: workspaceId, seen, since };
  }, [workspaceId, ready, sessions]);
}
