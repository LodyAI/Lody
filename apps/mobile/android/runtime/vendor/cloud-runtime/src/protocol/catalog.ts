import { projectAgentUsage, legacyAgentQuotas } from './agent-usage.ts';
import { pullRequestReferences } from './pull-request.ts';
import { projectRunOf } from './project-run.ts';
import type { Catalog, Project, Session } from '../models/catalog.ts';

export type { Catalog, Project, Session } from '../models/catalog.ts';

/** A connected repository can host its first session without a catalog entry. */
export function githubProject(repo: string): Project | undefined {
  if (
    repo.trim() !== repo ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
    ['.', '..'].includes(repo.split('/')[1]!)
  )
    return undefined;
  return {
    id: `github:${repo}`,
    name: repo,
    machineId: '',
    rootPath: '',
    repoFullName: repo,
  };
}

export function keepRepos(
  next: Catalog,
  previous: { projects: readonly Pick<Project, 'id' | 'repoFullName'>[] },
): Catalog {
  const known = new Map(
    previous.projects.flatMap((p) =>
      p.repoFullName ? [[p.id, p.repoFullName] as const] : [],
    ),
  );
  return {
    ...next,
    projects: next.projects.map((p) => {
      const repo = known.get(p.id);
      return p.repoFullName || !repo ? p : { ...p, repoFullName: repo };
    }),
  };
}

