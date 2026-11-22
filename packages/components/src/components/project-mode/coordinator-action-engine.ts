import {
  COORDINATOR_CLIENT_COMMANDS,
  computeCoordinatorActionDedupKey,
  extractActionLinkedSessionIds,
  extractLinkedSessionIdsFromText,
  hasWorkspaceChanges,
  matchUserMessageToOpenCoordinatorCards,
  normalizeCoordinatorActionResolutions,
  normalizeCoordinatorActionSpecs,
  normalizeCoordinatorProactiveCard,
  normalizeSessionTurnInputConfig,
  type CoordinatorActionResolution,
  type CoordinatorActionSpec,
  type CoordinatorCardKind,
  type CoordinatorReplyRef,
  type GitHubMergeMethod,
  type MessageContent,
  type OpenCoordinatorCardCandidate,
  type SessionId,
} from '@lody/shared';
import type { ChatStreamItem } from '@/components/ai-gui/view';
import type { ProjectBoardRow } from './project-board-model';

export type CoordinatorTranslateFn = (
  key: string,
  fallback: string,
  options?: Record<string, unknown>
) => string;

export type CoordinatorActionRuleContext = {
  readonly turnId: string;
  readonly bubbleId: string;
  readonly body: string;
  readonly eligibleTasks: readonly ProjectBoardRow[];
  readonly preferredMergeMethod: GitHubMergeMethod;
  readonly translate: CoordinatorTranslateFn;
};

export type CoordinatorActionRuleProvider = {
  readonly id: string;
  produce(ctx: CoordinatorActionRuleContext): readonly CoordinatorActionSpec[];
};

export type CoordinatorActionLiveState =
  | 'ready'
  | 'running'
  | 'completed'
  | 'disabled'
  | 'dismissed';

export type ResolvedCoordinatorAction = {
  readonly spec: CoordinatorActionSpec;
  readonly dedupKey: string;
  readonly liveState: CoordinatorActionLiveState;
  readonly displayLabel: string;
  readonly wasChosen?: boolean;
  readonly statusBadgeLabel?: string;
};

export const COORDINATOR_CUSTOM_FEEDBACK_ACTION_ID = '__custom_feedback__';

export type ResolvedCoordinatorProactiveCard = {
  readonly kind: CoordinatorCardKind;
  readonly title: string;
  readonly summary?: string;
  readonly linkedTasks: readonly ProjectBoardRow[];
  readonly actions: readonly ResolvedCoordinatorAction[];
  readonly chosenAction?: ResolvedCoordinatorAction;
  readonly customFeedbackSummary?: string;
};

export type CoordinatorActionCommandContext = {
  readonly coordinatorSessionId: SessionId;
  readonly turnId: string;
  readonly bubbleId: string;
  readonly bubbleBody: string;
  readonly bubbleReplyTo?: CoordinatorReplyRef;
  readonly activeThreadRootId?: string | null;
  readonly action: CoordinatorActionSpec;
  readonly tasks: ReadonlyMap<string, ProjectBoardRow>;
};

export type CoordinatorActionCommandResult = {
  readonly persistResolution?: boolean;
  readonly summary?: string;
} | void;

export type CoordinatorActionCommandHandler = (
  params: Record<string, unknown> | undefined,
  ctx: CoordinatorActionCommandContext
) => Promise<CoordinatorActionCommandResult> | CoordinatorActionCommandResult;

export type CoordinatorActionCommandRegistry = {
  register(command: string, handler: CoordinatorActionCommandHandler): void;
  has(command: string): boolean;
  commands(): ReadonlySet<string>;
  execute(
    command: string,
    params: Record<string, unknown> | undefined,
    ctx: CoordinatorActionCommandContext
  ): Promise<CoordinatorActionCommandResult>;
};

export function createCoordinatorActionCommandRegistry(
  initial?: Record<string, CoordinatorActionCommandHandler>
): CoordinatorActionCommandRegistry {
  const map = new Map<string, CoordinatorActionCommandHandler>(
    Object.entries(initial ?? {})
  );
  return {
    register(command, handler) {
      map.set(command.trim(), handler);
    },
    has(command) {
      return map.has(command.trim());
    },
    commands() {
      return new Set(map.keys());
    },
    async execute(command, params, ctx) {
      const handler = map.get(command.trim());
      if (!handler) {
        throw new Error(`Unsupported coordinator action command: ${command}`);
      }
      return await handler(params, ctx);
    },
  };
}

