import { getProjectBoundMachineId, type MachineId, type WorkspaceProject } from '@lody/shared';

export type ProjectGroupBucket<State, Row> = { states: State[]; sessions: Row[] };

/**
 * Where each multi-repository project sits among the sidebar's projects.
 *
 * A project that needs a machine (it holds a folder without a GitHub remote)
 * sits under that machine with its folders, when the sidebar lists that
 * machine. Every other project runs wherever a copy is, so it sits with the
 * GitHub repositories, as do the conversations of a deleted project, which
 * no longer name a machine.
 */
export function placeProjectGroups<
  State extends { projectId: string },
  Row extends { projectGroup?: { id: string } | null },
>(input: {
  projects: readonly Pick<WorkspaceProject, 'id' | 'members'>[];
  states: readonly State[];
  sessions: readonly Row[];
  listedMachineIds: ReadonlySet<MachineId>;
}): {
  byMachine: Map<MachineId, ProjectGroupBucket<State, Row>>;
  anywhere: ProjectGroupBucket<State, Row>;
} {
  const machineOf = new Map<string, MachineId>();
  for (const project of input.projects) {
    const bound = getProjectBoundMachineId(project.members);
    if (bound && bound !== 'conflict' && input.listedMachineIds.has(bound)) {
      machineOf.set(project.id, bound);
    }
  }
  const byMachine = new Map<MachineId, ProjectGroupBucket<State, Row>>();
  const anywhere: ProjectGroupBucket<State, Row> = { states: [], sessions: [] };
  const bucketOf = (projectId: string | undefined) => {
    const machineId = projectId ? machineOf.get(projectId) : undefined;
    if (!machineId) return anywhere;
    let bucket = byMachine.get(machineId);
    if (!bucket) {
      bucket = { states: [], sessions: [] };
      byMachine.set(machineId, bucket);
    }
    return bucket;
  };
  for (const state of input.states) bucketOf(state.projectId).states.push(state);
  for (const session of input.sessions) bucketOf(session.projectGroup?.id).sessions.push(session);
  return { byMachine, anywhere };
}
