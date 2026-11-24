import { checkSnapshotEnvelope, copyPluginSnapshot } from '@lody/shared/plugins/snapshot';
import {
  filterPluginSessions,
  readPluginSubagentRun,
  readPluginTurnPage,
  sessionSummaryFacts,
} from '@lody/shared/plugins/history';
import type { SessionHistoryReader } from '@lody/shared/session-data';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DispatchMachineHostCall } from '../machine-host-port';
import {
  pluginInvocationParams,
  pluginSessionCreateParams,
} from '@lody/shared/plugins/machine-rpc';
import { lifecycleCommandInputs, sessionCommandInputs } from '@lody/shared/commands/host-commands';
import type { SessionHistoryInput, SessionMeta } from '@lody/shared';

function forbidden(): never {
  throw Object.assign(Error('forbidden'), { code: 'forbidden' });
}
export const dispatchMachineHostCall: DispatchMachineHostCall = async (call, signal) => {
  if (call.origin.type !== 'invoke') return forbidden();
  const run = call.origin.execute ?? forbidden();
  const result = await run(call, signal);
  signal.throwIfAborted();
  return JSON.parse(JSON.stringify(result ?? null));
};
const refSchema = pluginInvocationParams.shape.target;
const snapshot = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('project-state'),
    project: refSchema,
    path: z.array(z.string()).min(1).max(64),
  }),
  z.strictObject({ kind: z.literal('session-meta'), session: refSchema }),
  z
    .strictObject({
      kind: z.literal('session-transcript'),
      session: refSchema,
      limit: z.number().int().min(1).max(100).optional(),
      turnIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    })
    .refine((v) => (v.limit === undefined) !== (v.turnIds === undefined)),
]);
const page = z.strictObject({
  limit: z.number().int().min(0).max(100).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,9}$/)
    .optional(),
});
type CreateParams = z.infer<typeof pluginSessionCreateParams>;
export interface DaemonCommandContext {
  workspaceId: string;
  machineId: string;
  pluginId: string;
  userId: string;
  machineOwner: boolean;
  projectId?: string;
  sessionId?: string;
  check(): void;
  project(id: string): Promise<unknown>;
  sessions(check: () => void): Promise<SessionMeta[]>;
  meta(id: string): Promise<SessionMeta>;
  history(id: string): Promise<SessionHistoryReader>;
  queueCount(id: string): Promise<number>;
  turns(
    id: string,
    limit: number,
    offset: number,
    ids?: string[]
  ): Promise<{ items: SessionHistoryInput[]; more: boolean }>;
  lifecycle(
    id: keyof typeof lifecycleCommandInputs,
    meta: SessionMeta,
    input: unknown,
    check: () => void
  ): Promise<unknown>;
  preference(
    id: keyof typeof sessionCommandInputs,
    meta: SessionMeta,
    input: unknown,
    check: () => void
  ): Promise<void>;
  create(p: Omit<CreateParams, 'clientDigest'>, check: () => void): Promise<{ sessionId: string }>;
}
export function daemonCommandExecutor(ctx: DaemonCommandContext): DispatchMachineHostCall {
  const actor = Object.freeze({ ...ctx });
  return async (call, signal) => {
    const check = () => {
      signal.throwIfAborted();
      actor.check();
    };
    check();
    if (
      call.origin.type !== 'invoke' ||
      call.origin.frame.actorUserId !== actor.userId ||
      call.pluginId !== actor.pluginId ||
      call.machineId !== actor.machineId ||
      call.workspaceId !== actor.workspaceId
    )
      return forbidden();
    if (call.op === 'lody.read' || call.op === 'lody.unstable.readSnapshot')
      return executeScopedPluginRead(actor, call.op, call.payload, signal);
    const payload = z
      .strictObject({
        target: z.unknown(),
        descriptorId: z.string().optional(),
        input: z.unknown().optional(),
      })
      .parse(call.payload);
    const target = refSchema.parse(payload.target);
    if (
      target.workspaceId !== actor.workspaceId ||
      target.machineId !== actor.machineId ||
      target.projectId !== actor.projectId ||
      target.sessionId !== actor.sessionId
    )
      return forbidden();
    if (call.op === 'lody.execute' && payload.descriptorId === 'sessionCreate') {
      if (
        call.origin.frame.kind !== 'mutation' ||
        target.sessionId ||
        (!target.projectId && !actor.machineOwner)
      )
        return forbidden();
      const input = pluginSessionCreateParams.shape.input.parse(payload.input);
      const result = await actor.create(
        {
          scope: target.projectId ? 'project' : 'machine',
          pluginId: actor.pluginId,
          target,
          input,
        },
        check
      );
      check();
      return { ...target, sessionId: result.sessionId };
    }
    const id = target.sessionId ?? forbidden();
    const meta = await actor.meta(id);
    check();
    if (meta.machineId !== actor.machineId) return forbidden();
    if (
      call.op === 'lody.execute' &&
      payload.descriptorId &&
      Object.hasOwn(sessionCommandInputs, payload.descriptorId)
    ) {
      if (call.origin.frame.kind !== 'mutation' || meta.userId !== actor.userId || meta.id !== id)
        return forbidden();
      await actor.preference(
        payload.descriptorId as keyof typeof sessionCommandInputs,
        meta,
        payload.input,
        check
      );
      return null;
    }
    const command = call.op === 'lody.execute' ? payload.descriptorId : undefined;
    if (command && Object.hasOwn(lifecycleCommandInputs, command)) {
      if (call.origin.frame.kind !== 'mutation' || meta.userId !== actor.userId || meta.id !== id)
        return forbidden();
      return actor.lifecycle(
        command as keyof typeof lifecycleCommandInputs,
        meta,
        payload.input,
        check
      );
    }
    return forbidden();
  };
}