export const BUILTIN_SUPPORTED_CLIENT_COMMANDS: ReadonlySet<string> = new Set(
  Object.values(COORDINATOR_CLIENT_COMMANDS)
);

export function formatCoordinatorBubbleKey(turnId: string, bubbleId: string): string {
  return `${turnId}\0${bubbleId}`;
}

export function extractBubbleLinkedSessionIds(
  entry: Extract<MessageContent, { type: 'coordinator_message' }>
): SessionId[] {
  const out: SessionId[] = [];
  const seen = new Set<string>();
  const push = (id: SessionId | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of entry.linkedSessionIds ?? []) push(id);
  for (const id of extractLinkedSessionIdsFromText(entry.body)) push(id);
  if (entry.card?.summary) {
    for (const id of extractLinkedSessionIdsFromText(entry.card.summary)) push(id);
  }
  for (const id of extractActionLinkedSessionIds(entry.card?.actions)) push(id);
  for (const id of extractActionLinkedSessionIds(entry.actions)) push(id);
  return out;
}

/**
 * Computes for each linked child `sessionId` the latest `coordinator_message`
 * bubble key (`turnId\0bubbleId`) in the stream that mentions it, so built-in
 * deterministic rules attach only to the freshest bubble per task rather than
 * repeating on every historical scrollback bubble.
 */
export function buildLatestCoordinatorBubbleByTaskId(
  items: readonly ChatStreamItem[]
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    if (item.type !== 'message' || item.message.role !== 'assistant') continue;
    for (const entry of item.message.items) {
      if (entry.type !== 'coordinator_message') continue;
      const bubbleKey = formatCoordinatorBubbleKey(item.message.id, entry.id);
      for (const sessionId of extractBubbleLinkedSessionIds(entry)) {
        map.set(sessionId, bubbleKey);
      }
    }
  }
  return map;
}

function formatTaskTag(row: ProjectBoardRow): string | null {
  return row.taskNumber !== null ? `T${row.taskNumber}` : null;
}

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

