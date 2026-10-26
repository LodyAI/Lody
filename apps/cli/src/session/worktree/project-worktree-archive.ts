import { removeProjectMemberLinks } from './project-member-access';
import path from 'node:path';
import { mkdir, readdir, realpath, rmdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  getSessionRoomId,
  SessionProjectRunSchema,
  resolveSessionFilePath,
  type LocalProjectId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import { WorkspaceGitService } from '../workspace-git-service';
import { projectRunMetaPatch } from '../project-run-state';
import {
  projectGroupDirectory,
  resolveProjectGroupRepositories,
  type ProjectRepositoryResolutionOptions,
} from './project-worktrees';
import { getWorktreeManager } from './worktree-manager';
import { worktreeGitLegacy } from './git-execution-legacy';
import { isAllocatedSessionBranchName } from './branch-name-allocation';

/** All backups finish before deinit/removal. Any unresolved member keeps the group. */
export async function archiveProjectGroup(
  options: ProjectRepositoryResolutionOptions & {
    sessionId: SessionId;
    worktreePath: string;
    machineId: string;
    workspaceDocument: LoroDocumentManager;
    logger: Logger;
    resolveLocalRoot: (id: LocalProjectId) => Promise<string | null>;
    cleanup: (input: {
      sessionId: SessionId;
      meta: SessionMeta;
      worktreePath: string;
    }) => Promise<void>;
  }
): Promise<void> {
  const owner = new WorkspaceGitService(options);
  await owner.withOwnerMutation(options.sessionId, async () => {
    const room = getSessionRoomId(options.sessionId);
    const record = await options.workspaceDocument.repo.getDocMeta(room);
    const meta = record?.meta as SessionMeta | undefined;
    if (!meta || meta.machineId !== options.machineId || (!record?.deleted && !meta.isArchived))
      throw new Error('Project group owner is not eligible for archive');
    const run = SessionProjectRunSchema.parse(meta.projectRun);
    const reposRoot = await realpath(path.dirname(projectGroupDirectory(run)));
    const expected = path.join(reposRoot, run.root, 'worktrees', options.sessionId);
    const root = await realpath(options.worktreePath);
    if (root !== expected) throw new Error('Project group archive path mismatch');
    const repositories = await resolveProjectGroupRepositories(
      {
        ...run,
        members: Object.fromEntries(
          Object.entries(run.members).filter(
            ([, member]) => member.access !== 'additional' && member.access !== 'link'
          )
        ),
      },
      options
    );
    const entries = Object.entries(run.members)
      .filter(([, member]) => member.access !== 'additional' && member.access !== 'link')
      .sort(([, a], [, b]) => b.path.split('/').length - a.path.split('/').length);
    const managers = new Map(
      entries.map(([id, member]) => {
        const repo = repositories.get(id)!;
        return [
          id,
          getWorktreeManager({
            repoId: repo.repoId,
            source: repo.source,
            logger: options.logger,
            ...(member.placement.kind === 'root'
              ? { projectMember: { root: run.root, dir: member.placement.dir } }
              : {}),
          }),
        ];
      })
    );
    const unmaterializedSubmodules = new Set<string>();
    // Resolve and check every existing path before invoking hooks or backing up.
    for (const [id, member] of entries) {
      const memberPath = path.join(root, member.path);
      if (!existsSync(memberPath)) {
        if (member.branch) await managers.get(id)!.verifyProjectBranch(member.branch);
        else if (member.placement.kind !== 'submodule')
          throw new Error('Missing project group member has no saved branch');
        if (member.placement.kind === 'submodule') unmaterializedSubmodules.add(id);
        continue;
      }
      const actualPath = await realpath(memberPath);
      if (
        resolveSessionFilePath([{ id: 'main', absolutePath: root }], actualPath)?.relativePath !==
        member.path
      )
        throw new Error('Project group member escaped its directory');
      if (member.placement.kind !== 'submodule') continue;
      if (!existsSync(path.join(memberPath, '.git'))) {
        // Git creates empty gitlink directories before it initializes their checkout.
        // Running Git inside one would discover the parent repository instead.
        if ((await readdir(memberPath)).length)
          throw new Error(
            'Project group submodule has no independent Git checkout; preserving the project group'
          );
        if (member.branch) await managers.get(id)!.verifyProjectBranch(member.branch);
        unmaterializedSubmodules.add(id);
        continue;
      }
      const checkoutRoot = await worktreeGitLegacy.run({
        cwd: memberPath,
        args: ['rev-parse', '--show-toplevel'],
      });
      if ((await realpath(checkoutRoot)) !== actualPath)
        throw new Error(
          'Project group submodule has no independent Git checkout; preserving the project group'
        );
      // A clone can leave .git behind before checkout or branch allocation finishes.
      // Preserve that state rather than invoking hooks or backing up another branch.
      await worktreeGitLegacy.run({
        cwd: memberPath,
        args: ['rev-parse', '--verify', 'HEAD^{commit}'],
      });
      const branch = await worktreeGitLegacy.run({
        cwd: memberPath,
        args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      });
      if (!member.branch && !isAllocatedSessionBranchName(branch, options.sessionId))
        throw new Error('Project group submodule has no task branch; preserving the project group');
    }
    const emptySubmoduleDirectories = new Set<string>();
    for (const [id, member] of entries) {
      if (member.placement.kind !== 'submodule' || !unmaterializedSubmodules.has(id)) continue;
      const memberPath = path.join(root, member.path);
      if (unmaterializedSubmodules.has(member.placement.parent)) continue;
      const parent = run.members[member.placement.parent]!;
      const parentPath = path.join(root, parent.path);
      if (!existsSync(parentPath)) continue;
      const indexed = await worktreeGitLegacy.run({
        cwd: parentPath,
        args: ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', member.placement.path],
      });
      const rows = indexed.split('\0');
      if (
        rows.length !== 2 ||
        rows[1] !== '' ||
        /^160000 [a-f0-9]{40,64} 0\t([\s\S]+)$/.exec(rows[0] ?? '')?.[1] !== member.placement.path
      )
        throw new Error(
          'Missing project group submodule has no indexed gitlink; preserving the project group'
        );
      if (existsSync(memberPath)) continue;
      let ancestor = memberPath;
      while (!existsSync(ancestor)) {
        emptySubmoduleDirectories.add(ancestor);
        ancestor = path.dirname(ancestor);
      }
      if ((await realpath(ancestor)) !== ancestor)
        throw new Error('Project group member escaped its directory');
    }
    // Keep Git's untouched gitlink directories present: parent `add -A` would
    // otherwise turn an unfinished checkout into a committed submodule deletion.
    // Create only after every member/index/path check passes, without overwriting
    // a path that appeared since those checks.
    for (const directory of [...emptySubmoduleDirectories].sort(
      (a, b) => a.split(path.sep).length - b.split(path.sep).length
    ))
      await mkdir(directory);
    for (const [id, member] of entries) {
      const memberPath = path.join(root, member.path);
      if (unmaterializedSubmodules.has(id) || !existsSync(memberPath)) continue;
      try {
        const projected = projectRunMetaPatch({
          ...run,
          members: { ['member' as keyof typeof run.members]: member },
        });
        if (member.repositoryCheckout?.kind === 'local') {
          projected.project = {
            kind: 'local',
            localProjectId: member.repositoryCheckout.localProjectId,
            branch: member.base,
            useWorktree: true,
            githubRepoFullName: member.repoFullName,
          };
        }
        await options.cleanup({
          sessionId: options.sessionId,
          meta: { ...meta, ...projected },
          worktreePath: memberPath,
        });
      } catch (error) {
        options.logger.warn('Project group cleanup hook failed', error);
      }
    }
    // Unselected submodules have no persistent Member branch store. Never discard
    // their new commits when deleting their parent's Git administrative directory.
    const memberPaths = new Set(entries.map(([, member]) => member.path));
    for (const [, member] of entries) {
      if (member.placement.kind !== 'root' || !existsSync(path.join(root, member.path))) continue;
      const status = await worktreeGitLegacy.run({
        cwd: path.join(root, member.path),
        args: ['submodule', 'status', '--recursive'],
      });
      for (const line of status.split('\n')) {
        if (!line || !['+', 'U'].includes(line[0]!)) continue;
        const relative = /^[+U][a-f0-9]+ (.*?)(?: \([^\n]*\))?$/.exec(line)?.[1];
        if (!relative || !memberPaths.has(`${member.path}/${relative}`))
          throw new Error(
            'An unselected submodule has unsaved commits; preserving the project group'
          );
      }
    }
    for (const [id, member] of entries) {
      const memberPath = path.join(root, member.path);
      if (unmaterializedSubmodules.has(id) || !existsSync(memberPath)) continue;
      const manager = managers.get(id)!;
      if (member.placement.kind === 'submodule')
        member.branch = await manager.backupProjectSubmodule(memberPath, options.sessionId);
      else {
        const backup = await manager.archiveWorktree(options.sessionId, { retainWorktree: true });
        if (!backup.branchName) throw new Error('Project group member has no restorable branch');
        member.branch = backup.branchName;
      }
    }
    const fresh = await options.workspaceDocument.repo.getDocMeta(room);
    if (!fresh || (!fresh.deleted && !(fresh.meta as SessionMeta | undefined)?.isArchived))
      throw new Error('Project group was restored during archive');
    if (!fresh.deleted)
      await options.workspaceDocument.repo.upsertDocMeta(room, projectRunMetaPatch(run));
    for (const [, member] of entries) {
      if (member.placement.kind !== 'root' || !existsSync(path.join(root, member.path))) continue;
      await worktreeGitLegacy.run({
        cwd: path.join(root, member.path),
        args: ['submodule', 'deinit', '--all'],
      });
    }
    for (const [id, member] of entries) {
      if (member.placement.kind !== 'root') continue;
      if (!member.branch) throw new Error('Project group member has no saved branch');
      await managers.get(id)!.removeBackedUpProjectWorktree(options.sessionId, member.branch);
    }
    await removeProjectMemberLinks(root, run);
    // Input attachments are reproducible from their frozen blob references. Do not
    // erase other group-root files: there is no Git repository backing them up.
    const attachments = path.join(root, '.lody', 'attachments');
    if (existsSync(attachments)) {
      if (
        resolveSessionFilePath([{ id: 'main', absolutePath: root }], await realpath(attachments))
          ?.relativePath !== '.lody/attachments'
      )
        throw new Error('Project group attachments escaped the workspace');
      await rm(attachments, { recursive: true });
      await rmdir(path.join(root, '.lody'));
    }
    await rmdir(root);
  });
}