/** Start/event provenance identifies a delivery, never a workflow principal. Resolve a fresh
 * installation-bound operation for each call; its owner fences writes after asynchronous reads. */
export type ResolveStandalonePluginOperation = (
  request: Pick<
    Parameters<DispatchMachineHostCall>[0],
    'workspaceId' | 'machineId' | 'pluginId' | 'instanceId' | 'op' | 'payload' | 'origin'
  >,
  signal: AbortSignal
) => Promise<((signal: AbortSignal) => Promise<unknown>) | undefined>;
export function composeMachineHostDispatch(
  resolve?: ResolveStandalonePluginOperation
): DispatchMachineHostCall {
  return async (call, signal) => {
    if (call.origin.type === 'invoke') return dispatchMachineHostCall(call, signal);
    signal.throwIfAborted();
    if (!resolve) return forbidden();
    const { workspaceId, machineId, pluginId, instanceId, op, payload, origin } = call;
    const perform = await resolve(
      { workspaceId, machineId, pluginId, instanceId, op, payload, origin },
      signal
    );
    signal.throwIfAborted();
    if (!perform) return forbidden();
    const value = await perform(signal);
    signal.throwIfAborted();
    return value;
  };
}

export type ScopedPluginReadContext = Omit<
  DaemonCommandContext,
  'create' | 'preference' | 'lifecycle'
