import { useAtomValue } from 'jotai';
import type { MachineId } from '@lody/shared';
import {
  machineOnlineStatusAtomFamily,
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

/** Machine ids with a fresh presence heartbeat. Stable reference between recomputes. */
export function useOnlineMachineIds(): ReadonlySet<MachineId> {
  return useAtomValue(onlineMachineIdsAtom);
}
