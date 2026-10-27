import { Data } from 'effect';
import type { LodyError, MachineId } from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';

export type MachinePresence = 'online' | 'offline' | 'unknown';

/** Three-state presence: `null` from the presence room means unknown, never offline. */
export function classifyMachinePresence(
  onlineMachineIds: ReadonlySet<MachineId> | null,
  machineId: MachineId
): MachinePresence {
  if (onlineMachineIds === null) return 'unknown';
  return onlineMachineIds.has(machineId) ? 'online' : 'offline';
}

export async function readMachinePresence(
  manager: Pick<LoroDocumentManager, 'getOnlineMachineIds'>,
  machineId: MachineId
): Promise<MachinePresence> {
  return classifyMachinePresence(await manager.getOnlineMachineIds(), machineId);
}

/** Presence definitively reports the target Machine offline. */
export class MachineOfflineError extends Data.TaggedError('MachineOfflineError')<{
  machineId: string;
}> {
  override get message(): string {
    return `Target Machine is offline: ${this.machineId}`;
  }

  toLodyError(): LodyError {
    return { code: 'MACHINE_OFFLINE', message: this.message, retryable: true };
  }
}
