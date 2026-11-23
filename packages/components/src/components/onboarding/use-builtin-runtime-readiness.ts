import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { ManagedBuiltinAgentType, MachineId } from '@lody/shared';

import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineAcpBinaryProgress } from '@/hooks/use-machine-acp-binary-progress';
import { BUILTIN_BACKGROUND_PREFETCH_AGENT_TYPES } from './use-onboarding-builtin-runtime-prefetch';
import { agentRuntimeReadinessFromProgress, type AgentRuntimeReadiness } from './provider-test-state';

export type BuiltinRuntimeReadinessMap = Partial<
  Record<ManagedBuiltinAgentType, AgentRuntimeReadiness>
>;

/**
 * Readiness of the runtimes the background prefetch warms, for the surfaces that
 * light a mark up as each one lands.
 *
 * Reading it here rather than during the ceremony is deliberate: the runtime
 * records a progress snapshot whether or not anyone listens, so subscribing on
 * this screen picks up whatever already happened without a per-percent render
 * ever landing on the intro animation. The hook list is fixed-length because
 * the warmed set is a module constant.
 */
export function useBuiltinRuntimeReadiness(machineId: MachineId | null): BuiltinRuntimeReadinessMap {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const [kimi, codex, claude] = BUILTIN_BACKGROUND_PREFETCH_AGENT_TYPES;
  const kimiProgress = useMachineAcpBinaryProgress(runtime, machineId, kimi);
  const codexProgress = useMachineAcpBinaryProgress(runtime, machineId, codex);
  const claudeProgress = useMachineAcpBinaryProgress(runtime, machineId, claude);

  return useMemo(
    () => ({
      [kimi]: agentRuntimeReadinessFromProgress(kimiProgress),
      [codex]: agentRuntimeReadinessFromProgress(codexProgress),
      [claude]: agentRuntimeReadinessFromProgress(claudeProgress),
    }),
    [claude, claudeProgress, codex, codexProgress, kimi, kimiProgress]
  );
}
