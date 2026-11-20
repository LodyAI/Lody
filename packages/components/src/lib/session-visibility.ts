import type { MachineId } from '@lody/shared';
import {
  getLocalProjectVisibilityKey,
  isLocalProjectSession,
  type SessionMachineRecord,
} from '@lody/shared/session-visibility';
import type { MachineVisibilityAccess } from './visible-machine-index';
import type { LocalProjectVisibilityAccess } from './visible-local-project-index';

// The rules live in shared: Electron main checks native reads with the same code.
export * from '@lody/shared/session-visibility';

/** Assignment may use existing access only; it never changes sharing. */
export function getSessionOwnerAccessReason(
  session: SessionMachineRecord,
  candidateUserId: string,
  machines: ReadonlyMap<MachineId, MachineVisibilityAccess>,
  projects: ReadonlyMap<string, LocalProjectVisibilityAccess>
): 'machineUnavailable' | 'machineNotShared' | 'projectNotShared' | null {
  const machine = machines.get(session.machineId as MachineId);
  if (!machine) return 'machineUnavailable';
  if (machine.ownerUserId === candidateUserId) return null;
  if (!machine.sharedWithTeam) return 'machineNotShared';
  if (isLocalProjectSession(session)) {
    const project = projects.get(
      getLocalProjectVisibilityKey(session.machineId!, session.project.localProjectId)
    );
    if (!project?.sharedWithTeam) return 'projectNotShared';
  }
  return null;
}