export const prWorkflowRuleProvider: CoordinatorActionRuleProvider = {
  id: 'pr-workflow',
  produce(ctx) {
    const actions: CoordinatorActionSpec[] = [];
    for (const task of ctx.eligibleTasks) {
      const sid = task.session.id;
      const taskTag = formatTaskTag(task);
      const pr = task.pullRequest;
      if (pr) {
        const prLabel = pr.number !== null ? `#${pr.number}` : 'PR';
        if (pr.status === 'draft') {
          actions.push({
            id: `rule:pr-ready:${sid}`,
            label: ctx.translate('projectMode.actions.markPrReady', 'Mark {{pr}} ready', {
              pr: prLabel,
            }),
            tone: 'primary',
            icon: 'git-pull-request',
            dedupKey: `pr.ready:${sid}`,
            source: 'rule',
            intent: {
              kind: 'client_command',
              command: COORDINATOR_CLIENT_COMMANDS.githubPrReady,
              params: { sessionId: sid, prUrl: pr.url },
            },
          });
          actions.push({
            id: `rule:pr-open:${sid}`,
            label: ctx.translate('projectMode.actions.viewPr', 'View {{pr}}', { pr: prLabel }),
            tone: 'default',
            icon: 'external-link',
            dedupKey: `panel.open:pr:${sid}`,
            source: 'rule',
            intent: {
              kind: 'client_command',
              command: COORDINATOR_CLIENT_COMMANDS.panelOpen,
              params: { target: 'pr', sessionId: sid, url: pr.url },
            },
          });
        } else if (pr.status === 'open') {
          if (pr.state?.m === 'd') {
            actions.push({
              id: `rule:pr-conflicts:${sid}`,
              label: ctx.translate(
                'projectMode.actions.resolveConflicts',
                'Resolve {{pr}} conflicts',
                { pr: prLabel }
              ),
              tone: 'primary',
              icon: 'play',
              dedupKey: `pr.resolve_conflicts:${sid}`,
              source: 'rule',
              intent: {
                kind: 'session_dispatch',
                sessionId: sid,
                mode: 'send',
                prompt: ctx.translate(
                  'projectMode.actions.prompts.resolveConflicts',
                  'Resolve the merge conflicts on this pull request, verify checks pass, and push the updated branch.'
                ),
              },
            });
          } else if (
            pr.state?.s === 'f' ||
            pr.state?.s === 'e' ||
            pr.state?.m === 'u'
          ) {
            actions.push({
              id: `rule:pr-fix-ci:${sid}`,
              label: ctx.translate('projectMode.actions.fixCi', 'Fix {{pr}} CI', { pr: prLabel }),
              tone: 'primary',
              icon: 'play',
              dedupKey: `pr.fix_ci:${sid}`,
              source: 'rule',
              intent: {
                kind: 'session_dispatch',
                sessionId: sid,
                mode: 'send',
                prompt: ctx.translate(
                  'projectMode.actions.prompts.fixCi',
                  'Investigate and fix the failing CI checks on this pull request, then push the fix.'
                ),
              },
            });
          } else if (pr.readiness === 'y') {
            actions.push({
              id: `rule:pr-merge:${sid}`,
              label: ctx.translate('projectMode.actions.mergePr', 'Merge {{pr}}', {
                pr: prLabel,
              }),
              tone: 'primary',
              icon: 'git-merge',
              dedupKey: `pr.merge:${sid}`,
              source: 'rule',
              intent: {
                kind: 'client_command',
                command: COORDINATOR_CLIENT_COMMANDS.githubPrMerge,
                params: {
                  sessionId: sid,
                  prUrl: pr.url,
                  method: ctx.preferredMergeMethod,
                },
              },
            });
          }
          actions.push({
            id: `rule:pr-open:${sid}`,
            label: ctx.translate('projectMode.actions.viewPr', 'View {{pr}}', { pr: prLabel }),
            tone: 'default',
            icon: 'git-pull-request',
            dedupKey: `panel.open:pr:${sid}`,
            source: 'rule',
            intent: {
              kind: 'client_command',
              command: COORDINATOR_CLIENT_COMMANDS.panelOpen,
              params: { target: 'pr', sessionId: sid, url: pr.url },
            },
          });
        }
      } else if (
        task.bucket === 'review' &&
        hasWorkspaceChanges(task.session.diffStats?.allChange) &&
        (task.session.project?.kind === 'github' || Boolean(task.session.repoFullName?.trim()))
      ) {
        actions.push({
          id: `rule:pr-create:${sid}`,
          label: taskTag
            ? ctx.translate('projectMode.actions.createPrForTask', 'Create PR ({{task}})', {
                task: taskTag,
              })
            : ctx.translate('projectMode.actions.createPr', 'Create PR'),
          tone: 'primary',
          icon: 'git-pull-request',
          dedupKey: `pr.create:${sid}`,
          source: 'rule',
          intent: {
            kind: 'session_dispatch',
            sessionId: sid,
            mode: 'send',
            prompt: ctx.translate(
              'projectMode.actions.prompts.createPr',
              'Commit any remaining changes if needed, push the branch, and create a pull request summarizing the changes.'
            ),
          },
        });
      }
    }
    return actions;
  },
};

export const needsYouRuleProvider: CoordinatorActionRuleProvider = {
  id: 'needs-you',
  produce(ctx) {
    const actions: CoordinatorActionSpec[] = [];
    for (const task of ctx.eligibleTasks) {
      if (task.bucket !== 'needsYou') continue;
      const sid = task.session.id;
      const taskTag = formatTaskTag(task);
      actions.push({
        id: `rule:needs-you:${sid}`,
        label: taskTag
          ? ctx.translate('projectMode.actions.respondInTask', 'Respond in {{task}}', {
              task: taskTag,
            })
          : ctx.translate('projectMode.actions.openTask', 'Open conversation'),
        tone: 'primary',
        icon: 'message-square',
        dedupKey: `panel.open:session:${sid}`,
        source: 'rule',
        intent: {
          kind: 'client_command',
          command: COORDINATOR_CLIENT_COMMANDS.panelOpen,
          params: { target: 'session', sessionId: sid },
        },
      });
    }
    return actions;
  },
};

