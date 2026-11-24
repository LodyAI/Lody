import { resolveSessionPullRequests } from '@lody/shared';
import { WorkspaceGitService } from './workspace-git-service';
import {
  getSessionRoomId,
  resolveProjectGitHubRepo,
  type ProjectRef,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

import { hasUnpushedCommits, isWorkspaceDirty, type GitRunner } from '@/lib/git/git-diff-stats';
import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import { detectPullRequestForBranch, type DetectedPullRequest } from '@/lib/pr-detector';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import type { ISession } from '@/session/session-manager';
import type { CloudPrAssociationPort } from '@lody/platform';

export type TurnPostProcessingServiceDeps = {
  logger: Logger;
  workspaceDocument: LoroDocumentManager;
  workspaceId: WorkspaceId;
  prAssociation: CloudPrAssociationPort | null;
};

type SessionPullRequestMeta = NonNullable<SessionMeta['pullRequests']>[number];

type WorkspaceSessionContext = {
  ownerSessionId: SessionId;
  ownerMeta: SessionMeta | undefined;
  /** The active session's own meta, already read to find the owner. */
  activeMeta: SessionMeta | undefined;
  ownerRoomId: ReturnType<typeof getSessionRoomId>;
  pullRequests: readonly SessionPullRequestMeta[];
};

export class TurnPostProcessingService {
  constructor(private readonly deps: TurnPostProcessingServiceDeps) {}

  private gitRunner(
    session: ISession,
    signal?: AbortSignal,
    cwd = session.getWorkdir()
  ): GitRunner {
    return async (args) => {
      signal?.throwIfAborted();
      const output = await session.exec('git', args, cwd, false);
      signal?.throwIfAborted();
      return output;
    };
  }
  private resolvePullRequests(
    ownerMeta: SessionMeta | undefined,
    activeMeta: SessionMeta | undefined
  ): readonly SessionPullRequestMeta[] {
    const ownerPullRequests = resolveSessionPullRequests(ownerMeta);
    if (ownerPullRequests.length > 0) {
      return ownerPullRequests;
    }
    return resolveSessionPullRequests(activeMeta);
  }

  private async resolveWorkspaceSessionContext(
    activeSessionId: SessionId,
    activeDoc: SessionDocument
  ): Promise<WorkspaceSessionContext> {
    const activeMeta = await activeDoc.getMetaState();
    const ownerSessionId = activeMeta?.parentSessionId ?? activeSessionId;
    if (ownerSessionId === activeSessionId) {
      return {
        ownerSessionId,
        ownerMeta: activeMeta,
        activeMeta,
        ownerRoomId: getSessionRoomId(ownerSessionId),
        pullRequests: this.resolvePullRequests(activeMeta, activeMeta),
      };
    }

    const ownerDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(ownerSessionId);
    const ownerMeta = await ownerDoc.getMetaState();
    return {
      ownerSessionId,
      ownerMeta,
      activeMeta,
      ownerRoomId: getSessionRoomId(ownerSessionId),
      pullRequests: this.resolvePullRequests(ownerMeta, activeMeta),
    };
  }

  /**
   * Probe the checkout and publish `SessionMeta.workspaceDirty` +
   * `workspaceUnpushed` on the OWNER session, without touching diff stats.
   *
   * A CANCELLED turn skips the rest of finalization, but whatever the agent
   * reached is still on disk. These two flags are the only signals that raise
   * the Info Bar's `Commit & Push` action, and nothing commits or pushes on the
   * session's behalf anymore, so leaving stale `false`s here would hide real
   * unpublished work behind a PR that looks current.
   */
  async syncWorkspaceGitState(
    sessionId: SessionId,
    session: ISession,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const workspace = await this.resolveWorkspaceSessionContext(sessionId, sessionDoc);
      if (workspace.ownerMeta?.projectRun) {
        await new WorkspaceGitService(this.deps).syncSession(sessionId, session, signal);
        return;
      }
      // Gate here rather than at the cancellation callers: they reach this from
      // several sites that carry no `ProjectRef`, and a second copy of the rule
      // is how those routes drift apart. A child Tab's own meta may omit
      // `project`; it shares the owner's checkout, so the owner's binding is the
      // correct fallback.
      const project = workspace.activeMeta?.project ?? workspace.ownerMeta?.project;
      if (!resolveProjectGitHubRepo(project)) {
        return;
      }
      const runGit = this.gitRunner(session, signal);
      const metaPatch = await this.probeWorkspaceGitState(sessionId, runGit);
      if (Object.keys(metaPatch).length === 0) {
        return;
      }
      signal?.throwIfAborted();
      await this.deps.workspaceDocument.repo.upsertDocMeta(workspace.ownerRoomId, metaPatch);
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to persist workspace git state: ${formatErrorMessage(error)}`
      );
    }
  }

  /**
   * The publishable subset of `{workspaceDirty, workspaceUnpushed}`.
   *
   * An inconclusive probe (git could not be queried) contributes NO key, so the
   * durable value survives instead of being overwritten with a stale `false`.
   * The two probes are independent: one failing must not suppress the other.
   */
  private async probeWorkspaceGitState(
    sessionId: SessionId,
    runGit: GitRunner
  ): Promise<Pick<Partial<SessionMeta>, 'workspaceDirty' | 'workspaceUnpushed'>> {
    const [workspaceDirty, workspaceUnpushed] = await Promise.all([
      isWorkspaceDirty(runGit),
      hasUnpushedCommits(runGit),
    ]);
    this.deps.logger.debug(
      `[${sessionId}] Workspace dirty: ${workspaceDirty}, unpushed: ${workspaceUnpushed}`
    );
    return {
      ...(workspaceDirty !== undefined ? { workspaceDirty } : {}),
      ...(workspaceUnpushed !== undefined ? { workspaceUnpushed } : {}),
    };
  }

  async detectAndAssociatePR(ctx: {
    sessionId: SessionId;
    session: ISession;
    sessionDoc: SessionDocument;
    project?: ProjectRef;
    branchName?: string | null;
    signal?: AbortSignal;
  }): Promise<DetectedPullRequest | null> {
    const { sessionId, session, sessionDoc, project, branchName } = ctx;
    const githubRepo = resolveProjectGitHubRepo(project);
    if (!githubRepo) {
      return null;
    }

    const workdir = session.getWorkdir();
    const detected = await detectPullRequestForBranch({
      session,
      workdir,
      repoFullName: githubRepo,
      branchName: branchName ?? undefined,
      logger: this.deps.logger,
    });

    if (!detected) {
      return null;
    }

    const workspace = await this.resolveWorkspaceSessionContext(sessionId, sessionDoc);
    if (workspace.pullRequests.some((pr) => pr.status === 'open')) {
      return detected;
    }

    if (!this.deps.prAssociation) {
      return detected;
    }

    try {
      ctx.signal?.throwIfAborted();
      const associated = await this.deps.prAssociation.associatePullRequest({
        repoFullName: detected.repoFullName,
        prNumber: detected.prNumber,
        prUrl: detected.prUrl,
        branch: detected.branch,
        status: detected.status,
        ownerSessionId: workspace.ownerSessionId,
        workspaceId: this.deps.workspaceId,
      });
      if (!associated) {
        this.deps.logger.trace(`[${sessionId}] PR association backend call was rejected or paused`);
        return detected;
      }
      this.deps.logger.debug(`[${sessionId}] Associated PR #${detected.prNumber} with session`);
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] PR association backend call failed: ${formatErrorMessage(error)}`
      );
      return detected;
    }

    // The reconciler is the only association-list publisher. Turn completion
    // may establish hosted linkage, but must not race its fresh-meta writeback.
    return detected;
  }
}
