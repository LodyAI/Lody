import { existsSync } from 'node:fs';
import { worktreeGitLegacy } from './git-execution-legacy';
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import {
  SessionProjectRunSchema,
  deduplicateProjectMembers,
  resolveSessionFilePath,
  type LocalProjectId,
  type SessionId,
  type SessionProjectMember,
  type SessionProjectRun,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  deriveRepoIdFromGitHubRepo,
  deriveRepoIdFromLocalProjectPath,
} from '@lody/shared/node/worktree-paths';
import { localProjectsLegacy } from '@lody/shared/node/local-project';
import type { Logger } from '@/utils/logger';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { buildGitHubCloneUrl } from '@/utils/github';
import { WorkspaceGitService } from '../workspace-git-service';
import {
  getWorktreeManager,
  type GitCredentialBrokerAuth,
  type WorktreeManagerSource,
} from './worktree-manager';

export function projectGroupDirectory(run: SessionProjectRun): string {
  return path.join(getLodyDataDir(), 'repos', SessionProjectRunSchema.parse(run).root);
}

export async function resolveProjectGroupRepositories(
  run: SessionProjectRun,
  options: {
    machineId: string;
    resolveLocalRoot: (id: LocalProjectId) => Promise<string | null>;
  }
) {
  // All local bindings must resolve before materializing the first member.
  const resolved = new Map<
    string,
    {
      source: WorktreeManagerSource;
      repoId: ReturnType<typeof deriveRepoIdFromGitHubRepo>;
      url: string;
    }
  >();
  for (const [id, member] of Object.entries(run.members)) {
    if (member.src.kind === 'github') {
      const url = buildGitHubCloneUrl(member.src.repoFullName);
      resolved.set(id, {
        repoId: deriveRepoIdFromGitHubRepo(member.src.repoFullName),
        source: { kind: 'github', repoUrl: url },
        url,
      });
    } else {
      if (member.src.machineId !== options.machineId)
        throw new Error('Project group member belongs to another machine');
      const localRoot = await options.resolveLocalRoot(member.src.localProjectId);
      if (!localRoot) throw new Error(`Project group member is unavailable: ${id}`);
      const originalRootPath = await realpath(
        await worktreeGitLegacy.run({ cwd: localRoot, args: ['rev-parse', '--show-toplevel'] })
      );
      resolved.set(id, {
        repoId: deriveRepoIdFromLocalProjectPath(originalRootPath),
        source: { kind: 'local-shared', originalRootPath },
        url: originalRootPath,
      });
    }
  }
  const identities = new Map<string, string>();
  for (const [id, member] of Object.entries(run.members)) {
    if (member.src.kind !== 'local') continue;
    const target = resolved.get(id)!;
    const state = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(target.url);
    if (!state.git) throw new Error(`Project group member is not a Git repository: ${id}`);
    if (state.githubRepoFullName) {
      identities.set(
        `${member.src.machineId}/${member.src.localProjectId}`,
        state.githubRepoFullName
      );
      target.url = buildGitHubCloneUrl(state.githubRepoFullName);
    }
  }
  if (new Set([...resolved.values()].map((target) => target.repoId)).size !== resolved.size)
    throw new Error('Project group contains the same Git root more than once');
  const definitions = Object.entries(run.members).map(([id, member]) => ({
    id: id as keyof typeof run.members,
    source: member.src,
    placement: member.placement,
  }));
  if (
    deduplicateProjectMembers(definitions, (source) => {
      const name = identities.get(`${source.machineId}/${source.localProjectId}`);
      return name ? { repoFullName: name } : undefined;
    }).length !== definitions.length
  )
    throw new Error('Project group contains duplicate repositories');
  return resolved;
}

