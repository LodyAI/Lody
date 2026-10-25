import {
  pickProjectRepositoryLocalCopy,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
  type ProjectMemberSource,
} from '@lody/shared';
import { getProjectMemberSourceKey } from '@/lib/project-group-form';

/** One machine's copy of a repository, as a local project there. */
export type ProjectMemberLocalCopy = {
  machineId: MachineId;
  machineName: string;
  localProjectId: LocalProjectId;
  online: boolean;
};

/**
 * One thing a Project group may contain.
 *
 * A `repository` row stands for a GitHub repository however many machines
 * hold a copy of it; a `directory` row is a folder that exists only on its
 * machine (no GitHub remote, or no Git at all) and binds the group to it.
 */
export type ProjectMemberSourceOption = {
  key: string;
  kind: 'repository' | 'directory';
  source: ProjectMemberSource;
  /** `owner/repo`, or the local project name. */
  label: string;
  /** The GitHub description of a repository, when known. */
  description?: string;
  /** Repository rows: every machine holding a copy. Directory rows: its one machine. */
  copies: readonly ProjectMemberLocalCopy[];
  /**
   * Repository rows: the source key of every local project merged into it,
   * so a group saved before repository Members still finds its copy.
   */
  localKeys: readonly string[];
};

export type ProjectMemberLocalProjectInput = {
  machineId: MachineId;
  machineName: string;
  online: boolean;
  project: Pick<
    LocalProjectMeta,
    'id' | 'name' | 'githubRepoFullName' | 'createdAtMs' | 'lastOpenedAtMs'
  >;
};

/**
 * Merges every machine's local projects with the workspace's GitHub
 * repositories into picker rows, one per repository.
 *
 * A local project whose machine publishes a GitHub remote joins that
 * repository's row; one without stays its own directory row. A repository
 * with a copy somewhere becomes a repository Member (`preferLocal`), so the
 * group runs on whichever machine has it; one only on GitHub stays a plain
 * GitHub Member. Copies are listed most recently opened first, the same
 * order the daemon picks from.
 */
export function buildProjectMemberSourceOptions(input: {
  localProjects: Iterable<ProjectMemberLocalProjectInput>;
  githubRepositories: Iterable<{ fullName: string; description?: string | null }>;
}): ProjectMemberSourceOption[] {
  const repositories = new Map<
    string,
    { label: string; description?: string; copies: ProjectMemberLocalProjectInput[] }
  >();
  const directories: ProjectMemberSourceOption[] = [];
  for (const entry of input.localProjects) {
    const remote = entry.project.githubRepoFullName;
    if (!remote) {
      const source: ProjectMemberSource = {
        kind: 'local',
        machineId: entry.machineId,
        localProjectId: entry.project.id,
      };
      directories.push({
        key: getProjectMemberSourceKey(source),
        kind: 'directory',
        source,
        label: entry.project.name,
        copies: [toCopy(entry)],
        localKeys: [],
      });
      continue;
    }
    const key = remote.toLowerCase();
    const row = repositories.get(key) ?? { label: remote, copies: [] };
    row.copies.push(entry);
    repositories.set(key, row);
  }
  for (const repo of input.githubRepositories) {
    const key = repo.fullName.toLowerCase();
    const row = repositories.get(key);
    // GitHub's spelling of the name wins over a remote URL's.
    if (row) {
      row.label = repo.fullName;
      row.description = repo.description ?? undefined;
    } else {
      repositories.set(key, {
        label: repo.fullName,
        description: repo.description ?? undefined,
        copies: [],
      });
    }
  }

  const withCopies: ProjectMemberSourceOption[] = [];
  const githubOnly: ProjectMemberSourceOption[] = [];
  for (const row of repositories.values()) {
    const ordered = orderCopies(row.label, row.copies);
    const source: ProjectMemberSource =
      ordered.length > 0
        ? { kind: 'github', repoFullName: row.label, preferLocal: true }
        : { kind: 'github', repoFullName: row.label };
    const option: ProjectMemberSourceOption = {
      key: getProjectMemberSourceKey(source),
      kind: 'repository',
      source,
      label: row.label,
      ...(row.description ? { description: row.description } : {}),
      copies: ordered.map(toCopy),
      localKeys: row.copies.map((copy) =>
        getProjectMemberSourceKey({
          kind: 'local',
          machineId: copy.machineId,
          localProjectId: copy.project.id,
        })
      ),
    };
    (ordered.length > 0 ? withCopies : githubOnly).push(option);
  }
  const byLabel = (left: ProjectMemberSourceOption, right: ProjectMemberSourceOption) =>
    left.label.localeCompare(right.label);
  return [...withCopies.sort(byLabel), ...githubOnly.sort(byLabel), ...directories.sort(byLabel)];
}

function toCopy(entry: ProjectMemberLocalProjectInput): ProjectMemberLocalCopy {
  return {
    machineId: entry.machineId,
    machineName: entry.machineName,
    localProjectId: entry.project.id,
    online: entry.online,
  };
}

/** Each machine's chosen copy first (the daemon's pick), then the rest by machine. */
function orderCopies(
  repoFullName: string,
  copies: readonly ProjectMemberLocalProjectInput[]
): ProjectMemberLocalProjectInput[] {
  const byMachine = new Map<MachineId, ProjectMemberLocalProjectInput[]>();
  for (const copy of copies) {
    const list = byMachine.get(copy.machineId) ?? [];
    list.push(copy);
    byMachine.set(copy.machineId, list);
  }
  const out: ProjectMemberLocalProjectInput[] = [];
  for (const list of byMachine.values()) {
    const chosen = pickProjectRepositoryLocalCopy(
      repoFullName,
      list.map((copy) => copy.project)
    );
    const first = list.find((copy) => copy.project === chosen);
    if (first) out.push(first);
  }
  return out.sort((left, right) => left.machineName.localeCompare(right.machineName));
}