type Row = { key: unknown[]; value?: unknown };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
/** A `projectRun`'s GitHub member repositories, in member order. */
const runRepositories = (value: unknown): string[] => {
  const members = Object.values(object(value))
    .map(object)
    .sort((a, b) => (stamp(a.o) ?? 0) - (stamp(b.o) ?? 0));
  const repos = members.flatMap((member) => {
    const src = object(member.src);
    const repo = text(src.repoFullName).trim();
    return src.kind === 'github' && repo ? [repo] : [];
  });
  return [...new Set(repos)];
};
const stamp = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const modelOf = (value: unknown): Session['lastModel'] => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const model = object(value);
  return {
    modelId: text(model.modelId).trim() || undefined,
    name: text(model.name).trim() || undefined,
  };
};
const diffOf = (value: unknown) => {
  const change = object(object(value).allChange);
  const add = stamp(change.add) ?? 0,
    del = stamp(change.del) ?? 0;
  return add || del ? { add, del } : undefined;
};
export function projectRows(
  rows: Row[],
  mode: string,
  labels = {
    untitled: 'Untitled session',
    unknown: 'Unknown',
    local: 'Local project',
  },
): Catalog {
  const agentUsage: NonNullable<Catalog['agentUsage']> = {};
  const projects: Project[] = [],
    sessions: Session[] = [],
    machineIds = new Set<string>(),
    machineNames: Record<string, string> = {},
    machineOs: Record<string, string> = {},
    machineSimulators: NonNullable<Catalog['machineSimulators']> = {};
  if (mode !== 'meta') {
    for (const row of rows) {
      if (row.key[0] !== 'localProject' || row.value === undefined) continue;
      const value = object(row.value),
        id = text(row.key[1]);
      if (id)
        projects.push({
          id: `${mode}:local:${id}`,
          machineId: mode,
          name: text(value.name) || id,
          rootPath: text(value.rootPath),
        });
    }
    return {
      projects,
      sessions,
      machineIds: [],
      machineNames,
      agentUsage: { [mode]: projectAgentUsage(rows, mode) },
    };
  }
  const active = new Set<string>();
  const metadata = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = text(row.key[1]);
    if (row.key[0] === 'e' && row.value === true) active.add(id);
    if (row.key[0] !== 'm' || !id) continue;
    const fields =
      metadata.get(id) ?? (Object.create(null) as Record<string, unknown>);
    if (row.key.length === 2) Object.assign(fields, object(row.value));
    else if (typeof row.key[2] === 'string') {
      if (row.value === undefined) delete fields[row.key[2]];
      else fields[row.key[2]] = row.value;
    }
    metadata.set(id, fields);
  }
  for (const [id, value] of metadata) {
    if (!active.has(id)) continue;
    if (id.startsWith('machine-')) {
      const machineId = id.slice(8);
      agentUsage[machineId] = {
        configs: [],
        quotas: legacyAgentQuotas(value.raceLimits),
      };
      machineIds.add(machineId);
      const name = text(value.name);
      if (name) machineNames[machineId] = name;
      const os = text(value.os);
      if (os) machineOs[machineId] = os;
      if (value.os === 'darwin')
        machineSimulators[machineId] =
          Number(object(value.protocolCapabilities).iosSimulator) >= 1
            ? 'available'
            : 'upgrade-required';
      // Match the CLI's legacy metadata + machine Flock project merge.
      for (const [localId, item] of Object.entries(
        object(value.localProjects),
      )) {
        const project = object(item);
        projects.push({
          id: `${machineId}:local:${localId}`,
          machineId,
          name: text(project.name) || localId,
          rootPath: text(project.rootPath),
        });
      }
    }
    if (!id.startsWith('session-') || id.startsWith('session-comment-'))
      continue;
    const machineId = text(value.machineId),
      project = object(value.project);
    const localId = text(project.localProjectId),
      repo = text(project.repoFullName) || text(value.repoFullName);
    // A multi-repository project's session lists under its group (web `projectRun.id`),
    // ahead of the legacy `project` that names only its first member.
    const run = object(value.projectRun),
      runId = text(run.id);
    const projectId = runId
      ? `group:${runId}`
      : project.kind === 'local' && localId
        ? `${machineId}:local:${localId}`
        : repo
          ? `github:${repo}`
          : `${machineId}:unassigned`;
    const pullRequests = pullRequestReferences(
      value.pullRequests,
      value.pullRequestState,
    );
    const projectRun = runId ? projectRunOf(run, pullRequests) : undefined;
    sessions.push({
      lastModel: modelOf(value.lastModel),
      cliType: text(value.cliType),
      agentType: text(value.agentType),
      resume: text(value.acpSessionId),
      id: text(value.id) || id.slice(8),
      openedBySessionId: text(value.openedBySessionId).trim() || undefined,
      openedByRootSessionId:
        text(value.openedByRootSessionId).trim() || undefined,
      parentSessionId: text(value.parentSessionId).trim() || undefined,
      childSessionPlacement:
        text(value.childSessionPlacement).trim() || undefined,
      machineId,
      title: text(value.title) || labels.untitled,
      status:
        text(value.status) || text(object(value.status).type) || labels.unknown,
      archived: value.isArchived === true,
      isTabClosed: value.isTabClosed === true,
      pinned: value.isPinned === true,
      userId: text(value.userId) || undefined,
      agentConfigId: text(value.agentConfigId) || undefined,
      projectId,
      createdAt: text(value.createdAt),
      latestUserMsgId: text(value.latestUserMsgId) || undefined,
      lastMessageAt: stamp(value.lastMessageAt),
      lastReadAt: stamp(value.lastReadAt),
      lastRunningSeen: stamp(value.lastRunningSeen),
      awaitingUserSince: stamp(value.awaitingUserSince),
      branchName: text(value.branchName) || undefined,
      baseBranch:
        text(value.baseBranch).trim() ||
        text(project.branch).trim() ||
        undefined,
      iosSimulatorPreviewRequestId:
        text(value.iosSimulatorPreviewRequestId) || undefined,
      pullRequests,
      diff: diffOf(value.diffStats),
      workspaceDirty: value.workspaceDirty === true || undefined,
      workspaceUnpushed: value.workspaceUnpushed === true || undefined,
      ...(projectRun ? { projectRun } : {}),
    });
    if (runId) {
      const repositories = runRepositories(run.members);
      projects.push({
        id: projectId,
        machineId,
        name: text(run.name) || labels.local,
        rootPath: '',
        ...(repositories.length ? { repositories } : {}),
      });
    } else if (localId || repo) {
      const githubRepo = repo || text(project.githubRepoFullName);
      projects.push({
        id: projectId,
        machineId,
        name: repo || labels.local,
        rootPath: '',
        ...(githubRepo ? { repoFullName: githubRepo } : {}),
      });
    }
  }
  const unique = new Map<string, Project>();
  for (const p of projects) {
    const first = unique.get(p.id);
    if (!first) unique.set(p.id, p);
    else {
      // Group sessions may freeze different member sets; the project knows them all.
      const repositories = [
        ...new Set([...(first.repositories ?? []), ...(p.repositories ?? [])]),
      ];
      unique.set(p.id, {
        ...first,
        ...(!first.repoFullName && p.repoFullName
          ? { repoFullName: p.repoFullName }
          : {}),
        ...(repositories.length ? { repositories } : {}),
      });
    }
  }
  return {
    projects: [...unique.values()],
    sessions,
    machineIds: [...machineIds],
    machineNames,
    machineOs,
    machineSimulators,
    agentUsage,
  };
}
