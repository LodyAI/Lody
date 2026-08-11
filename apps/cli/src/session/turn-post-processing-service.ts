import {
  getSessionRoomId,
  isDirectLocalProject,
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
import type { AutoPromptContext, AutoPromptResult } from './auto-prompt-runner';
import type { CloudPrAssociationPort } from '@lody/platform';

export type TurnPostProcessingServiceDeps = {
  logger: Logger;
  workspaceDocument: LoroDocumentManager;
  workspaceId: WorkspaceId;
  preferredBaseBranch: string;
  prAssociation: CloudPrAssociationPort | null;
  runAutoPrompt: (ctx: AutoPromptContext) => Promise<AutoPromptResult>;
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

    let workspaceDirty: boolean | undefined;
    try {
      workspaceDirty = await isWorkspaceDirty(runGit);
      this.deps.logger.debug(`[${sessionId}] Workspace dirty: ${workspaceDirty}`);
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to check workspace dirty state: ${formatErrorMessage(error)}`
      );
    }

    try {
      const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const workspace = await this.resolveWorkspaceSessionContext(sessionId, sessionDoc);
      const metaPatch: Partial<SessionMeta> = { diffStats };
      // Only persist workspaceDirty when the probe was conclusive. `undefined`
      // means git could not be queried (transient spawn failure); overwriting the
      // durable value with a stale `false` would hide Create PR / Commit & Push on
      // a genuinely dirty session until a later turn recomputes it.
      if (workspaceDirty !== undefined) {
        metaPatch.workspaceDirty = workspaceDirty;
      }
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

    let workspace: WorkspaceSessionContext | null = null;
    if (project?.kind === 'local') {
      workspace = await this.resolveWorkspaceSessionContext(sessionId, sessionDoc);
      if (isDirectLocalProject(project, workspace.ownerMeta?.isWorktree)) {
        return null;
      }
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

    workspace ??= await this.resolveWorkspaceSessionContext(sessionId, sessionDoc);
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

  async autoCommitAndPushForPR(ctx: {
    sessionId: SessionId;
    session: ISession;
    sessionDoc: SessionDocument;
    project?: ProjectRef;
    preferredBaseBranch?: string;
    isTurnCancelled?: () => boolean;
    abortSignal?: AbortSignal;
    onAutoPromptStart?: () => void | Promise<void>;
    onAutoPromptEnd?: () => void | Promise<void>;
  }): Promise<void> {
    const { sessionId, session, sessionDoc, project } = ctx;
    const isTurnCancelled = ctx.isTurnCancelled ?? (() => false);
    const shouldStop = (stage: string): boolean => {
      if (!isTurnCancelled() && !ctx.abortSignal?.aborted) {
        return false;
      }
      this.deps.logger.debug(
        `[${sessionId}] auto-commit-push: turn cancelled during ${stage}; skipping remaining work`
      );
      return true;
    };

    if (
      !resolveProjectGitHubRepo(project) ||
      (project?.kind === 'local' && project.useWorktree !== true)
    ) {
      return;
    }

    const workspace = await this.resolveWorkspaceSessionContext(sessionId, sessionDoc);
    if (workspace.pullRequests.length === 0) {
      return;
    }

    const preferredBaseBranch = ctx.preferredBaseBranch ?? project?.branch;
    const workdir = session.getWorkdir();
    const runGit: GitRunner = (args) => session.exec('git', args, workdir, false);

    for (let attempt = 0; attempt < 2; attempt++) {
      if (shouldStop('dirty state check')) {
        return;
      }

      let dirty: boolean | undefined = false;
      try {
        dirty = await isWorkspaceDirty(runGit);
      } catch (error) {
        this.deps.logger.debug(
          `[${sessionId}] auto-commit-push: failed to check dirty state: ${formatErrorMessage(error)}`
        );
        break;
      }

      // `undefined` (indeterminate) is treated as "nothing to commit" here: a
      // transient git failure must not spuriously prompt the agent to commit.
      if (!dirty) {
        break;
      }

      if (shouldStop('commit prompt')) {
        return;
      }

      this.deps.logger.debug(
        `[${sessionId}] auto-commit-push: workspace dirty, prompting agent to commit+push (attempt ${attempt + 1}/2)`
      );

      try {
        const result = await this.deps.runAutoPrompt({
          sessionId,
          session,
          sessionDoc,
          abortSignal: ctx.abortSignal,
          onPromptStart: ctx.onAutoPromptStart,
          onPromptEnd: ctx.onAutoPromptEnd,
          promptText:
            'Your workspace has uncommitted changes. Please commit all changes with an appropriate commit message and push to the remote branch.',
        });
        if (shouldStop('commit prompt completion')) {
          return;
        }
        await this.updateSessionDiffStats(sessionId, session, {
          turnId: result.turnId,
          baseCommitHash: result.baseCommitHash ?? undefined,
          turnStartWorkingTreeDiff: result.turnStartWorkingTreeDiff,
          preferredBaseBranch,
        });
      } catch (error) {
        if (shouldStop('commit prompt failure')) {
          return;
        }
        this.deps.logger.error(
          `[${sessionId}] auto-commit-push: agent prompt failed: ${formatErrorMessage(error)}`
        );
        break;
      }
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (shouldStop('unpushed state check')) {
        return;
      }

      let unpushed = false;
      try {
        unpushed = await hasUnpushedCommits(runGit);
      } catch (error) {
        this.deps.logger.debug(
          `[${sessionId}] auto-commit-push: failed to check unpushed state: ${formatErrorMessage(error)}`
        );
        break;
      }

      if (!unpushed) {
        break;
      }

      if (shouldStop('push prompt')) {
        return;
      }

      this.deps.logger.debug(
        `[${sessionId}] auto-commit-push: unpushed commits detected, prompting agent to push (attempt ${attempt + 1}/2)`
      );

      try {
        const result = await this.deps.runAutoPrompt({
          sessionId,
          session,
          sessionDoc,
          abortSignal: ctx.abortSignal,
          onPromptStart: ctx.onAutoPromptStart,
          onPromptEnd: ctx.onAutoPromptEnd,
          promptText:
            'You have local commits that have not been pushed to the remote. Please push your changes now.',
        });
        if (shouldStop('push prompt completion')) {
          return;
        }
        await this.updateSessionDiffStats(sessionId, session, {
          turnId: result.turnId,
          baseCommitHash: result.baseCommitHash ?? undefined,
          turnStartWorkingTreeDiff: result.turnStartWorkingTreeDiff,
          preferredBaseBranch,
        });
      } catch (error) {
        if (shouldStop('push prompt failure')) {
          return;
        }
        this.deps.logger.error(
          `[${sessionId}] auto-commit-push: push prompt failed: ${formatErrorMessage(error)}`
        );
        break;
      }
    }
  }
}