export const taskReviewAcceptRuleProvider: CoordinatorActionRuleProvider = {
  id: 'task-review-accept',
  produce(ctx) {
    const actions: CoordinatorActionSpec[] = [];
    for (const task of ctx.eligibleTasks) {
      if (task.bucket !== 'review') continue;
      const sid = task.session.id;
      const taskTag = formatTaskTag(task);
      actions.push({
        id: `rule:task-accept:${sid}`,
        label: taskTag
          ? ctx.translate('projectMode.actions.acceptTask', 'Accept {{task}}', { task: taskTag })
          : ctx.translate('projectMode.board.accept', 'Accept'),
        tone: 'default',
        icon: 'check',
        dedupKey: `task.accept:${sid}`,
        source: 'rule',
        intent: {
          kind: 'client_command',
          command: COORDINATOR_CLIENT_COMMANDS.taskAccept,
          params: { sessionId: sid },
        },
      });
      if (!task.pullRequest) {
        actions.push({
          id: `rule:task-open:${sid}`,
          label: taskTag
            ? ctx.translate('projectMode.actions.reviewTask', 'Review {{task}}', { task: taskTag })
            : ctx.translate('projectMode.actions.openTask', 'Open conversation'),
          tone: 'default',
          icon: 'external-link',
          dedupKey: `panel.open:session:${sid}`,
          source: 'rule',
          intent: {
            kind: 'client_command',
            command: COORDINATOR_CLIENT_COMMANDS.panelOpen,
            params: { target: 'session', sessionId: sid },
          },
        });
      }
    }
    return actions;
  },
};

export const DEFAULT_COORDINATOR_RULE_PROVIDERS: readonly CoordinatorActionRuleProvider[] = [
  prWorkflowRuleProvider,
  needsYouRuleProvider,
  taskReviewAcceptRuleProvider,
];

function resolveSingleActionLiveStatus(args: {
  spec: CoordinatorActionSpec;
  dedupKey: string;
  resolution: CoordinatorActionResolution | undefined;
  tasksById: ReadonlyMap<string, ProjectBoardRow>;
  translate: CoordinatorTranslateFn;
}): { liveState: CoordinatorActionLiveState; displayLabel: string } {
  const { spec, dedupKey, resolution, tasksById, translate } = args;
  if (resolution?.status === 'dismissed') {
    return { liveState: 'dismissed', displayLabel: spec.label };
  }

  const { intent } = spec;
  if (intent.kind === 'client_command') {
    const sid = readParamString(intent.params, 'sessionId');
    const task = sid ? tasksById.get(sid) : undefined;
    const pr = task?.pullRequest ?? null;
    const prLabel = pr && pr.number !== null ? `#${pr.number}` : 'PR';

    if (intent.command === COORDINATOR_CLIENT_COMMANDS.taskAccept) {
      if (task?.bucket === 'accepted' || task?.session.isArchived) {
        return {
          liveState: 'completed',
          displayLabel: translate('projectMode.board.accepted', 'Accepted'),
        };
      }
    } else if (intent.command === COORDINATOR_CLIENT_COMMANDS.githubPrMerge) {
      if (pr?.status === 'merged') {
        return {
          liveState: 'completed',
          displayLabel: translate('projectMode.actions.state.prMerged', '{{pr}} merged', {
            pr: prLabel,
          }),
        };
      }
      if (pr?.status === 'closed') {
        return {
          liveState: 'disabled',
          displayLabel: translate('projectMode.actions.state.closed', 'Closed'),
        };
      }
      if (pr?.status === 'draft') {
        return { liveState: 'disabled', displayLabel: spec.label };
      }
    } else if (intent.command === COORDINATOR_CLIENT_COMMANDS.githubPrReady) {
      if (pr && pr.status !== 'draft') {
        return {
          liveState: 'completed',
          displayLabel:
            pr.status === 'merged'
              ? translate('projectMode.actions.state.prMerged', '{{pr}} merged', { pr: prLabel })
              : translate('projectMode.actions.state.ready', 'Ready for review'),
        };
      }
    } else if (intent.command === COORDINATOR_CLIENT_COMMANDS.githubPrClose) {
      if (pr?.status === 'closed') {
        return {
          liveState: 'completed',
          displayLabel: translate('projectMode.actions.state.closed', 'Closed'),
        };
      }
      if (pr?.status === 'merged') {
        return {
          liveState: 'completed',
          displayLabel: translate('projectMode.actions.state.prMerged', '{{pr}} merged', {
            pr: prLabel,
          }),
        };
      }
    }

    if (
      intent.command !== COORDINATOR_CLIENT_COMMANDS.panelOpen &&
      resolution?.status === 'executed'
    ) {
      return {
        liveState: 'completed',
        displayLabel: resolution.summary || spec.label,
      };
    }

    return { liveState: 'ready', displayLabel: spec.label };
  }

  if (intent.kind === 'session_dispatch') {
    const task = tasksById.get(intent.sessionId);
    const pr = task?.pullRequest ?? null;
    if (dedupKey === `pr.create:${intent.sessionId}` && pr) {
      const prLabel = pr.number !== null ? `#${pr.number}` : 'PR';
      return {
        liveState: 'completed',
        displayLabel: translate('projectMode.actions.state.prCreatedNum', '{{pr}} created', {
          pr: prLabel,
        }),
      };
    }
    if (intent.mode !== 'prefill' && resolution?.status === 'executed') {
      if (task?.bucket === 'working') {
        return {
          liveState: 'running',
          displayLabel: translate('projectMode.board.working', 'In progress'),
        };
      }
      return {
        liveState: 'completed',
        displayLabel: resolution.summary || spec.label,
      };
    }
    return { liveState: 'ready', displayLabel: spec.label };
  }

  if (intent.mode !== 'prefill' && resolution?.status === 'executed') {
    return {
      liveState: 'completed',
      displayLabel: resolution.summary || spec.label,
    };
  }
  return { liveState: 'ready', displayLabel: spec.label };
}

