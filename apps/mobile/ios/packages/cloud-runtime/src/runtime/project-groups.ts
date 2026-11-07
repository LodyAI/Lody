import { openSettings } from './settings';
import { listWorkspaceProjects, type WorkspaceProject } from '../protocol/project-groups.ts';

type Grant = Parameters<typeof openSettings>[1];

/** The workspace's multi-repository projects, read fresh from `${workspaceId}:wf:workspace`. */
export async function readWorkspaceProjects(workspaceId: string, grant: Grant, signal: AbortSignal): Promise<WorkspaceProject[]> {
  const { flock } = await openSettings(`${workspaceId}:wf:workspace`, grant, signal);
  return listWorkspaceProjects(flock.scan());
}
