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
  rootPath?: string;
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
  /**
   * Repository rows: the workspace's GitHub integration can reach it. A
   * repository known only from a folder's remote cannot be cloned for a
   * conversation, so it is offered only as that folder.
   */
  onGithub?: boolean;
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
  > & { rootPath?: string };
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
    {
      label: string;
      description?: string;
      copies: ProjectMemberLocalProjectInput[];
      onGithub?: boolean;
    }
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
      row.onGithub = true;
    } else {
      repositories.set(key, {
        label: repo.fullName,
        description: repo.description ?? undefined,
        copies: [],
        onGithub: true,
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
      ...(row.onGithub ? { onGithub: true } : {}),
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
    rootPath: entry.project.rootPath,
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
