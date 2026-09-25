import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLocalProjectGitHubRepoAtRootPath } from '@lody/shared/node/local-project';
import type { SessionId } from '@lody/shared';
import { resolveGitBranch, type SessionExec } from '@/lib/git/resolve-git-branch-name';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import type { ISession } from './session-manager';

const execFileAsync = promisify(execFile);

/** Git checkout facts, without provider API calls or credentials. */
export class WorkspaceGitService {
  private readonly pending = new Map<SessionId, Promise<string | null>>();

  constructor(
    private readonly deps: {
      workspaceDocument: LoroDocumentManager;
      logger: Logger;
    }
  ) {}

  async syncSession(
    sessionId: SessionId,
    session: Pick<ISession, 'exec' | 'getWorkdir'>
  ): Promise<string | null> {
    try {
      return await this.sync(sessionId, session.getWorkdir(), session.exec.bind(session));
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
        const { stdout } = await execFileAsync(command, args, {
          cwd,
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        });
        return stdout;
      },
      true
    );
  }

  private async sync(
    sessionId: SessionId,
    workdir: string,
    exec: SessionExec,
    observeLocalRepository = false
  ): Promise<string | null> {
    try {
      const doc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const meta = await doc.getMetaState();
      const ownerId = meta?.parentSessionId ?? sessionId;
      // Serialize both the probe and publication: a slow startup read must not
      // overwrite a newer turn-end or child-tab observation of this checkout.
      const previous = this.pending.get(ownerId);
      const next = (async () => {
        await previous;
        try {
          const resolution = await resolveGitBranch(exec, workdir);
          // Preserve the last named branch for worktree restore/PR discovery.
          // Detached HEAD and failed/non-Git probes never invent a branch.
          if (resolution.kind !== 'branch') return null;
          const ownerDoc =
            ownerId === sessionId
              ? doc
              : await this.deps.workspaceDocument.getOrCreateSessionDoc(ownerId);
          if ((await ownerDoc.getMetaState())?.branchName !== resolution.branch) {
            await ownerDoc.setBranchName(resolution.branch);
          }
          const project = (await ownerDoc.getMetaState())?.project;
          if (observeLocalRepository && project?.kind === 'local' && !project.githubRepoFullName) {
            const repoFullName = await getLocalProjectGitHubRepoAtRootPath(workdir);
            const current = (await ownerDoc.getMetaState())?.project;
            if (
              repoFullName &&
              current?.kind === 'local' &&
              current.localProjectId === project.localProjectId &&
              !current.githubRepoFullName
            ) {
              // Branch was published first. A newly discovered repository can never
              // start PR discovery against the previous checkout's branch.
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
      })();
      this.pending.set(ownerId, next);
      try {
        return await next;
      } finally {
        if (this.pending.get(ownerId) === next) this.pending.delete(ownerId);
      }
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to resolve workspace branch owner: ${formatErrorMessage(error)}`
      );
      return null;
    }
  }
}
