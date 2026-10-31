import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { SessionProjectRunSchema, resolveSessionFilePath } from '@lody/shared';
import { getGitDiffStats, isWorkspaceDirty, hasUnpushedCommits } from '@/lib/git/git-diff-stats';
import { countWorkingTreeTextFileLines } from '@/lib/git/working-tree-line-count';
import { toShared } from '@/platform/process-options';
import { localProjectsLegacy } from '@lody/shared/node/local-project';
import type { SessionId, SessionProjectRun } from '@lody/shared';
import { resolveGitBranch, type SessionExec } from '@/lib/git/resolve-git-branch-name';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { CommandTimedOut, runCommandTextLegacy } from '@lody/shared/node/process';

import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import type { ISession } from './session-manager';

const ownerQueues = new WeakMap<LoroDocumentManager, Map<SessionId, Promise<unknown>>>();

/** Git checkout facts, without provider API calls or credentials. */
export class WorkspaceGitService {
  private readonly pending: Map<SessionId, Promise<unknown>>;

  constructor(
    private readonly deps: {
      workspaceDocument: LoroDocumentManager;
      logger: Logger;
    }
  ) {
    let queue = ownerQueues.get(deps.workspaceDocument);
    if (!queue) {
      queue = new Map();
      ownerQueues.set(deps.workspaceDocument, queue);
    }
    this.pending = queue;
  }

