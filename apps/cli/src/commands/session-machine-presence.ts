import { Data } from 'effect';
import type { LodyError, MachineId } from '@lody/shared';
import type { LoroDocumentManager, MachinePresenceView } from '@/lib/loro/doc';

export type MachinePresence = 'online' | 'offline' | 'unknown';

/**
 * Three-state presence: a fresh heartbeat is online even while the room is not
 * joined; absence is offline only on a joined room and unknown otherwise.
 */
export function classifyMachinePresence(
  view: MachinePresenceView,
  machineId: MachineId
): MachinePresence {
  if (view.online.has(machineId)) return 'online';
  return view.synced ? 'offline' : 'unknown';
}

export async function readMachinePresence(
  manager: Pick<LoroDocumentManager, 'getMachinePresenceView'>,
  machineId: MachineId
): Promise<MachinePresence> {
  return classifyMachinePresence(await manager.getMachinePresenceView(), machineId);
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
