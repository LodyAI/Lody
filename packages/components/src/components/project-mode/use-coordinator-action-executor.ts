import { usePlatformCapability } from '@lody/platform/react';
import {
  COORDINATOR_CLIENT_COMMANDS,
  buildSessionTurnInputConfig,
  createCoordinatorReplyRef,
  extractLinkedSessionIdsFromText,
  getServerNow,
  getSessionRoomId,
  githubFetchPullRequestDetails,
  githubMarkPullRequestReadyForReview,
  githubMergePullRequest,
  githubSetPullRequestState,
  resolveSessionPrimaryPullRequest,
  type CoordinatorActionResolution,
  type CoordinatorActionSpec,
  type CoordinatorCardKind,
  type CoordinatorReplyRef,
  type GitHubMergeMethod,
  type SessionId,
  type SessionMeta,
  type SessionPullRequestView,
} from '@lody/shared';
import { useAtomValue, useStore } from 'jotai';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { parseGitHubReferenceUrl } from '@/components/ai-gui/github-reference-link';
import {
  setPreferredPrMergeMethod,
  usePreferredPrMergeMethod,
} from '@/components/sessions/pr-merge-method';
import { useSessionActions } from '@/hooks/use-session-actions';
import {
  isGitHubOperationTokenConnectionLostError,
  withGitHubOperationTokenRetry,
  withGitHubTokenRetry,
} from '@/lib/github-token';
import { openExternalUrl } from '@/lib/native-browser';
import { toast } from '@/lib/toast';
import {
  COORDINATOR_CARD_DISMISSED_ACTION_ID,
  COORDINATOR_CUSTOM_FEEDBACK_ACTION_ID,
  createCoordinatorActionCommandRegistry,
  type CoordinatorActionCommandContext,
  type CoordinatorActionCommandHandler,
  type CoordinatorActionCommandRegistry,
} from './coordinator-action-engine';
import { useAcceptCoordinatorTasks } from './project-board';
import type { ProjectBoardRow } from './project-board-model';

export type CoordinatorBubbleActionExecutionRequest = {
  readonly turnId: string;
  readonly bubbleId: string;
  readonly bubbleBody: string;
  readonly bubbleReplyTo?: CoordinatorReplyRef;
  readonly activeThreadRootId?: string | null;
  readonly cardKind?: CoordinatorCardKind;
  readonly action: CoordinatorActionSpec;
};

export type CoordinatorCardFeedbackRequest = {
  readonly turnId: string;
  readonly bubbleId: string;
  readonly cardTitle: string;
  readonly bubbleReplyTo?: CoordinatorReplyRef;
  readonly activeThreadRootId?: string | null;
  readonly feedback: string;
};

export type CoordinatorCardDismissRequest = {
  readonly turnId: string;
  readonly bubbleId: string;
};

function readParamString(
  params: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = params?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (key === 'sessionId') {
    return extractLinkedSessionIdsFromText(trimmed)[0] ?? trimmed;
  }
  return trimmed;
}

function readMergeMethod(
  params: Record<string, unknown> | undefined,
  fallback: GitHubMergeMethod
): GitHubMergeMethod {
  const raw = readParamString(params, 'method');
  if (raw === 'squash' || raw === 'merge' || raw === 'rebase') return raw;
  return fallback;
}