>;
/** The context is supplied by a verified per-call issuer, never derived from payload.target. */
export async function executeScopedPluginRead(
  actor: ScopedPluginReadContext,
  op: 'lody.read' | 'lody.unstable.readSnapshot',
  wire: Parameters<DispatchMachineHostCall>[0]['payload'],
  signal: AbortSignal
) {
  const check = () => {
    signal.throwIfAborted();
    actor.check();
  };
  check();
  const payload = z
    .strictObject({
      target: z.unknown(),
      descriptorId: z.string().optional(),
      input: z.unknown().optional(),
    })
    .parse(wire);
  if (
    op === 'lody.unstable.readSnapshot' &&
    payload.target &&
    typeof payload.target === 'object' &&
    'kind' in payload.target &&
    (payload.target.kind === 'workspace-state' || payload.target.kind === 'schedule-doc')
  )
    return forbidden();
  if (op === 'lody.read' && ['agentRoles', 'agentConfigs'].includes(payload.descriptorId ?? ''))
    return forbidden();
  const snap = op === 'lody.unstable.readSnapshot' ? snapshot.parse(payload.target) : undefined;
  const target = refSchema.parse(
    snap ? ('session' in snap ? snap.session : snap.project) : payload.target
  );
  if (
    target.workspaceId !== actor.workspaceId ||
    target.machineId !== actor.machineId ||
    target.projectId !== actor.projectId ||
    target.sessionId !== actor.sessionId
  )
    return forbidden();
  if (snap?.kind === 'project-state') {
    if (!target.projectId || target.sessionId) return forbidden();
    const raw = await actor.project(target.projectId);
    check();
    if (!raw) return forbidden();
    const doc = copyPluginSnapshot(raw, snap.path ?? [], actor.pluginId, snap.kind);
    return checkSnapshotEnvelope({
      schemaVersion: 1,
      revision: createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
      doc,
    });
  }
  if (op === 'lody.read' && payload.descriptorId === 'sessions') {
    if (target.sessionId || (!target.projectId && !actor.machineOwner)) return forbidden();
    const f = z
      .strictObject({
        machineId: z.string().optional(),
        sessionIds: z.array(z.string()).optional(),
        archived: z.boolean().optional(),
        status: z.enum(['idle', 'busy', 'waiting', 'stopped']).optional(),
        agentRoleId: z.string().optional(),
        createdByMe: z.boolean().optional(),
        createdByPlugin: z.boolean().optional(),
        businessKey: z.string().optional(),
        rootSessionId: z.string().optional(),
        updatedAfter: z.number().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().optional(),
      })
      .parse(payload.input ?? {});
    const metas = await actor.sessions(check);
    check();
    return filterPluginSessions(
      metas.map((m) => {
        const projectId =
          m.project?.kind === 'local'
            ? m.project.localProjectId
            : m.project?.kind === 'github'
              ? m.project.repoFullName
              : undefined;
        const base = { workspaceId: actor.workspaceId, machineId: actor.machineId };
        const project = projectId ? { ...base, projectId } : undefined;
        return {
          session: { ...base, sessionId: m.id, ...(projectId ? { projectId } : {}) },
          project,
          ...sessionSummaryFacts(m, actor.userId, true, project),
        };
      }),
      target,
      actor.pluginId,
      f
    );
  }
  const id = target.sessionId ?? forbidden();
  const meta = await actor.meta(id);
  check();
  if (meta.machineId !== actor.machineId) return forbidden();
  if (snap) {
    const raw =
      snap.kind === 'session-meta'
        ? meta
        : { turns: (await actor.turns(id, snap.limit ?? 50, 0, snap.turnIds)).items };
    check();
    const doc = copyPluginSnapshot(raw, [], actor.pluginId, snap.kind);
    return checkSnapshotEnvelope({
      schemaVersion: 1,
      revision: createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
      doc,
    });
  }
  if (op === 'lody.read') {
    const reader = await actor.history(id);
    check();
    if (payload.descriptorId === 'subagentRun') {
      const { runId } = z.strictObject({ runId: z.string().min(1) }).parse(payload.input);
      const result = await readPluginSubagentRun(reader, runId, check);
      check();
      return result;
    }
    if (payload.descriptorId === 'sessionTurns') {
      const p = page.parse(payload.input ?? {});
      const { items, nextCursor } = await readPluginTurnPage(
        reader,
        p.limit ?? 20,
        Number(p.cursor ?? 0),
        check
      );
      check();
      return { items, ...(nextCursor ? { nextCursor } : {}) };
    }
    if (payload.descriptorId === 'sessionDetail') {
      const { recentTurnLimit } = z
        .strictObject({ recentTurnLimit: z.number().int().min(0).max(100).optional() })
        .parse(payload.input ?? {});
      const { items, pendingInteraction } = await readPluginTurnPage(
        reader,
        recentTurnLimit ?? 20,
        0,
        check
      );
      const queuedCount = await actor.queueCount(id);
      check();
      const project = target.projectId
        ? {
            workspaceId: target.workspaceId,
            machineId: target.machineId,
            projectId: target.projectId,
          }
        : undefined;
      return {
        ...sessionSummaryFacts(meta, actor.userId, true, project),
        businessKey: meta.createdByPluginId === actor.pluginId ? meta.businessKey : undefined,
        project,
        session: target,
        queuedCount,
        pendingInteraction,
        recentTurns: items,
      };
    }
  }
  return forbidden();
}