/**
 * Merges agent-authored actions with deterministic rule-provider actions using
 * semantic deduplication (`agent` wins over `rule`), filters unsupported future
 * client commands, and reconciles every button against live `SessionMeta` state.
 */
export function resolveCoordinatorBubbleActions(args: {
  turnId: string;
  entry: Extract<MessageContent, { type: 'coordinator_message' }>;
  tasksById: ReadonlyMap<string, ProjectBoardRow>;
  latestBubbleByTaskId?: ReadonlyMap<string, string>;
  preferredMergeMethod?: GitHubMergeMethod;
  ruleProviders?: readonly CoordinatorActionRuleProvider[];
  supportedCommands?: ReadonlySet<string>;
  translate: CoordinatorTranslateFn;
  maxActions?: number;
}): ResolvedCoordinatorAction[] {
  const {
    turnId,
    entry,
    tasksById,
    latestBubbleByTaskId,
    preferredMergeMethod = 'squash',
    ruleProviders = DEFAULT_COORDINATOR_RULE_PROVIDERS,
    supportedCommands = BUILTIN_SUPPORTED_CLIENT_COMMANDS,
    translate,
    maxActions = 5,
  } = args;

  const bubbleKey = formatCoordinatorBubbleKey(turnId, entry.id);
  const linkedIds = extractBubbleLinkedSessionIds(entry);
  const eligibleTasks: ProjectBoardRow[] = [];
  for (const sid of linkedIds) {
    if (latestBubbleByTaskId && latestBubbleByTaskId.get(sid) !== bubbleKey) continue;
    const task = tasksById.get(sid);
    if (task) eligibleTasks.push(task);
  }

  const agentSpecs = normalizeCoordinatorActionSpecs(entry.actions);
  const ruleSpecs: CoordinatorActionSpec[] = [];
  if (eligibleTasks.length > 0) {
    const ruleCtx: CoordinatorActionRuleContext = {
      turnId,
      bubbleId: entry.id,
      body: entry.body,
      eligibleTasks,
      preferredMergeMethod,
      translate,
    };
    for (const provider of ruleProviders) {
      for (const spec of provider.produce(ruleCtx)) {
        ruleSpecs.push(spec);
      }
    }
  }

  if (agentSpecs.length === 0 && ruleSpecs.length === 0) return [];

  const resolutions = normalizeCoordinatorActionResolutions(entry.actionResolutions);
  const seenDedupKeys = new Set<string>();
  const resolved: ResolvedCoordinatorAction[] = [];

  for (const spec of [...agentSpecs, ...ruleSpecs]) {
    if (resolved.length >= maxActions) break;
    if (
      spec.intent.kind === 'client_command' &&
      !supportedCommands.has(spec.intent.command.trim())
    ) {
      continue;
    }
    const dedupKey = computeCoordinatorActionDedupKey(spec);
    if (seenDedupKeys.has(dedupKey)) continue;
    seenDedupKeys.add(dedupKey);

    const { liveState, displayLabel } = resolveSingleActionLiveStatus({
      spec,
      dedupKey,
      resolution: resolutions[spec.id],
      tasksById,
      translate,
    });
    if (liveState === 'dismissed') continue;

    resolved.push({
      spec,
      dedupKey,
      liveState,
      displayLabel,
    });
  }

  return resolved;
}

