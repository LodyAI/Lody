import {
  isAskUserQuestionPermissionMeta,
  type MessageContent,
  type SessionHistory,
  type SessionMeta,
} from '@lody/shared';
import type {
  MachineRef,
  WorkspaceRef,
  SessionRef,
  ProjectRef,
  ObservedToolCall,
  PendingInteractionSummary,
} from '@lody/plugin-sdk';
import { clientPluginEvents } from './client-events';
export type SessionIdentity = Pick<SessionMeta, 'id' | 'machineId' | 'project'>;
export function eventRefs(workspaceId: string, s: SessionIdentity) {
  const projectId =
    s.project?.kind === 'local'
      ? s.project.localProjectId
      : s.project?.kind === 'github'
        ? s.project.repoFullName
        : undefined;
  return {
    workspace: { workspaceId } as WorkspaceRef,
    machine: { workspaceId, machineId: String(s.machineId) } as MachineRef,
    session: {
      workspaceId,
      machineId: String(s.machineId),
      sessionId: String(s.id),
      ...(projectId ? { projectId } : {}),
    } as SessionRef,
    ...(projectId
      ? { project: { workspaceId, machineId: String(s.machineId), projectId } as ProjectRef }
      : {}),
  };
}
export function messageSubmitted(workspaceId: string, s: SessionIdentity) {
  const { workspace, session, project } = eventRefs(workspaceId, s);
  clientPluginEvents.publish('ui.message.submitted', { workspace, session, project });
}
export function toolFact(item: Extract<MessageContent, { type: 'tool_call' }>): ObservedToolCall {
  const kind = item.kind;
  return {
    toolCallId: item.toolCallId,
    toolName: (item.toolName ?? item.title ?? '').slice(0, 256),
    title: (item.title ?? '').slice(0, 256),
    status: item.status === 'completed' || item.status === 'failed' ? item.status : 'running',
    acpKind:
      kind === 'bash'
        ? 'execute'
        : kind === 'write'
          ? 'edit'
          : kind === 'computer' || kind === 'mcp'
            ? 'other'
            : (kind ?? 'other'),
    locations: (item.locations ?? [])
      .slice(0, 8)
      .map((l) => ({ path: l.path.slice(0, 512), line: l.line ?? undefined })),
  };
}
interface SeenTurn {
  source: SessionHistory;
  done: boolean;
  tools: Map<string, ObservedToolCall['status']>;
  waiting: Set<string>;
}
/** Diffs only the fully hydrated live tail. Switching views and catching up establish a new baseline. */
export class PluginTurnTransitions {
  private seen?: Map<string, SeenTurn>;
  reset() {
    this.seen = undefined;
  }
  observe(workspaceId: string, s: SessionIdentity, turns: readonly SessionHistory[]) {
    const refs = eventRefs(workspaceId, s);
    const next = new Map<string, SeenTurn>();
    for (const turn of turns) {
      if (turn.role !== 'assistant') continue;
      const old = this.seen?.get(turn.id),
        done = !!turn.finished || turn.endedAt != null;
      if (old?.source === turn) {
        next.set(turn.id, old);
        continue;
      }
      const fact: SeenTurn = { source: turn, done, tools: new Map(), waiting: new Set() };
      next.set(turn.id, fact);
      const ids = { turnId: turn.id, userTurnId: turn.userTurnId };
      if (this.seen && !old)
        clientPluginEvents.publish('session.turn.started', { ...refs, ...ids });
      for (const item of turn.items ?? []) {
        if (item.type !== 'tool_call') continue;
        const tool = toolFact(item);
        fact.tools.set(tool.toolCallId, tool.status);
        const prev = old?.tools.get(tool.toolCallId);
        if (this.seen && !prev)
          clientPluginEvents.publish('session.tool.started', {
            ...refs,
            turnId: turn.id,
            toolCall: { ...tool, status: 'running' },
          });
        if (this.seen && tool.status !== 'running' && prev !== tool.status)
          clientPluginEvents.publish('session.tool.completed', {
            ...refs,
            turnId: turn.id,
            toolCall: tool,
          });
        const req = item.permissionRequest;
        if (!req || req.outcome || done) continue;
        fact.waiting.add(req.requestId);
        if (this.seen && !old?.waiting.has(req.requestId)) {
          const interaction: PendingInteractionSummary = {
            requestId: req.requestId,
            turnId: turn.id,
            kind: isAskUserQuestionPermissionMeta(req._meta) ? 'elicitation' : 'permission',
            title: tool.title,
            options: req.options.slice(0, 16).map((o) => ({
              optionId: o.optionId,
              name: o.name.slice(0, 128),
              kind: o.kind ?? undefined,
            })),
          };
          clientPluginEvents.publish('session.waiting_input', { ...refs, interaction });
        }
      }
      if (this.seen && done && !old?.done)
        clientPluginEvents.publish('session.turn.completed', {
          ...refs,
          ...ids,
          stopReason:
            turn.cancellationReason || turn.status === 'canceled'
              ? 'cancelled'
              : turn.status === 'failed'
                ? 'error'
                : 'unknown',
          ...(turn.startedAt != null && turn.endedAt != null
            ? { durationMs: Math.max(0, turn.endedAt - turn.startedAt) }
            : {}),
        });
    }
    this.seen = next;
  }
}
