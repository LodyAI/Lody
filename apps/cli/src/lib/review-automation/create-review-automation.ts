import {
  getServerNow,
  getSessionRoomId,
  hasPendingUserTurnActivation,
  type AgentConfigId,
  type MachineId,
  type ReviewerAgentRef,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { listMergedAgentConfigs } from '@/lib/agent-config-machine-flock';
import type { Logger } from '@/utils/logger';
import { ReviewAutomationEngine, type ReviewSessionFacts } from './review-automation-engine';
import { createGhRunner, createReviewGitHubClient } from './review-automation-github';
import {
  createReviewAutomationWorkspace,
  type ReviewAutomationWorkspaceHandle,
} from './review-automation-workspace';

export type CreateReviewAutomationOptions = {
  documentManager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  logger: Logger;
  /** Resolves a GitHub token for one repository; null disables merge and comments. */
  resolveGitHubToken: (repoFullName: string | null) => Promise<string | null>;
  /** Creates a child session under the authoring session. */
  createReviewerSession: (args: {
    parentSessionId: SessionId;
    prompt: string;
    agentConfigId?: AgentConfigId;
    agentType?: string;
    modeId?: string;
    modelId?: string;
    configOptionValues?: Record<string, string | boolean>;
  }) => Promise<{ sessionId: SessionId }>;
  /** Durable chat dispatch into an existing session. */
  sendChat: (sessionId: SessionId, prompt: string) => Promise<{ userTurnId: string }>;
};

/** Keeps a forwarded author reply from dominating the reviewer's prompt. */
const MAX_AUTHOR_REPLY_CHARS = 4000;

const entryText = (entry: { items?: Array<{ text?: string }> } | undefined): string =>
  (entry?.items ?? [])
    .map((item) => item.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();

/**
 * A session is busy when a turn is running or a dispatch is still pending.
 *
 * Both halves matter: status alone misses the window between the pointer being
 * written and the agent actually starting, and a prompt written into that window
 * lands behind the pending turn with the wrong context.
 */
const isSessionBusy = (meta: SessionMeta): boolean => {
  const type = meta.status?.type;
  if (type === 'running' || type === 'initializing' || type === 'requestPermission') {
    return true;
  }
  // Must match the dispatch watcher exactly: a retired activation leaves the
  // pointers unequal on purpose, so a raw comparison would wait forever.
  return hasPendingUserTurnActivation(meta);
};

export const createReviewAutomation = (
  options: CreateReviewAutomationOptions
): ReviewAutomationWorkspaceHandle => {
  const { documentManager, workspaceId, machineId, logger } = options;
  const github = createReviewGitHubClient(createGhRunner(options.resolveGitHubToken));

  // The workspace handle exists only after the engine is constructed, so the
  // no-CI grace timer is late-bound through this ref. Firing after dispose is
  // harmless: the stopped scheduler's evaluate() returns immediately.
  let reevaluate: (() => void) | null = null;

  const readSessionFacts = async (
    sessionId: SessionId
  ): Promise<ReviewSessionFacts | undefined> => {
    try {
      const doc = await documentManager.getOrCreateSessionDoc(sessionId);
      const meta = await doc.getMetaState();
      if (!meta) {
        return undefined;
      }
      return { meta, busy: isSessionBusy(meta) };
    } catch {
      return undefined;
    }
  };

  const engine = new ReviewAutomationEngine({
    repo: documentManager.repo,
    workspaceId,
    logger,
    readSessionFacts,
    createReviewerSession: async (args) =>
      options.createReviewerSession({
        parentSessionId: args.parentSessionId,
        prompt: args.prompt,
        ...(args.reviewerAgentConfigId ? { agentConfigId: args.reviewerAgentConfigId } : {}),
        ...(args.reviewerAgentType ? { agentType: args.reviewerAgentType } : {}),
        ...(args.modeId ? { modeId: args.modeId } : {}),
        ...(args.modelId ? { modelId: args.modelId } : {}),
        ...(args.configOptionValues ? { configOptionValues: args.configOptionValues } : {}),
      }),
    sendChat: options.sendChat,
    readPullRequestFacts: github.readPullRequestFacts,
    hasPendingHumanReview: github.hasPendingHumanReview,
    postPullRequestComment: github.postPullRequestComment,
    mergePullRequest: github.mergePullRequest,
    reevaluateLater: (_sessionId, delayMs) => {
      const timer = setTimeout(() => reevaluate?.(), delayMs);
      // A grace-expiry wake-up must not keep the daemon process alive.
      timer.unref?.();
    },
    readIntent: async (sessionId) => {
      try {
        const doc = await documentManager.getOrCreateSessionDoc(sessionId);
        const history = await doc.getHistory();
        const firstUserEntry = history.find((entry) => entry.role === 'user');
        return entryText(firstUserEntry) || undefined;
      } catch {
        return undefined;
      }
    },
    readLastAssistantText: async (sessionId) => {
      try {
        const doc = await documentManager.getOrCreateSessionDoc(sessionId);
        const history = await doc.getHistory();
        for (let index = history.length - 1; index >= 0; index -= 1) {
          const entry = history[index];
          if (entry?.role !== 'assistant') {
            continue;
          }
          const text = entryText(entry);
          if (text) {
            // Bounded: this is forwarded into the reviewer's prompt, and a long
            // agent turn would otherwise dominate it.
            return text.length > MAX_AUTHOR_REPLY_CHARS
              ? `${text.slice(0, MAX_AUTHOR_REPLY_CHARS)}…`
              : text;
          }
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
    isReviewerAvailable: async (reviewer: ReviewerAgentRef | undefined) => {
      // A fresh reviewer session must have the exact machine-local config
      // frozen by the settings gate. Existing runs that already own a reviewer
      // session keep progressing without re-entering this check.
      if (!reviewer?.agentConfigId) {
        return false;
      }
      try {
        const configs = await listMergedAgentConfigs(documentManager.repo, workspaceId, [
          machineId,
        ]);
        return configs.some(
          (config) =>
            config.id === reviewer.agentConfigId && config.agentType === reviewer.agentType
        );
      } catch {
        // The exact id remains the create-session selector, so an optimistic
        // retry cannot silently fall back to a different agent.
        return true;
      }
    },
    notifyNeedsUser: async (sessionId, _summary) => {
      // Reuses the existing needs-you signal rather than inventing a second
      // notification channel: every surface that already highlights a waiting
      // session picks this up for free.
      try {
        await documentManager.repo.upsertDocMeta(getSessionRoomId(sessionId), {
          awaitingUserSince: getServerNow(),
        });
      } catch (error) {
        logger.debug(
          `[review-automation] could not flag sessionId=${sessionId} as awaiting user: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    },
  });

  const handle = createReviewAutomationWorkspace({
    documentManager,
    workspaceId,
    machineId,
    logger,
    engine,
  });
  reevaluate = () => void handle.evaluate().catch(() => undefined);
  return handle;
};
