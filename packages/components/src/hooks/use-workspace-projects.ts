import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import type { ProjectId, WorkspaceProject } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { deleteWorkspaceProject, writeWorkspaceProject } from '@/lib/workspace-catalog-write';

export type WorkspaceProjectsSnapshot = {
  /** Every Project group in the workspace, sorted by name. */
  projects: WorkspaceProject[];
  /** True once the first remote sync landed, which makes an empty list authoritative. */
  synced: boolean;
};

/** Project groups are workspace-shared rows of the one catalog document. */
export function useWorkspaceProjects(): WorkspaceProjectsSnapshot {
  const { projects, synced } = useWorkspaceCatalog();
  return { projects, synced };
}

/** Only the creator edits or removes a Project group; everyone else can use it. */
export const canManageWorkspaceProject = (
  project: Pick<WorkspaceProject, 'ownerUserId'>,
  userId: string | null
): boolean => userId !== null && project.ownerUserId === userId;

export function useWorkspaceProjectActions(): {
  /** Resolves once the row is durable locally; the upload runs on its own. */
  upsert: (project: WorkspaceProject) => Promise<void>;
  remove: (id: ProjectId) => Promise<void>;
} {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const upsert = useCallback(
    async (project: WorkspaceProject) => {
      if (!runtime) throw new Error('Workspace runtime is unavailable');
      await writeWorkspaceProject(runtime, project);
    },
    [runtime]
  );
  const remove = useCallback(
    async (id: ProjectId) => {
      if (!runtime) throw new Error('Workspace runtime is unavailable');
      await deleteWorkspaceProject(runtime, id);
    },
    [runtime]
  );
  return { upsert, remove };
}
