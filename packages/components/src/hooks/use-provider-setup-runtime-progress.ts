import { useEffect, useMemo } from 'react';
import type { AgentType, WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { useMachineAcpBinaryActions } from './use-machine-acp-binary-actions';

/**
 * Attaches one explicit install request to each machine's active durable setup.
 * The target CLI still owns setup execution; this idempotent request keeps the
 * transient progress stream alive for the renderer and joins the same CLI
 * install when the durable worker won the race.
 */
export function useProviderSetupRuntimeProgress(
  runtime: WorkspaceRuntime | null,
  workspaceId: WorkspaceId | null,
  setups: readonly {
    readonly machineId: import('@lody/shared').MachineId;
    readonly createdAt: number;
    readonly status: string;
    readonly config: { readonly agentType: AgentType };
  }[]
): void {
  const { installBinary } = useMachineAcpBinaryActions(runtime, workspaceId);
  const activeSetups = useMemo(() => {
    const byMachine = new Map<string, (typeof setups)[number]>();
    for (const setup of [...setups].sort((left, right) => left.createdAt - right.createdAt)) {
      if (setup.status !== 'preparing-runtime' || byMachine.has(setup.machineId)) continue;
      byMachine.set(setup.machineId, setup);
    }
    return [...byMachine.values()];
  }, [setups]);

  useEffect(() => {
    if (!runtime || workspaceId === null) return;
    for (const setup of activeSetups) {
      void installBinary({ machineId: setup.machineId, agentType: setup.config.agentType }).catch(
        (error: unknown) => {
          console.warn('[provider-setup] Failed to observe managed runtime installation', {
            machineId: setup.machineId,
            agentType: setup.config.agentType,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      );
    }
  }, [activeSetups, installBinary, runtime, workspaceId]);
}
