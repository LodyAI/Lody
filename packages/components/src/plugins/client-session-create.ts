import type { LodyClient } from '@lody/plugin-sdk/client';
import type { SessionRef } from '@lody/plugin-sdk';
import { buildInitialHistoryEntry, type SessionId } from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import type { PluginMachineResult } from '@lody/shared/plugins/machine-rpc';
import { acceptSessionUserTurn } from '../lib/session-send-admission';

type Create = LodyClient['sessions']['create'];
export type ReserveClientSession = (
  target: Parameters<Create>[0],
  input: Parameters<Create>[1],
  signal: AbortSignal
) => Promise<Extract<PluginMachineResult, { type: 'plugin/session-create' }>>;
const pendingInitialTurns = new WeakMap<WorkspaceRuntime, Map<string, Promise<void>>>();
export function bindClientSessionCreate(
  runtime: WorkspaceRuntime | null | undefined,
  userId: string | undefined,
  workspaceId: string,
  machineId: string,
  signal: AbortSignal,
  reserve?: ReserveClientSession,
  check = () => signal.throwIfAborted()
): Create {
  return async (target, input) => {
    check();
    if (
      !userId ||
      !runtime ||
      runtime.workspaceId !== workspaceId ||
      target.workspaceId !== workspaceId ||
      target.machineId !== machineId ||
      !reserve
    )
      throw Error('Plugin session create forbidden');
    const r = await reserve(target, input, signal);
    check();
    if (r.userId !== userId) throw Error('Plugin session receipt owner mismatch');
    const sessionId = r.sessionId as SessionId;
    if (!r.archived) {
      const pending = pendingInitialTurns.get(runtime) ?? new Map<string, Promise<void>>();
      pendingInitialTurns.set(runtime, pending);
      const key = JSON.stringify([userId, sessionId]);
      const existing = pending.get(key);
      if (existing) await existing;
      else {
        const write = (async () => {
          const entry = buildInitialHistoryEntry({
            userId,
            timestamp: r.createdAt,
            cliType: r.cliType,
            agentType: r.agentType,
            prompt: [
              r.role?.prefix?.trim(),
              [input.prompt.trim(), ...(input.skillIds ?? []).map((id) => `$${id}`)].join(' '),
            ]
              .filter(Boolean)
              .join('\n\n'),
            modeId: r.role?.modeId,
            modelId: r.role?.modelId,
            configOptionValues: r.role?.configOptionValues,
            inputBlocks: undefined,
          });
          if (!entry) throw Error('Invalid first turn');
          if (r.role && entry.inputConfig)
            Object.assign(entry.inputConfig, {
              agentRoleId: r.role.snapshot.id,
              agentRoleRevision: r.role.snapshot.revision,
              agentRoleSnapshot: r.role.snapshot,
              ...(r.role.memory ? { memory: r.role.memory } : {}),
            });
          const turnId = `plugin-create:${sessionId}`;
          const found = await runtime.sendResources.withSessionStore(sessionId, async (store) =>
            store.sessionData.history.readTurn(turnId)
          );
          check();
          if (found.state !== 'ready' && found.state !== 'missing')
            throw Error('Initial turn unavailable');
          if (found.state === 'missing')
            await acceptSessionUserTurn(
              runtime,
              sessionId,
              { ...entry, id: turnId },
              { kind: 'dispatch' }
            );
        })();
        pending.set(key, write);
        try {
          await write;
        } finally {
          pending.delete(key);
        }
      }
    }
    return {
      workspaceId,
      machineId,
      sessionId: String(sessionId),
      ...('projectId' in target ? { projectId: target.projectId } : {}),
    } as SessionRef;
  };
}