/** Promise orchestration remains with the existing session owner and repository managers. */
export async function materializeProjectGroup(options: {
  sessionId: SessionId;
  machineId: string;
  workspaceDocument: LoroDocumentManager;
  logger: Logger;
  resolveLocalRoot: (id: LocalProjectId) => Promise<string | null>;
  brokerAuth: (source: WorktreeManagerSource) => Promise<GitCredentialBrokerAuth | undefined>;
  setup: (member: SessionProjectMember, workdir: string) => Promise<void>;
}): Promise<{ workdir: string; run: SessionProjectRun }> {
  let result!: { workdir: string; run: SessionProjectRun };
  const owner = new WorkspaceGitService(options);
  await owner.updateProjectRun(options.sessionId, async (snapshot, publish) => {
    const run = SessionProjectRunSchema.parse(snapshot);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.sessionId))
      throw new Error('Invalid session ID');
    const workdir = path.join(projectGroupDirectory(run), 'worktrees', options.sessionId);
    await mkdir(workdir, { recursive: true });
    const root = await realpath(workdir);
    const reposRoot = await realpath(path.join(getLodyDataDir(), 'repos'));
    if (
      resolveSessionFilePath([{ id: 'repos', absolutePath: reposRoot }], root)?.relativePath !==
      `${run.root}/worktrees/${options.sessionId}`
    )
      throw new Error('Project group directory escaped its storage root');
    const resolved = await resolveProjectGroupRepositories(run, options);
    const pending = new Set(Object.keys(run.members));
    const newlyCreated: SessionProjectMember[] = [];
    while (pending.size) {
      for (const id of pending) {
        const member = run.members[id as keyof typeof run.members]!;
        if (member.placement.kind === 'submodule' && pending.has(member.placement.parent)) continue;
        const target = resolved.get(id)!;
        const manager = getWorktreeManager({
          repoId: target.repoId,
          source: target.source,
          logger: options.logger,
          ...(member.placement.kind === 'root'
            ? { projectMember: { root: run.root, dir: member.placement.dir } }
            : {}),
        });
        const auth = await options.brokerAuth(target.source);
        const memberPath = path.join(root, member.path);
        if (
          existsSync(memberPath) &&
          resolveSessionFilePath([{ id: 'main', absolutePath: root }], await realpath(memberPath))
            ?.relativePath !== member.path
        )
          throw new Error('Project group member escaped its directory');
        let existed = false;
        if (member.placement.kind === 'root') {
          existed = manager.hasWorktree(options.sessionId);
          const info = await manager.createWorktree(
            options.sessionId,
            member.base,
            member.branch,
            undefined,
            auth
          );
          member.branch = info.branch;
        } else {
          const parent = run.members[member.placement.parent]!;
          const restoring = Boolean(member.branch);
          const info = await manager.materializeProjectSubmodule(
            {
              parentPath: path.join(root, parent.path),
              submodulePath: member.placement.path,
              expectedRepositoryUrl: target.url,
              sessionId: options.sessionId,
              restoreBranch: member.branch,
            },
            auth
          );
          member.branch = info.branch;
          if (!info.existed && !restoring) member.base = info.commit;
          existed = info.existed === true;
        }
        const actualPath = await realpath(memberPath);
        if (
          resolveSessionFilePath([{ id: 'main', absolutePath: root }], actualPath)?.relativePath !==
          member.path
        )
          throw new Error('Project group member escaped its directory');
        // Persist every successful branch before starting another member: retries keep identity.
        await publish(run);
        if (!existed) newlyCreated.push(member);
        pending.delete(id);
      }
    }
    for (const [id, member] of Object.entries(run.members)) {
      const target = resolved.get(id)!;
      await getWorktreeManager({
        repoId: target.repoId,
        source: target.source,
        logger: options.logger,
      }).initializeMissingProjectSubmodules(
        path.join(root, member.path),
        await options.brokerAuth(target.source)
      );
    }
    for (const member of newlyCreated) await options.setup(member, path.join(root, member.path));
    result = { workdir: root, run };
    return run;
  });
  return result;
}
