import { compareUnifiedProjectOptions } from '../chat/chat-landing-derived';
import type { UnifiedProjectSelection } from '../chat/unified-project-selector';
import type { MachineId } from '@lody/shared';
import type { ChatLandingDefaults } from '@/lib/chat-landing-defaults';
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

export type MobileProjectOption = {
  value: string;
  label: string;
  description?: string;
  disabledReason?: string;
  lastUsedAt?: number;
  selection: Exclude<UnifiedProjectSelection, { kind: 'none' }>;
};

/** Remembered intent wins; older installs can recover from existing usage ranks. */
export function resolveMobileNewChatDefaultProject(
  remembered: ChatLandingDefaults['lastUsedProject'],
  options: readonly MobileProjectOption[]
): UnifiedProjectSelection {
  if (remembered?.kind === 'none') return remembered;
  const available = options.filter((option) => !option.disabledReason);
  const match = remembered
    ? available.find((option) => {
        const selection = option.selection;
        return (
          selection.kind === remembered.kind &&
          (selection.kind === 'github' && remembered.kind === 'github'
            ? selection.repoFullName === remembered.repoFullName
            : selection.kind === 'local' && remembered.kind === 'local'
              ? selection.machineId === remembered.machineId &&
                selection.localProjectId === remembered.localProjectId
              : selection.kind === 'group' && remembered.kind === 'group'
                ? selection.projectId === remembered.projectId
                : false)
        );
      })
    : [...available]
        .sort(compareUnifiedProjectOptions)
        .find((option) => option.lastUsedAt !== undefined);
  return match?.selection ?? { kind: 'none' };
}

/** One recent-first list across all sources, using the desktop tie breakers. */
export function getMobileProjectOptions(
  input: Parameters<typeof filterMobileProjectOptions>[0]
): MobileProjectOption[] {
  const { folders, repositories, groups } = filterMobileProjectOptions(input);
  const options: MobileProjectOption[] = [
    ...groups.map((group) => ({
      value: `group:${group.projectId}`,
      label: group.name,
      description: group.availability,
      disabledReason: group.disabledReason,
      lastUsedAt: group.lastUsedAt,
      selection: { kind: 'group' as const, projectId: group.projectId },
    })),
    ...folders.map((folder) => ({
      value: `local:${folder.machineId}:${folder.localProjectId}`,
      label: folder.name,
      description: folder.rootPath,
      lastUsedAt: folder.lastUsedAt,
      selection: {
        kind: 'local' as const,
        machineId: folder.machineId,
        localProjectId: folder.localProjectId,
      },
    })),
    ...repositories.map((repo) => ({
      value: `github:${repo.fullName}`,
      label: repo.fullName,
      lastUsedAt: repo.lastUsedAt,
      selection: { kind: 'github' as const, repoFullName: repo.fullName },
    })),
  ];
  return options.sort(compareUnifiedProjectOptions);
}
