import type { LocalProjectId, LocalProjectMeta, MachineId, MachineViewMeta } from '@lody/shared';
import type { MachineVisibilityAccess } from './visible-machine-index';

export type { MachineVisibilityAccess };

export type LocalProjectVisibilityAccess = {
  machineId: string;
  localProjectId: string;
  ownerUserId: string;
  sharedWithTeam: boolean;
  updatedAt: number;
};

export type VisibleLocalProjectEntry = {
  key: string;
  machineId: MachineId;
  machine: MachineViewMeta;
  project: LocalProjectMeta;
  /** False for the owner-only compatibility row synthesized before this machine
      has a durable `workspaceMachines` record in Convex. */
  isMachineRegistered: boolean;
};

type BuildArgs = {
  rawMachines: Map<MachineId, MachineViewMeta>;
  machineAccessByMachineId: ReadonlyMap<MachineId, MachineVisibilityAccess>;
  convexAccessRows: ReadonlyArray<LocalProjectVisibilityAccess>;
  currentUserId: string | null;
  isLoading: boolean;
};

export type VisibleLocalProjectIndex = {
  projects: Map<string, VisibleLocalProjectEntry>;
  accessByProjectKey: Map<string, LocalProjectVisibilityAccess>;
  accessByMachineId: ReadonlyMap<MachineId, MachineVisibilityAccess>;
  isLoading: boolean;
};

export function getLocalProjectVisibilityKey(
  machineId: MachineId | string,
  localProjectId: LocalProjectId | string
): string {
  return `${machineId}:${localProjectId}`;
}

function selectAccessRow(
  current: LocalProjectVisibilityAccess | undefined,
  next: LocalProjectVisibilityAccess
): LocalProjectVisibilityAccess {
  if (!current) return next;
  return next.updatedAt > current.updatedAt ? next : current;
}

export function buildVisibleLocalProjectIndex({
  rawMachines,
  machineAccessByMachineId,
  convexAccessRows,
  currentUserId,
  isLoading,
}: BuildArgs): VisibleLocalProjectIndex {
  const accessByProjectKey = new Map<string, LocalProjectVisibilityAccess>();

  for (const row of convexAccessRows) {
    const key = getLocalProjectVisibilityKey(row.machineId, row.localProjectId);
    accessByProjectKey.set(key, selectAccessRow(accessByProjectKey.get(key), row));
  }

  if (currentUserId) {
    for (const [machineId, machine] of rawMachines) {
      const machineAccess = machineAccessByMachineId.get(machineId);
      const resolvedOwnerUserId = machineAccess?.ownerUserId ?? machine.ownerUserId;
      if (resolvedOwnerUserId !== currentUserId) continue;
      const localProjects = machine.localProjects;
      if (!localProjects) continue;
      for (const [localProjectId, project] of Object.entries(localProjects)) {
        const resolvedProjectId = (
          typeof project?.id === 'string' && project.id.trim() ? project.id : localProjectId
        ) as LocalProjectId;
        const key = getLocalProjectVisibilityKey(machineId, resolvedProjectId);
        if (accessByProjectKey.has(key)) continue;
        accessByProjectKey.set(key, {
          machineId,
          localProjectId: resolvedProjectId,
          ownerUserId: currentUserId,
          sharedWithTeam: false,
          updatedAt: 0,
        });
      }
    }
  }

  const projects = new Map<string, VisibleLocalProjectEntry>();
  for (const [key, access] of accessByProjectKey) {
    const machineId = access.machineId as MachineId;
    const localProjectId = access.localProjectId as LocalProjectId;
    const machine = rawMachines.get(machineId);
    const machineAccess = machineAccessByMachineId.get(machineId);
    const project = machine?.localProjects?.[localProjectId];
    if (!machine || !project) continue;
    projects.set(key, {
      key,
      machineId,
      machine:
        machineAccess && machineAccess.ownerUserId !== machine.ownerUserId
          ? { ...machine, ownerUserId: machineAccess.ownerUserId }
          : machine,
      project,
      isMachineRegistered: (machineAccess?.updatedAt ?? 0) > 0,
    });
  }

  return {
    projects,
    accessByProjectKey,
    accessByMachineId: machineAccessByMachineId,
    isLoading,
  };
}
