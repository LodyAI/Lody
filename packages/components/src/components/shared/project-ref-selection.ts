import type { LocalProjectId, MachineId, ProjectRef } from '@lody/shared';
import type {
  UnifiedLocalProjectOption,
  UnifiedProjectSelection,
} from '@/components/chat/unified-project-selector';

/**
 * A `ProjectRef` flattened to one string, so pickers can use it as an option
 * key, and back again.
 *
 * Extracted because two surfaces now convert in both directions — the task
 * page's slot chain and the quick-add dialog. A second private copy is the
 * shape of bug this repo has already paid for elsewhere: the two sides drift,
 * and the same project stops matching itself depending on which screen wrote it.
 */
export const PROJECT_KEY_SEPARATOR = '::';

export const DEFAULT_GITHUB_BRANCH = 'main';

export const projectRefKey = (project: ProjectRef): string =>
  project.kind === 'local'
    ? `local${PROJECT_KEY_SEPARATOR}${project.localProjectId}`
    : `github${PROJECT_KEY_SEPARATOR}${project.repoFullName}`;

/** Inverse of `projectRefKey`. Unknown prefixes are treated as local. */
export const parseProjectKey = (key: string): ProjectRef => {
  const separator = key.indexOf(PROJECT_KEY_SEPARATOR);
  const kind = key.slice(0, separator);
  const value = key.slice(separator + PROJECT_KEY_SEPARATOR.length);
  return kind === 'github'
    ? { kind: 'github', repoFullName: value, branch: DEFAULT_GITHUB_BRANCH }
    : { kind: 'local', localProjectId: value as never };
};

/**
 * Map a task `ProjectRef` onto the chat landing picker selection shape.
 *
 * Local refs only store `localProjectId`; the unified picker's option value
 * also needs the machine. Resolve it from the option list we are about to
 * show so the selected row still highlights.
 */
export const projectRefToUnifiedSelection = (
  project: ProjectRef | null | undefined,
  localProjects: ReadonlyArray<Pick<UnifiedLocalProjectOption, 'machineId' | 'localProjectId'>>
): UnifiedProjectSelection => {
  if (!project) {
    return { kind: 'none' };
  }
  if (project.kind === 'github') {
    return { kind: 'github', repoFullName: project.repoFullName };
  }
  const match = localProjects.find((entry) => entry.localProjectId === project.localProjectId);
  return {
    kind: 'local',
    machineId: (match?.machineId ?? '') as MachineId,
    localProjectId: project.localProjectId,
  };
};

/** Inverse of `projectRefToUnifiedSelection` for writes back onto the task. */
export const unifiedSelectionToProjectRef = (
  selection: UnifiedProjectSelection
): ProjectRef | null => {
  if (selection.kind === 'none') {
    return null;
  }
  if (selection.kind === 'github') {
    return {
      kind: 'github',
      repoFullName: selection.repoFullName,
      branch: DEFAULT_GITHUB_BRANCH,
    };
  }
  return {
    kind: 'local',
    localProjectId: selection.localProjectId as LocalProjectId,
  };
};