  /** Shared by observations, materialization receipts and member additions. */
  async withOwnerMutation<A>(ownerId: SessionId, operation: () => Promise<A>): Promise<A> {
    const previous = this.pending.get(ownerId);
    const next = (async () => {
      // A failed mutation must not poison later recovery or observation.
      await previous?.catch(() => undefined);
      return operation();
    })();
    this.pending.set(ownerId, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(ownerId) === next) this.pending.delete(ownerId);
    }
  }

  /** The owning daemon only; read the latest snapshot after acquiring the owner queue. */
  async updateProjectRun(
    sessionId: SessionId,
    update: (
      current: SessionProjectRun,
      publish: (run: SessionProjectRun) => Promise<void>
    ) => Promise<SessionProjectRun>
  ): Promise<void> {
    const doc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const ownerId = (await doc.getMetaState())?.parentSessionId ?? sessionId;
    await this.withOwnerMutation(ownerId, async () => {
      const ownerDoc =
        ownerId === sessionId
          ? doc
          : await this.deps.workspaceDocument.getOrCreateSessionDoc(ownerId);
      const current = (await ownerDoc.getMetaState())?.projectRun;
      if (!current) throw new Error('Missing project group snapshot');
      const publish = async (run: SessionProjectRun) => {
        await ownerDoc.setProjectRun(SessionProjectRunSchema.parse(run));
      };
      const next = await update(structuredClone(current), publish);
      await publish(next);
    });
  }

  async syncSession(
    sessionId: SessionId,
    session: Pick<ISession, 'exec' | 'getWorkdir'>,
    signal?: AbortSignal
  ): Promise<string | null> {
    try {
      return await this.sync(
        sessionId,
        session.getWorkdir(),
        async (...args) => {
          signal?.throwIfAborted();
          const output = await session.exec(...args);
          signal?.throwIfAborted();
          return output;
        },
        false,
        signal
      );
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to observe session workspace branch: ${formatErrorMessage(error)}`
      );
      return null;
    }
  }

  /** The caller must resolve and authorize the host workspace before calling. */
  syncLocalWorkspace(ownerSessionId: SessionId, workspaceRoot: string): Promise<string | null> {
    return this.sync(
      ownerSessionId,
      workspaceRoot,
      async (command, args, cwd) => {
        const { stdout } = await runCommandTextLegacy(
          {
            command,
            args,
            cwd,
            timeout: 10_000,
            maxOutputBytes: 64 * 1024,
            check: 'exit-0',
          },
          toShared()
        ).catch((error: unknown) => {
          if (error instanceof CommandTimedOut)
            this.deps.logger.warn('Workspace Git observation timed out');
          throw error;
        });
        return stdout;
      },
      true
    );
  }

  private async observeProjectRun(
    snapshot: SessionProjectRun,
    workdir: string,
    exec: SessionExec
  ): Promise<SessionProjectRun> {
    const run = SessionProjectRunSchema.parse(snapshot);
    const root = await realpath(workdir);
    for (const member of Object.values(run.members)) {
      if (member.access === 'additional' || member.access === 'link') continue;
      try {
        const cwd = await realpath(path.join(root, member.path));
        const resolved = resolveSessionFilePath([{ id: 'main', absolutePath: root }], cwd);
        if (!resolved || resolved.relativePath !== member.path)
          throw new Error('Member path escaped its project group');
        let observationFailed = false;
        const git = async (args: string[]) => {
          try {
            return await exec('git', args, cwd, false);
          } catch (error) {
            if (error instanceof CommandTimedOut) observationFailed = true;
            throw error;
          }
        };
        const repository =
          member.src.kind === 'github'
            ? member.src.repoFullName
            : await localProjectsLegacy.getLocalProjectGitHubRepoAtRootPath(cwd).catch(() => null);
        if (repository) member.repoFullName = repository;
        const branch = await resolveGitBranch(exec, cwd);
        if (branch.kind === 'branch') member.branch = branch.branch;
        const [dirty, unpushed, stats] = await Promise.all([
          isWorkspaceDirty(git),
          hasUnpushedCommits(git),
          getGitDiffStats(git, {
            preferredBaseBranch: member.base,
            countWorkingTreeFileLines: (file) => countWorkingTreeTextFileLines(cwd, file),
          }).catch(() => null),
        ]);
        if (dirty !== undefined) member.dirty = dirty;
        if (unpushed !== undefined) member.unpushed = unpushed;
        if (stats && !observationFailed) member.diff = stats.baseDiffStats.allChange;
      } catch (error) {
        this.deps.logger.debug(
          `Project group member observation failed: ${formatErrorMessage(error)}`
        );
      }
    }
    return run;
  }

  private async sync(
    sessionId: SessionId,
    workdir: string,
    exec: SessionExec,
    observeLocalRepository = false,
    signal?: AbortSignal
  ): Promise<string | null> {
    try {
      const doc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const meta = await doc.getMetaState();
      const ownerId = meta?.parentSessionId ?? sessionId;
      // Serialize both the probe and publication: a slow startup read must not
      // overwrite a newer turn-end or child-tab observation of this checkout.
      return await this.withOwnerMutation(ownerId, async () => {
        try {
          signal?.throwIfAborted();
          const ownerDoc =
            ownerId === sessionId
              ? doc
              : await this.deps.workspaceDocument.getOrCreateSessionDoc(ownerId);
          const run = (await ownerDoc.getMetaState())?.projectRun;
          if (run) {
            const observed = await this.observeProjectRun(run, workdir, exec);
            signal?.throwIfAborted();
            if (JSON.stringify(observed) !== JSON.stringify(run))
              await ownerDoc.setProjectRun(observed);
            return Object.values(observed.members).sort((a, b) => a.o - b.o)[0]?.branch ?? null;
          }
          const resolution = await resolveGitBranch(exec, workdir);
          // Preserve the last named branch for worktree restore/PR discovery.
          // Detached HEAD and failed/non-Git probes never invent a branch.
          if (resolution.kind !== 'branch') return null;
          if ((await ownerDoc.getMetaState())?.branchName !== resolution.branch) {
            signal?.throwIfAborted();
            await ownerDoc.setBranchName(resolution.branch);
          }
          const project = (await ownerDoc.getMetaState())?.project;
          if (observeLocalRepository && project?.kind === 'local' && !project.githubRepoFullName) {
            const repoFullName =
              await localProjectsLegacy.getLocalProjectGitHubRepoAtRootPath(workdir);
            const current = (await ownerDoc.getMetaState())?.project;
            if (
              repoFullName &&
              current?.kind === 'local' &&
              current.localProjectId === project.localProjectId &&
              !current.githubRepoFullName
            ) {
              // Branch was published first. A newly discovered repository can never
              // start PR discovery against the previous checkout's branch.
              signal?.throwIfAborted();
              await ownerDoc.setProject({ ...current, githubRepoFullName: repoFullName });
            }
          }
          return resolution.branch;
        } catch (error) {
          this.deps.logger.debug(
            `[${ownerId}] Failed to sync workspace branch: ${formatErrorMessage(error)}`
          );
          return null;
        }
      });
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to resolve workspace branch owner: ${formatErrorMessage(error)}`
      );
      return null;
    }
  }
}
