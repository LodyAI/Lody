import type { ProjectRef } from '@lody/shared';

/** Maps a schedule's stored project onto session-create selectors. */
export const buildProjectOptions = (project: ProjectRef | undefined): Record<string, unknown> => {
  if (!project) {
    return {};
  }
  if (project.kind === 'github') {
    return {
      repo: project.repoFullName,
      ...(project.branch ? { branch: project.branch } : {}),
    };
  }
  return {
    localProject: project.localProjectId,
    ...(project.branch ? { branch: project.branch } : {}),
    ...(project.useWorktree ? { worktree: true } : {}),
  };
};
