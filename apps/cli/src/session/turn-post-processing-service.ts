import {
  getSessionRoomId,
  resolveBaseBranchPreference,
  resolveProjectGitHubRepo,
  type ProjectRef,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

import {
  getGitDiffStats,
  hasUnpushedCommits,
  isWorkspaceDirty,
  type GitRunner,
  type GitWorkingTreeDiffBaseline,
} from '@/lib/git/git-diff-stats';
import { countWorkingTreeTextFileLines } from '@/lib/git/working-tree-line-count';
import { resolveGitBranch } from '@/lib/git/resolve-git-branch-name';
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
  preferredBaseBranch: string;
  prAssociation: CloudPrAssociationPort | null;
};

type SessionPullRequestMeta = NonNullable<SessionMeta['pullRequests']>[number];

type WorkspaceSessionContext = {
  ownerSessionId: SessionId;
  ownerDoc: SessionDocument;
  ownerMeta: SessionMeta | undefined;
  ownerRoomId: ReturnType<typeof getSessionRoomId>;
  pullRequests: readonly SessionPullRequestMeta[];
};

export class TurnPostProcessingService {
  constructor(private readonly deps: TurnPostProcessingServiceDeps) {}

  private resolvePullRequests(
    ownerMeta: SessionMeta | undefined,
    activeMeta: SessionMeta | undefined
  ): readonly SessionPullRequestMeta[] {
    const ownerPullRequests = ownerMeta?.pullRequests ?? [];
    if (ownerPullRequests.length > 0) {
      return ownerPullRequests;
    }
    return activeMeta?.pullRequests ?? [];
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
        ownerDoc: activeDoc,
        ownerMeta: activeMeta,
        ownerRoomId: getSessionRoomId(ownerSessionId),
        pullRequests: this.resolvePullRequests(activeMeta, activeMeta),
      };
    }

    const ownerDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(ownerSessionId);
    const ownerMeta = await ownerDoc.getMetaState();
    return {
      ownerSessionId,
      ownerDoc,
      ownerMeta,
      ownerRoomId: getSessionRoomId(ownerSessionId),
      pullRequests: this.resolvePullRequests(ownerMeta, activeMeta),
    };
  }

  async syncSessionBranchName(sessionId: SessionId, session: ISession): Promise<string | null> {
    const workdir = session.getWorkdir();
    const resolution = await resolveGitBranch(session.exec.bind(session), workdir);
    if (resolution.kind !== 'branch') {
      if (resolution.kind === 'unresolved') {
        // The recorded branch stays whatever it was. That matters after a
        // rename: PR discovery polls the stale name and never finds the PR.
        this.deps.logger.warn(
          `[${sessionId}] Could not resolve the current branch; SessionMeta.branchName may be stale`
        );
      } else {
        // Detached HEAD keeps the last real branch on purpose. It is normally
        // transient (inspecting a commit, bisect), and that branch is still the
        // session's own — dropping the fact would stop PR discovery for a
        // session whose PR is sitting on it. The previous code wrote the literal
        // 'HEAD' here, which polluted meta and broke discovery outright.
        this.deps.logger.debug(
          `[${sessionId}] Detached HEAD; keeping the last known SessionMeta.branchName`
        );
      }
      return null;
    }
    const branchName = resolution.branch;
    try {
      const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const workspace = await this.resolveWorkspaceSessionContext(sessionId, sessionDoc);
      if (workspace.ownerMeta?.branchName === branchName) {
        return branchName;
      }
      await workspace.ownerDoc.setBranchName(branchName);
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to sync branch name: ${formatErrorMessage(error)}`
      );
    }
    return branchName;
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
  async syncWorkspaceGitState(sessionId: SessionId, session: ISession): Promise<void> {
    try {
      const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const activeMeta = await sessionDoc.getMetaState();
      const workspace = await this.resolveWorkspaceSessionContext(sessionId, sessionDoc);
      // Gate on GitHub-capability HERE rather than at each caller. Cancellation
      // reaches this from several sites that carry no `ProjectRef`, and a second
      // copy of the rule is how the two cancel routes drift apart. A child Tab's
      // own meta may omit `project`; it shares the owner's checkout, so the
      // owner's binding is the correct fallback.
      const project = activeMeta?.project ?? workspace.ownerMeta?.project;
      if (!resolveProjectGitHubRepo(project)) {
        return;
      }
      const runGit: GitRunner = (args) => session.exec('git', args, session.getWorkdir(), false);
      const metaPatch = await this.probeWorkspaceGitState(sessionId, runGit);
      if (Object.keys(metaPatch).length === 0) {
        return;
      }
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

  async updateSessionDiffStats(
    sessionId: SessionId,
    session: ISession,
    options: {
      turnId: string;
      baseCommitHash?: string;
      turnStartWorkingTreeDiff?: GitWorkingTreeDiffBaseline | null;
      preferredBaseBranch?: string;
      skipHistoryFileDiff?: boolean;
    }
  ): Promise<SessionHistoryInput['fileDiff']> {
    const workdir = session.getWorkdir();
    const runGit: GitRunner = (args) => session.exec('git', args, workdir, false);

    let fileDiff: SessionHistoryInput['fileDiff'] = [];
    let diffStats: SessionMeta['diffStats'] = { allChange: { add: 0, del: 0 } };

    try {
      const preferredBaseBranch = resolveBaseBranchPreference({
        preferredBranch: options.preferredBaseBranch,
        fallbackBranch: this.deps.preferredBaseBranch,
      });
      const stats = await getGitDiffStats(runGit, {
        preferredBaseBranch,
        baseCommitHash: options.baseCommitHash,
        turnStartWorkingTreeDiff: options.turnStartWorkingTreeDiff,
        countWorkingTreeFileLines: (filePath) => countWorkingTreeTextFileLines(workdir, filePath),
      });
      if (stats) {
        fileDiff = stats.commitFileDiff;
        diffStats = stats.baseDiffStats;
      }
    } catch (error) {
      this.deps.logger.debug(`[${sessionId}] Failed to compute git diff stats:`, error);
    }

    // Only conclusive probes contribute a key. `undefined` means git could not be
    // queried (transient spawn failure); overwriting the durable value with a
    // stale `false` would hide Create PR / Commit & Push on a session that really
    // does have unpublished work, until a later turn recomputes it.
    const workspaceGitState = await this.probeWorkspaceGitState(sessionId, runGit);

    try {
      const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const workspace = await this.resolveWorkspaceSessionContext(sessionId, sessionDoc);
      const metaPatch: Partial<SessionMeta> = { diffStats, ...workspaceGitState };
      await this.deps.workspaceDocument.repo.upsertDocMeta(workspace.ownerRoomId, metaPatch);
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to persist session meta diffStats: ${formatErrorMessage(error)}`
      );
    }

    if (options.skipHistoryFileDiff !== true) {
      try {
        const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
        sessionDoc.setLatestAssistantHistoryFileDiff(fileDiff, options.turnId);
      } catch (error) {
        this.deps.logger.debug(`[${sessionId}] Failed to persist history fileDiff:`, error);
      }
    }
    return fileDiff;
  }

  async detectAndAssociatePR(ctx: {
    sessionId: SessionId;
    session: ISession;
    sessionDoc: SessionDocument;
    project?: ProjectRef;
    branchName?: string | null;
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
        this.deps.logger.debug(`[${sessionId}] PR association backend call was rejected`);
        return detected;
      }
      this.deps.logger.debug(`[${sessionId}] Associated PR #${detected.prNumber} with session`);
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] PR association backend call failed: ${formatErrorMessage(error)}`
      );
      return detected;
    }

    try {
      await workspace.ownerDoc.addPullRequest({
        url: detected.prUrl,
        status: detected.status,
      });
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to write PR to local doc: ${formatErrorMessage(error)}`
      );
    }
    return detected;
  }
}