/**
 * Resolves a standalone proactive next-step or decision card authored by the
 * coordinator (`entry.card` or legacy `entry.actions`), reconciling linked task
 * badges, live PR/diff state, and option execution status without attaching
 * fallback buttons onto plain chat bubbles.
 */
export function resolveCoordinatorProactiveCard(args: {
  entry: Extract<MessageContent, { type: 'coordinator_message' }>;
  tasksById: ReadonlyMap<string, ProjectBoardRow>;
  supportedCommands?: ReadonlySet<string>;
  translate: CoordinatorTranslateFn;
}): ResolvedCoordinatorProactiveCard | null {
  const {
    entry,
    tasksById,
    supportedCommands = BUILTIN_SUPPORTED_CLIENT_COMMANDS,
    translate,
  } = args;

  const normalizedCard = normalizeCoordinatorProactiveCard(entry.card);
  const legacyActions = normalizedCard ? [] : normalizeCoordinatorActionSpecs(entry.actions);
  if (!normalizedCard && legacyActions.length === 0) return null;

  const rawActions = normalizedCard ? normalizedCard.actions : legacyActions;
  const resolutions = normalizeCoordinatorActionResolutions(entry.actionResolutions);
  const seenDedupKeys = new Set<string>();
  const resolvedActions: ResolvedCoordinatorAction[] = [];

  for (const spec of rawActions) {
    if (
      spec.intent.kind === 'client_command' &&
      !supportedCommands.has(spec.intent.command.trim())
    ) {
      continue;
    }
    const dedupKey = computeCoordinatorActionDedupKey(spec);
    if (seenDedupKeys.has(dedupKey)) continue;
    seenDedupKeys.add(dedupKey);

    const resolution = resolutions[spec.id];
    const { liveState, displayLabel } = resolveSingleActionLiveStatus({
      spec,
      dedupKey,
      resolution,
      tasksById,
      translate,
    });
    if (liveState === 'dismissed') continue;

    const wasChosen = resolution?.status === 'executed';
    const statusBadgeLabel =
      liveState === 'running'
        ? translate('projectMode.board.working', 'In progress')
        : liveState === 'completed'
          ? displayLabel !== spec.label
            ? displayLabel
            : translate('projectMode.card.statusSelected', 'Selected')
          : undefined;

    resolvedActions.push({
      spec,
      dedupKey,
      liveState,
      displayLabel,
      wasChosen,
      statusBadgeLabel,
    });
  }

  const customFeedback = resolutions[COORDINATOR_CUSTOM_FEEDBACK_ACTION_ID];
  if (resolvedActions.length === 0 && !customFeedback) return null;

  const chosenAction =
    resolvedActions.find((item) => item.wasChosen) ??
    (resolvedActions.length > 0 && resolvedActions.every((item) => item.liveState === 'completed')
      ? resolvedActions[0]
      : undefined);

  const linkedIds = extractBubbleLinkedSessionIds(entry);
  const linkedTasks: ProjectBoardRow[] = [];
  for (const sid of linkedIds) {
    const task = tasksById.get(sid);
    if (task) linkedTasks.push(task);
  }

  return {
    kind: normalizedCard?.kind ?? 'next_step',
    title:
      normalizedCard?.title ??
      translate('projectMode.card.defaultTitle', 'Suggested next steps'),
    summary: normalizedCard?.summary,
    linkedTasks,
    actions: resolvedActions,
    chosenAction,
    customFeedbackSummary:
      customFeedback?.status === 'executed' ? customFeedback.summary : undefined,
  };
}

/**
 * Identifies unchosen proactive cards (`turnId\0bubbleId`) that have been
 * superseded by a subsequent user message in the composer or by newer
 * coordinator delegation to the same task, so outdated open cards hide
 * automatically once the user gives new instructions.
 */