/**
 * The local project a repository Member would use on one machine, if any.
 * Shared by the editor (to probe a copy instead of GitHub) and the composer
 * (to say which members a machine lacks).
 */
export function getProjectMemberLocalCopy(
  option: Pick<ProjectMemberSourceOption, 'kind' | 'copies'> | undefined,
  machineId: MachineId
): ProjectMemberLocalCopy | undefined {
  if (option?.kind !== 'repository') return undefined;
  return option.copies.find((copy) => copy.machineId === machineId);
}

/** Which part of the picker is showing: everything, repositories only, or one machine. */
export type ProjectMemberSourceFilter =
  | { kind: 'all' }
  | { kind: 'repositories' }
  | { kind: 'machine'; machineId: MachineId };

export type ProjectMemberSourceGroup = {
  key: string;
  /**
   * `repositories`: run on any machine. `here`: folders on this machine.
   * `elsewhere`: folders on other machines (or every folder when this device
   * runs no machine). `machine`: folders on the filtered machine.
   */
  kind: 'repositories' | 'here' | 'elsewhere' | 'machine';
  items: ProjectMemberSourceOption[];
  /** Folders here cannot join: the group is bound to another machine. */
  blockedBy?: MachineId;
};

export type ProjectMemberSourceGroups = {
  groups: ProjectMemberSourceGroup[];
  /** Rows that cannot be ticked now: folders on a machine the group is not bound to. */
  disabledKeys: ReadonlySet<string>;
  /** GitHub-only repositories left out until the user searches. */
  hiddenRepositoryCount: number;
  /** Every machine with something to offer, for the filter row. */
  machineIds: MachineId[];
};

/**
 * Lays the picker out.
 *
 * Repositories come first, then folders on this machine, then folders on
 * other machines. Repositories that exist only on GitHub are not listed until
 * the user types — a workspace can have hundreds, and they would push every
 * local row out of view — unless already selected. Once the group has a
 * machine-bound member, folders on other machines are disabled; the reason is
 * the group's, said once, never per row.
 */
export function groupProjectMemberSourceOptions(input: {
  options: readonly ProjectMemberSourceOption[];
  selectedKeys: ReadonlySet<string>;
  query: string;
  filter: ProjectMemberSourceFilter;
  /** The machine this device runs, if any. */
  currentMachineId: MachineId | null;
  /** The machine the group's machine-bound members already pin, if any. */
  boundMachineId: MachineId | null;
}): ProjectMemberSourceGroups {
  const { options, selectedKeys, filter, currentMachineId, boundMachineId } = input;
  const searching = input.query.trim().length > 0;
  const machineIds = new Set<MachineId>();
  for (const option of options) for (const copy of option.copies) machineIds.add(copy.machineId);

  const repositories: ProjectMemberSourceOption[] = [];
  let hiddenRepositoryCount = 0;
  for (const option of options) {
    if (option.kind !== 'repository') continue;
    if (filter.kind === 'machine') {
      if (option.copies.some((copy) => copy.machineId === filter.machineId)) {
        repositories.push(option);
      }
      continue;
    }
    if (option.copies.length === 0 && !searching && !selectedKeys.has(option.key)) {
      hiddenRepositoryCount += 1;
      continue;
    }
    repositories.push(option);
  }

  const disabledKeys = new Set<string>();
  const directoriesOn = (keep: (machineId: MachineId) => boolean) =>
    filter.kind === 'repositories'
      ? []
      : options.filter(
          (option) => option.kind === 'directory' && keep(option.copies[0]!.machineId)
        );
  const block = (items: readonly ProjectMemberSourceOption[]) => {
    let blocked = false;
    for (const option of items) {
      const machineId = option.copies[0]!.machineId;
      if (boundMachineId && machineId !== boundMachineId && !selectedKeys.has(option.key)) {
        disabledKeys.add(option.key);
        blocked = true;
      }
    }
    return blocked && boundMachineId ? { blockedBy: boundMachineId } : {};
  };

  const groups: ProjectMemberSourceGroup[] = [];
  if (repositories.length > 0)
    groups.push({ key: 'repositories', kind: 'repositories', items: repositories });
  if (filter.kind === 'machine') {
    const items = directoriesOn((machineId) => machineId === filter.machineId);
    if (items.length > 0) {
      groups.push({
        key: `machine:${filter.machineId}`,
        kind: filter.machineId === currentMachineId ? 'here' : 'machine',
        items,
        ...block(items),
      });
    }
  } else {
    const here = currentMachineId
      ? directoriesOn((machineId) => machineId === currentMachineId)
      : [];
    const elsewhere = directoriesOn((machineId) => machineId !== currentMachineId);
    if (here.length > 0) groups.push({ key: 'here', kind: 'here', items: here, ...block(here) });
    if (elsewhere.length > 0) {
      groups.push({ key: 'elsewhere', kind: 'elsewhere', items: elsewhere, ...block(elsewhere) });
    }
  }

  return {
    groups,
    disabledKeys,
    hiddenRepositoryCount: filter.kind === 'machine' ? 0 : hiddenRepositoryCount,
    machineIds: [...machineIds].sort((left, right) =>
      left === currentMachineId ? -1 : right === currentMachineId ? 1 : left.localeCompare(right)
    ),
  };
}
