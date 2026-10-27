import type { MachineId } from '@lody/shared';
import type {
  MobileProjectFolder,
  MobileProjectGroup,
  MobileProjectRepo,
} from './mobile-new-chat-project-sheet';

export function filterMobileProjectOptions({
  folders,
  repositories,
  groups,
  machineId,
  query,
}: {
  folders: ReadonlyArray<MobileProjectFolder>;
  repositories: ReadonlyArray<MobileProjectRepo>;
  groups: ReadonlyArray<MobileProjectGroup>;
  machineId: MachineId | null;
  query: string;
}): {
  folders: MobileProjectFolder[];
  repositories: MobileProjectRepo[];
  groups: MobileProjectGroup[];
} {
  const term = query.trim().toLocaleLowerCase();
  const matches = (value: string) => !term || value.toLocaleLowerCase().includes(term);
  const filteredFolders = folders
    .filter((folder) => folder.machineId === machineId)
    .filter((folder) => matches(`${folder.name} ${folder.rootPath}`))
    .sort(
      (left, right) =>
        (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || left.name.localeCompare(right.name)
    );
  const filteredRepositories = repositories
    .filter((repo) => matches(`${repo.fullName} ${repo.description ?? ''}`))
    .sort(
      (left, right) =>
        (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) ||
        left.fullName.localeCompare(right.fullName)
    );
  const filteredGroups = groups
    .filter((group) => matches(group.name))
    .sort(
      (left, right) =>
        (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || left.name.localeCompare(right.name)
    );
  return { folders: filteredFolders, repositories: filteredRepositories, groups: filteredGroups };
}
