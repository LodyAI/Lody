import { useAtomValue } from 'jotai';
import type { MachineId } from '@lody/shared';
import {
  machineOnlineStatusAtomFamily,
  machineLivePresenceAtomFamily,
  onlineMachineIdsAtom,
  type MachineOnlineStatus,
} from '@/atoms/presence';

/**
 * Machine liveness from the ephemeral presence channel — the single source of
 * truth for online/offline UI. 'unknown' means this client's presence
 * subscription is not synced, so UI must not claim the machine is offline.
 */
export function useMachineOnlineStatus(
  machineId: MachineId | null | undefined
): MachineOnlineStatus {
  return useAtomValue(machineOnlineStatusAtomFamily(machineId ?? undefined));
}

/** Instance identity of the currently fresh daemon generation, when online. */
export function useMachinePresenceInstanceId(
  machineId: MachineId | null | undefined
): string | null {
  return useAtomValue(machineLivePresenceAtomFamily(machineId ?? undefined))?.instanceId ?? null;
}

/** Machine ids with a fresh presence heartbeat. Stable reference between recomputes. */
export function useOnlineMachineIds(): ReadonlySet<MachineId> {
  return useAtomValue(onlineMachineIdsAtom);
}