export function useCoordinatorActionExecutor(options: {
  coordinatorSessionId: SessionId;
  tasks: ReadonlyMap<string, ProjectBoardRow>;
  onOpenTask: (sessionId: string) => void;
  onOpenPr: (sessionId: string, pr: SessionPullRequestView) => void;
  onOpenExternalLink?: (href: string, label?: string) => boolean;
  onSendCoordinatorPrompt: (prompt: string, replyTo: CoordinatorReplyRef) => Promise<boolean>;
  onPrefillCoordinatorPrompt: (
    prompt: string,
    replyTo: CoordinatorReplyRef,
    activeThreadRootId?: string | null
  ) => void;
  onPrefillChildSession: (sessionId: SessionId, prompt: string) => void;
  extraCommands?: Record<string, CoordinatorActionCommandHandler>;
}): {
  executeBubbleAction: (req: CoordinatorBubbleActionExecutionRequest) => Promise<void>;
  submitCardFeedback: (req: CoordinatorCardFeedbackRequest) => Promise<boolean>;
  dismissCard: (req: CoordinatorCardDismissRequest) => Promise<void>;
  supportedCommands: ReadonlySet<string>;
  preferredMergeMethod: GitHubMergeMethod;
} {
  const {
    coordinatorSessionId,
    tasks,
    onOpenTask,
    onOpenPr,
    onOpenExternalLink,
    onSendCoordinatorPrompt,
    onPrefillCoordinatorPrompt,
    onPrefillChildSession,
    extraCommands,
  } = options;

  const { t } = useTranslation();
  const store = useStore();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const currentUser = useAtomValue(userAtom);
  const hasHostedGitHub = usePlatformCapability('githubIntegration');
  const preferredMergeMethod = usePreferredPrMergeMethod();
  const acceptTasks = useAcceptCoordinatorTasks();
  const { addSessionHistory } = useSessionActions();

  const persistActionResolution = useCallback(
    async (
      turnId: string,
      bubbleId: string,
      actionId: string,
      resolution: CoordinatorActionResolution
    ) => {
      if (!runtime) return;
      await runtime.sendResources.withSessionStore(coordinatorSessionId, async (sessionStore) => {
        await sessionStore.sessionData.commands.applyHistoryAction({
          kind: 'coordinator-action-resolved',
          turnId,
          bubbleId,
          actionId,
          resolution,
        });
      });
    },
    [coordinatorSessionId, runtime]
  );

  const resolvePrTarget = useCallback(
    (params: Record<string, unknown> | undefined, ctx: CoordinatorActionCommandContext) => {
      const sid = readParamString(params, 'sessionId');
      const explicitUrl = readParamString(params, 'prUrl') ?? readParamString(params, 'url');
      const task = sid ? ctx.tasks.get(sid) : undefined;
      const meta = sid
        ? (store.get(sessionMetaAtomFamily(getSessionRoomId(sid as SessionId))) as
            | SessionMeta
            | undefined)
        : undefined;
      const matchedTaskPr = explicitUrl
        ? task?.pullRequests?.find(
            (candidate) => candidate.url.trim().toLowerCase() === explicitUrl.toLowerCase()
          )
        : undefined;
      const prView = matchedTaskPr ?? task?.pullRequest ?? resolveSessionPrimaryPullRequest(meta);
      const url = explicitUrl ?? prView?.url ?? '';
      const parsed = url ? parseGitHubReferenceUrl(url) : null;
      const repoFullName =
        prView?.repoFullName?.trim() || (parsed ? `${parsed.owner}/${parsed.repo}` : '');
      const prNumber = prView?.number ?? (parsed?.kind === 'pull' ? parsed.number : null);
      return {
        sessionId: sid,
        prView,
        url,
        repoFullName,
        prNumber,
      };
    },
    [store]
  );

  const commandRegistry = useMemo<CoordinatorActionCommandRegistry>(() => {
    const registry = createCoordinatorActionCommandRegistry({
      [COORDINATOR_CLIENT_COMMANDS.taskAccept]: (params, ctx) => {
        const sid = readParamString(params, 'sessionId');
        const rawList = Array.isArray(params?.sessionIds)
          ? params.sessionIds.filter(
              (v): v is string => typeof v === 'string' && v.trim().length > 0
            )
          : sid
            ? [sid]
            : [];
        const expanded: string[] = [];
        for (const id of rawList) {
          const task = ctx.tasks.get(id);
          if (task?.members && task.members.length > 0) {
            for (const member of task.members) {
              expanded.push(member.session.id);
            }
          } else {
            expanded.push(id);
          }
        }
        if (expanded.length > 0) {
          acceptTasks(expanded);
        }
        return { persistResolution: true, summary: t('projectMode.board.accepted', 'Accepted') };
      },

      [COORDINATOR_CLIENT_COMMANDS.panelOpen]: (params, ctx) => {
        const target = readParamString(params, 'target') ?? 'session';
        const sid = readParamString(params, 'sessionId');
        const url = readParamString(params, 'url');
        const label = readParamString(params, 'label');
        if (target === 'pr') {
          const resolved = resolvePrTarget(params, ctx);
          if (resolved.sessionId && resolved.prView) {
            onOpenPr(resolved.sessionId, resolved.prView);
            return;
          }
          if (resolved.url) {
            if (!onOpenExternalLink?.(resolved.url, label)) {
              void openExternalUrl(resolved.url);
            }
            return;
          }
        }
        if (target === 'url' && url) {
          if (!onOpenExternalLink?.(url, label)) {
            void openExternalUrl(url);
          }
          return;
        }
        if (sid) {
          onOpenTask(sid);
          if (params?.handoff === true || ctx.cardKind === 'handoff') {
            return {
              persistResolution: true,
              summary: t('projectMode.actions.state.handoffOpened', 'Opened in side panel'),
            };
          }
        }
      },

      [COORDINATOR_CLIENT_COMMANDS.githubPrMerge]: async (params, ctx) => {
        const resolved = resolvePrTarget(params, ctx);
        if (
          !hasHostedGitHub ||
          !currentWorkspaceId ||
          !resolved.repoFullName ||
          !resolved.prNumber
        ) {
          if (resolved.sessionId && resolved.prView) {
            onOpenPr(resolved.sessionId, resolved.prView);
            return;
          }
          if (resolved.url) void openExternalUrl(resolved.url);
          return;
        }
        const method = readMergeMethod(params, preferredMergeMethod);
        setPreferredPrMergeMethod(method);
        try {
          const prDetails = await withGitHubTokenRetry(
            currentWorkspaceId,
            resolved.repoFullName,
            (token) =>
              githubFetchPullRequestDetails(token, resolved.repoFullName, resolved.prNumber!, {
                cache: 'reload',
              })
          );
          if (prDetails.stack) {
            if (resolved.url) void openExternalUrl(resolved.url);
            return;
          }
          const result = await withGitHubOperationTokenRetry(
            currentWorkspaceId,
            resolved.repoFullName,
            'write',
            (token) =>
              githubMergePullRequest(token, resolved.repoFullName, resolved.prNumber!, {
                method,
                sha: prDetails.headSha,
              })
          );
          if (!result.merged) return;
          return {
            persistResolution: true,
            summary: t('projectMode.actions.state.prMerged', '{{pr}} merged', {
              pr: `#${resolved.prNumber}`,
            }),
          };
        } catch (err) {
          if (isGitHubOperationTokenConnectionLostError(err)) return;
          const message = err instanceof Error ? err.message : String(err);
          toast.error(t('sessions.prTab.mergeError', 'Failed to merge'), { description: message });
          throw err;
        }
      },

      [COORDINATOR_CLIENT_COMMANDS.githubPrReady]: async (params, ctx) => {
        const resolved = resolvePrTarget(params, ctx);
        if (
          !hasHostedGitHub ||
          !currentWorkspaceId ||
          !resolved.repoFullName ||
          !resolved.prNumber
        ) {
          if (resolved.sessionId && resolved.prView) {
            onOpenPr(resolved.sessionId, resolved.prView);
            return;
          }
          if (resolved.url) void openExternalUrl(resolved.url);
          return;
        }
        try {
          const prDetails = await withGitHubTokenRetry(
            currentWorkspaceId,
            resolved.repoFullName,
            (token) =>
              githubFetchPullRequestDetails(token, resolved.repoFullName, resolved.prNumber!, {
                cache: 'reload',
              })
          );
          if (!prDetails.nodeId) return;
          await withGitHubOperationTokenRetry(
            currentWorkspaceId,
            resolved.repoFullName,
            'write',
            (token) => githubMarkPullRequestReadyForReview(token, prDetails.nodeId!)
          );
          return {
            persistResolution: true,
            summary: t('projectMode.actions.state.ready', 'Ready for review'),
          };
        } catch (err) {
          if (isGitHubOperationTokenConnectionLostError(err)) return;
          const message = err instanceof Error ? err.message : String(err);
          toast.error(
            t('sessions.prTab.readyForReviewError', 'Failed to mark as ready for review'),
            {
              description: message,
            }
          );
          throw err;
        }
      },

      [COORDINATOR_CLIENT_COMMANDS.githubPrClose]: async (params, ctx) => {
        const resolved = resolvePrTarget(params, ctx);
        if (
          !hasHostedGitHub ||
          !currentWorkspaceId ||
          !resolved.repoFullName ||
          !resolved.prNumber
        ) {
          if (resolved.url) void openExternalUrl(resolved.url);
          return;
        }
        try {
          await withGitHubOperationTokenRetry(
            currentWorkspaceId,
            resolved.repoFullName,
            'write',
            (token) =>
              githubSetPullRequestState(token, resolved.repoFullName, resolved.prNumber!, 'closed')
          );
          return {
            persistResolution: true,
            summary: t('projectMode.actions.state.closed', 'Closed'),
          };
        } catch (err) {
          if (isGitHubOperationTokenConnectionLostError(err)) return;
          const message = err instanceof Error ? err.message : String(err);
          toast.error(t('sessions.prTab.closeError', 'Failed to close pull request'), {
            description: message,
          });
          throw err;
        }
      },
    });

    if (extraCommands) {
      for (const [cmd, handler] of Object.entries(extraCommands)) {
        registry.register(cmd, handler);
      }
    }
    return registry;
  }, [
    acceptTasks,
    currentWorkspaceId,
    extraCommands,
    hasHostedGitHub,
    onOpenExternalLink,
    onOpenPr,
    onOpenTask,
    preferredMergeMethod,
    resolvePrTarget,
    t,
  ]);

  const supportedCommands = useMemo(() => commandRegistry.commands(), [commandRegistry]);

  const executeBubbleAction = useCallback(
    async (req: CoordinatorBubbleActionExecutionRequest) => {
      const { action, turnId, bubbleId, bubbleBody, bubbleReplyTo, activeThreadRootId, cardKind } =
        req;
      const { intent } = action;

      if (intent.kind === 'client_command') {
        const result = await commandRegistry.execute(intent.command, intent.params, {
          coordinatorSessionId,
          turnId,
          bubbleId,
          bubbleBody,
          bubbleReplyTo,
          activeThreadRootId,
          cardKind,
          action,
          tasks,
        });
        if (result?.persistResolution) {
          await persistActionResolution(turnId, bubbleId, action.id, {
            status: 'executed',
            resolvedAt: getServerNow(),
            ...(result.summary ? { summary: result.summary } : {}),
          });
        }
        return;
      }

      if (intent.kind === 'session_dispatch') {
        const targetSessionId = intent.sessionId;
        if (intent.mode === 'prefill') {
          onPrefillChildSession(targetSessionId, intent.prompt);
          return;
        }
        const targetMeta =
          tasks.get(targetSessionId)?.session ??
          (store.get(sessionMetaAtomFamily(getSessionRoomId(targetSessionId))) as
            | SessionMeta
            | undefined);
        const userId = currentUser?.id ?? targetMeta?.userId;
        if (!targetMeta || !userId) {
          onOpenTask(targetSessionId);
          return;
        }
        const inputConfig = buildSessionTurnInputConfig({
          prompt: intent.prompt,
          inputBlocks: [{ type: 'text', text: intent.prompt }],
          cliType: targetMeta.cliType,
          agentType: targetMeta.agentType,
          ...(targetMeta.acpSessionId ? { resume: targetMeta.acpSessionId } : {}),
        });
        let persistedOnAccept = false;
        await addSessionHistory(
          targetSessionId,
          {
            role: 'user',
            userId,
            timestamp: new Date(getServerNow()).toISOString(),
            status: 'pending',
            read: false,
            finished: true,
            items: [{ type: 'text', text: intent.prompt }],
            fileDiff: [],
            inputConfig,
          },
          {
            dispatch: true,
            onAccepted: () => {
              persistedOnAccept = true;
              void persistActionResolution(turnId, bubbleId, action.id, {
                status: 'executed',
                resolvedAt: getServerNow(),
              });
            },
          }
        );
        if (!persistedOnAccept) {
          await persistActionResolution(turnId, bubbleId, action.id, {
            status: 'executed',
            resolvedAt: getServerNow(),
          });
        }
        return;
      }

      const replyRef = createCoordinatorReplyRef({
        target: {
          kind: 'coordinator_bubble',
          turnId,
          bubbleId,
        },
        existingThreadRootId: activeThreadRootId ?? bubbleReplyTo?.threadRootId,
        author: 'coordinator',
        text: bubbleBody,
      });

      if (intent.mode === 'prefill') {
        onPrefillCoordinatorPrompt(intent.prompt, replyRef, activeThreadRootId);
        return;
      }

      const sent = await onSendCoordinatorPrompt(intent.prompt, replyRef);
      if (sent) {
        await persistActionResolution(turnId, bubbleId, action.id, {
          status: 'executed',
          resolvedAt: getServerNow(),
        });
      }
    },
    [
      addSessionHistory,
      commandRegistry,
      coordinatorSessionId,
      currentUser?.id,
      onOpenTask,
      onPrefillChildSession,
      onPrefillCoordinatorPrompt,
      onSendCoordinatorPrompt,
      persistActionResolution,
      store,
      tasks,
    ]
  );

  const submitCardFeedback = useCallback(
    async (req: CoordinatorCardFeedbackRequest): Promise<boolean> => {
      const trimmed = req.feedback.trim();
      if (!trimmed) return false;
      const replyRef = createCoordinatorReplyRef({
        target: {
          kind: 'coordinator_bubble',
          turnId: req.turnId,
          bubbleId: req.bubbleId,
        },
        existingThreadRootId: req.activeThreadRootId ?? req.bubbleReplyTo?.threadRootId,
        author: 'coordinator',
        text: req.cardTitle,
      });
      const sent = await onSendCoordinatorPrompt(trimmed, replyRef);
      if (sent) {
        await persistActionResolution(
          req.turnId,
          req.bubbleId,
          COORDINATOR_CUSTOM_FEEDBACK_ACTION_ID,
          {
            status: 'executed',
            resolvedAt: getServerNow(),
            summary: trimmed.slice(0, 140),
          }
        );
      }
      return sent;
    },
    [onSendCoordinatorPrompt, persistActionResolution]
  );

  const dismissCard = useCallback(
    async (req: CoordinatorCardDismissRequest): Promise<void> => {
      await persistActionResolution(
        req.turnId,
        req.bubbleId,
        COORDINATOR_CARD_DISMISSED_ACTION_ID,
        {
          status: 'dismissed',
          resolvedAt: getServerNow(),
        }
      );
    },
    [persistActionResolution]
  );

  return {
    executeBubbleAction,
    submitCardFeedback,
    dismissCard,
    supportedCommands,
    preferredMergeMethod,
  };
}