export function buildSupersededCoordinatorCardKeys(args: {
  items: readonly ChatStreamItem[];
  tasksById?: ReadonlyMap<string, ProjectBoardRow>;
  hasPendingLocalUserMessage?: boolean;
}): ReadonlySet<string> {
  const { items, tasksById, hasPendingLocalUserMessage = false } = args;
  const superseded = new Set<string>();
  let openCards: OpenCoordinatorCardCandidate[] = [];
  let lastAssistantTurnId: string | undefined;

  for (const streamItem of items) {
    if (streamItem.type !== 'message') continue;
    const msg = streamItem.message;

    if (msg.role === 'assistant') {
      lastAssistantTurnId = msg.id;
      for (const entry of msg.items) {
        if (entry.type !== 'coordinator_message') continue;
        const normalizedCard = normalizeCoordinatorProactiveCard(entry.card);
        const legacyActions = normalizedCard
          ? []
          : normalizeCoordinatorActionSpecs(entry.actions);
        if (!normalizedCard && legacyActions.length === 0) continue;

        const actions = normalizedCard ? normalizedCard.actions : legacyActions;
        const resolutions = normalizeCoordinatorActionResolutions(entry.actionResolutions);
        const alreadyChosen =
          Boolean(resolutions[COORDINATOR_CUSTOM_FEEDBACK_ACTION_ID]?.status === 'executed') ||
          actions.some((act) => {
            const st = resolutions[act.id]?.status;
            return st === 'executed' || st === 'dismissed';
          });
        if (alreadyChosen) continue;

        const linkedIds = extractBubbleLinkedSessionIds(entry);
        const taskNumbers: number[] = [];
        const taskTitles: string[] = [];
        const prNumbers: number[] = [];
        if (tasksById) {
          for (const sid of linkedIds) {
            const task = tasksById.get(sid);
            if (!task) continue;
            if (task.taskNumber !== null) taskNumbers.push(task.taskNumber);
            if (task.session.title?.trim()) taskTitles.push(task.session.title.trim());
            if (task.pullRequest?.number !== null && task.pullRequest?.number !== undefined) {
              prNumbers.push(task.pullRequest.number);
            }
          }
        }

        openCards.push({
          key: formatCoordinatorBubbleKey(msg.id, entry.id),
          turnId: msg.id,
          bubbleId: entry.id,
          threadRootId: entry.replyTo?.threadRootId,
          cardTitle: normalizedCard?.title ?? '',
          cardSummary: normalizedCard?.summary,
          bubbleBody: entry.body,
          actionTexts: actions.flatMap((a) =>
            a.description ? [a.label, a.description] : [a.label]
          ),
          linkedSessionIds: linkedIds,
          taskNumbers,
          taskTitles,
          prNumbers,
        });
      }
      continue;
    }

    if (msg.role === 'user' && openCards.length > 0) {
      const textParts: string[] = [];
      for (const part of msg.items) {
        if (part.type === 'text' && part.text.trim()) {
          textParts.push(part.text.trim());
        }
      }
      const config = normalizeSessionTurnInputConfig(msg.inputConfig);
      const userText = textParts.join('\n\n') || config?.prompt?.trim() || '';
      const replyTo = config?.replyTo;
      const markedOpenCards = openCards.map((c) => ({
        ...c,
        isImmediatelyPrecedingTurn: c.turnId === lastAssistantTurnId,
      }));
      const matched = new Set(
        matchUserMessageToOpenCoordinatorCards({
          text: userText,
          replyToTargetTurnId: replyTo?.target.turnId,
          replyToTargetBubbleId:
            replyTo?.target.kind === 'coordinator_bubble' ? replyTo.target.bubbleId : undefined,
          replyToThreadRootId: replyTo?.threadRootId,
          openCards: markedOpenCards,
        })
      );
      if (matched.size > 0) {
        for (const key of matched) superseded.add(key);
        openCards = openCards.filter((c) => !matched.has(c.key));
      }
      lastAssistantTurnId = undefined;
      continue;
    }

    if (msg.role === 'system' && openCards.length > 0) {
      const progressedSessions = new Set<string>();
      for (const sysItem of msg.items) {
        if (sysItem.type === 'operation_progress') {
          for (const targetItem of sysItem.items) {
            progressedSessions.add(targetItem.target.sessionId);
          }
        }
      }
      if (progressedSessions.size > 0) {
        openCards = openCards.filter((c) => {
          const sids = c.linkedSessionIds ?? [];
          if (sids.length > 0 && sids.every((sid) => progressedSessions.has(sid))) {
            superseded.add(c.key);
            return false;
          }
          return true;
        });
      }
    }
  }

  if (hasPendingLocalUserMessage && openCards.length > 0) {
    const preceding = openCards.filter((c) => c.turnId === lastAssistantTurnId);
    if (preceding.length === 1) {
      superseded.add(preceding[0]!.key);
    } else if (openCards.length === 1) {
      superseded.add(openCards[0]!.key);
    }
  }

  return superseded;
}
