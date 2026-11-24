import { z } from 'zod';
import { extractLinkedSessionIdsFromText } from './coordinator-threads';
import {
  normalizeCardSnapshotTurnBySession,
  normalizeWorkItemId,
  WORK_ITEM_ID_MAX_CHARS,
} from './coordinator-work-items';
import type { SessionId } from './ids';

export const COORDINATOR_ACTIONS_MAX_COUNT = 6;
export const COORDINATOR_ACTION_ID_MAX_CHARS = 128;
export const COORDINATOR_ACTION_LABEL_MAX_CHARS = 80;
export const COORDINATOR_ACTION_DESCRIPTION_MAX_CHARS = 240;
export const COORDINATOR_ACTION_DEDUP_KEY_MAX_CHARS = 200;
export const COORDINATOR_ACTION_COMMAND_MAX_CHARS = 128;
export const COORDINATOR_ACTION_PROMPT_MAX_CHARS = 8192;
export const COORDINATOR_ACTION_SUMMARY_MAX_CHARS = 160;
export const COORDINATOR_CARD_TITLE_MAX_CHARS = 140;
export const COORDINATOR_CARD_SUMMARY_MAX_CHARS = 600;
export const COORDINATOR_CARD_DISMISSED_ACTION_ID = '__card_dismissed__';

export const CoordinatorCardKindSchema = z.enum([
  'next_step',
  'decision',
  'review_ready',
  'handoff',
]);
export type CoordinatorCardKind = z.infer<typeof CoordinatorCardKindSchema>;

export const COORDINATOR_CLIENT_COMMANDS = {
  taskAccept: 'task.accept',
  panelOpen: 'panel.open',
  githubPrMerge: 'github.pr_merge',
  githubPrReady: 'github.pr_ready',
  githubPrClose: 'github.pr_close',
} as const;

export type BuiltinCoordinatorClientCommand =
  (typeof COORDINATOR_CLIENT_COMMANDS)[keyof typeof COORDINATOR_CLIENT_COMMANDS];

const coordinatorActionSessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .transform((raw) => {
    const extracted = extractLinkedSessionIdsFromText(raw)[0];
    return (extracted ?? raw) as SessionId;
  });

export const CoordinatorActionToneSchema = z.enum(['primary', 'default', 'danger']);
export type CoordinatorActionTone = z.infer<typeof CoordinatorActionToneSchema>;

export const CoordinatorActionSourceSchema = z.enum(['agent', 'rule']);
export type CoordinatorActionSource = z.infer<typeof CoordinatorActionSourceSchema>;

export const CoordinatorActionPromptModeSchema = z.enum(['send', 'prefill']);
export type CoordinatorActionPromptMode = z.infer<typeof CoordinatorActionPromptModeSchema>;

export const CoordinatorActionIntentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('client_command'),
      command: z.string().trim().min(1).max(COORDINATOR_ACTION_COMMAND_MAX_CHARS),
      params: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('session_dispatch'),
      sessionId: coordinatorActionSessionIdSchema,
      prompt: z.string().trim().min(1).max(COORDINATOR_ACTION_PROMPT_MAX_CHARS),
      mode: CoordinatorActionPromptModeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('coordinator_prompt'),
      prompt: z.string().trim().min(1).max(COORDINATOR_ACTION_PROMPT_MAX_CHARS),
      mode: CoordinatorActionPromptModeSchema.optional(),
    })
    .strict(),
]);

export type CoordinatorActionIntent = z.infer<typeof CoordinatorActionIntentSchema>;

export const CoordinatorActionSpecSchema = z
  .object({
    id: z.string().trim().min(1).max(COORDINATOR_ACTION_ID_MAX_CHARS),
    label: z.string().trim().min(1).max(COORDINATOR_ACTION_LABEL_MAX_CHARS),
    description: z.string().trim().max(COORDINATOR_ACTION_DESCRIPTION_MAX_CHARS).optional(),
    tone: CoordinatorActionToneSchema.optional(),
    icon: z.string().trim().min(1).max(64).optional(),
    dedupKey: z.string().trim().min(1).max(COORDINATOR_ACTION_DEDUP_KEY_MAX_CHARS).optional(),
    source: CoordinatorActionSourceSchema.optional(),
    intent: CoordinatorActionIntentSchema,
  })
  .strict();

export type CoordinatorActionSpec = z.infer<typeof CoordinatorActionSpecSchema>;

export const CoordinatorProactiveCardSpecSchema = z
  .object({
    kind: CoordinatorCardKindSchema.optional(),
    title: z.string().trim().min(1).max(COORDINATOR_CARD_TITLE_MAX_CHARS),
    summary: z.string().trim().max(COORDINATOR_CARD_SUMMARY_MAX_CHARS).optional(),
    workItemId: z.string().trim().min(1).max(WORK_ITEM_ID_MAX_CHARS).optional(),
    snapshotTurnBySession: z.record(z.string(), z.string()).optional(),
    actions: z.array(CoordinatorActionSpecSchema).min(1).max(COORDINATOR_ACTIONS_MAX_COUNT),
  })
  .strict();

export type CoordinatorProactiveCardSpec = z.infer<typeof CoordinatorProactiveCardSpecSchema>;

export const CoordinatorActionResolutionStatusSchema = z.enum(['executed', 'dismissed']);
export type CoordinatorActionResolutionStatus = z.infer<
  typeof CoordinatorActionResolutionStatusSchema
>;

export const CoordinatorActionResolutionSchema = z
  .object({
    status: CoordinatorActionResolutionStatusSchema,
    resolvedAt: z.number().finite(),
    summary: z.string().trim().max(COORDINATOR_ACTION_SUMMARY_MAX_CHARS).optional(),
  })
  .strict();

export type CoordinatorActionResolution = z.infer<typeof CoordinatorActionResolutionSchema>;

export const CoordinatorActionResolutionsMapSchema = z.record(
  z.string().trim().min(1).max(COORDINATOR_ACTION_ID_MAX_CHARS),
  CoordinatorActionResolutionSchema
);

/**
 * Normalizes a persisted or incoming `actions` array while tolerating unknown
 * future intent variants written by newer clients without failing Turn parsing.
 */
export function normalizeCoordinatorActionSpecs(raw: unknown): CoordinatorActionSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: CoordinatorActionSpec[] = [];
  const seenIds = new Set<string>();
  for (const item of raw) {
    if (out.length >= COORDINATOR_ACTIONS_MAX_COUNT) break;
    const parsed = CoordinatorActionSpecSchema.safeParse(item);
    if (!parsed.success) continue;
    if (seenIds.has(parsed.data.id)) continue;
    seenIds.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}

export function normalizeCoordinatorProactiveCard(
  raw: unknown
): CoordinatorProactiveCardSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title || title.length > COORDINATOR_CARD_TITLE_MAX_CHARS) return undefined;
  const actions = normalizeCoordinatorActionSpecs(record.actions);
  if (actions.length === 0) return undefined;
  const kindParsed = CoordinatorCardKindSchema.safeParse(record.kind);
  const summary =
    typeof record.summary === 'string' && record.summary.trim().length > 0
      ? record.summary.trim().slice(0, COORDINATOR_CARD_SUMMARY_MAX_CHARS)
      : undefined;
  const workItemId = normalizeWorkItemId(record.workItemId);
  const snapshotTurnBySession = normalizeCardSnapshotTurnBySession(record.snapshotTurnBySession);
  return {
    ...(kindParsed.success ? { kind: kindParsed.data } : {}),
    title,
    ...(summary ? { summary } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(snapshotTurnBySession ? { snapshotTurnBySession } : {}),
    actions,
  };
}

export function normalizeCoordinatorActionResolutions(
  raw: unknown
): Record<string, CoordinatorActionResolution> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, CoordinatorActionResolution> = {};
  for (const [key, value] of Object.entries(raw)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || trimmedKey.length > COORDINATOR_ACTION_ID_MAX_CHARS) continue;
    const parsed = CoordinatorActionResolutionSchema.safeParse(value);
    if (parsed.success) {
      out[trimmedKey] = parsed.data;
    }
  }
  return out;
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

const CREATE_PR_HINT_RE =
  /\b(create|open)\s+(?:a\s+)?(?:pull\s+request|pr)\b|创建\s*pr|提\s*pr|新建\s*pr|提交\s*pr/iu;
const RESOLVE_CONFLICTS_HINT_RE = /\bresolve\s+(?:merge\s+)?conflicts?\b|解决(?:合并)?冲突/iu;
const FIX_CI_HINT_RE = /\bfix\s+(?:failing\s+)?(?:ci|checks?|tests?)\b|修复\s*ci|修一下\s*ci/iu;

/**
 * Produces a stable semantic deduplication key so an agent-authored action
 * (which may include user-specific preferences such as Squash vs Rebase) wins
 * over a deterministic fallback rule targeting the same semantic step.
 */
export function computeCoordinatorActionDedupKey(action: CoordinatorActionSpec): string {
  if (action.dedupKey?.trim()) return action.dedupKey.trim();
  const { intent } = action;
  if (intent.kind === 'client_command') {
    const sessionId = readParamString(intent.params, 'sessionId') ?? '';
    switch (intent.command) {
      case COORDINATOR_CLIENT_COMMANDS.taskAccept:
        return `task.accept:${sessionId}`;
      case COORDINATOR_CLIENT_COMMANDS.githubPrMerge:
        return `pr.merge:${sessionId}`;
      case COORDINATOR_CLIENT_COMMANDS.githubPrReady:
        return `pr.ready:${sessionId}`;
      case COORDINATOR_CLIENT_COMMANDS.githubPrClose:
        return `pr.close:${sessionId}`;
      case COORDINATOR_CLIENT_COMMANDS.panelOpen: {
        const target = readParamString(intent.params, 'target') ?? 'session';
        const url = readParamString(intent.params, 'url') ?? '';
        return `panel.open:${target}:${sessionId || url}`;
      }
      default:
        return `cmd:${intent.command}:${sessionId}`;
    }
  }
  if (intent.kind === 'session_dispatch') {
    const combined = `${action.label} ${intent.prompt}`;
    if (CREATE_PR_HINT_RE.test(combined)) {
      return `pr.create:${intent.sessionId}`;
    }
    if (RESOLVE_CONFLICTS_HINT_RE.test(combined)) {
      return `pr.resolve_conflicts:${intent.sessionId}`;
    }
    if (FIX_CI_HINT_RE.test(combined)) {
      return `pr.fix_ci:${intent.sessionId}`;
    }
    return `dispatch:${intent.sessionId}:${action.label.trim().toLowerCase()}`;
  }
  return `coord_prompt:${action.label.trim().toLowerCase()}`;
}

export function extractActionLinkedSessionIds(
  actions: readonly CoordinatorActionSpec[] | undefined
): SessionId[] {
  if (!actions?.length) return [];
  const out: SessionId[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id as SessionId);
  };
  for (const action of actions) {
    if (action.intent.kind === 'session_dispatch') {
      push(action.intent.sessionId);
    } else if (action.intent.kind === 'client_command') {
      push(readParamString(action.intent.params, 'sessionId'));
    } else if (action.intent.kind === 'coordinator_prompt') {
      for (const id of extractLinkedSessionIdsFromText(action.intent.prompt)) {
        push(id);
      }
    }
  }
  return out;
}

export type OpenCoordinatorCardCandidate = {
  readonly key: string;
  readonly turnId: string;
  readonly bubbleId: string;
  readonly threadRootId?: string;
  readonly isImmediatelyPrecedingTurn?: boolean;
  readonly cardTitle: string;
  readonly cardSummary?: string;
  readonly bubbleBody?: string;
  readonly actionTexts?: readonly string[];
  readonly linkedSessionIds?: readonly string[];
  readonly taskNumbers?: readonly number[];
  readonly taskTitles?: readonly string[];
  readonly prNumbers?: readonly number[];
};

export type CoordinatorUserCardMatchInput = {
  readonly text: string;
  readonly replyToTargetTurnId?: string;
  readonly replyToTargetBubbleId?: string;
  readonly replyToThreadRootId?: string;
  readonly openCards: readonly OpenCoordinatorCardCandidate[];
};

const LATIN_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'let',
  'can',
  'you',
  'please',
  'pr',
  'pull',
  'request',
  'task',
  'session',
  'lody',
]);

const CJK_STOP_BIGRAMS = new Set([
  '这个',
  '那个',
  '可以',
  '一下',
  '我们',
  '你们',
  '他们',
  '给我',
  '帮我',
  '什么',
  '怎么',
  '如果',
  '然后',
  '现在',
  '已经',
  '需要',
  '不要',
  '先不',
  '还是',
  '或者',
  '觉得',
  '一些',
  '一样',
  '一个',
  '先看',
  '看看',
  '处理',
  '修改',
  '问题',
  '任务',
  '对话',
  '直接',
  '顺便',
  '继续',
]);

function extractCardMatchTokens(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens = new Set<string>();
  for (const match of lowered.matchAll(/[a-z0-9_-]{2,}/gu)) {
    const word = match[0];
    if (word && !LATIN_STOPWORDS.has(word) && !/^t\d+$/u.test(word)) {
      tokens.add(word);
    }
  }
  for (const match of lowered.matchAll(/\p{Script=Han}{2,}/gu)) {
    const run = match[0];
    if (!run) continue;
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const bigram = `${chars[i]}${chars[i + 1]}`;
      if (!CJK_STOP_BIGRAMS.has(bigram)) {
        tokens.add(bigram);
      }
    }
  }
  return Array.from(tokens);
}

/**
 * Resolves which open proactive coordinator card(s) a user's composer message
 * refers to, combining explicit reply anchors, `T<n>` / `#PR` / session-link
 * references, CJK/Latin topic overlap, and immediate-turn adjacency.
 */
export function matchUserMessageToOpenCoordinatorCards(
  input: CoordinatorUserCardMatchInput
): string[] {
  const { openCards } = input;
  if (openCards.length === 0) return [];

  if (input.replyToTargetTurnId && input.replyToTargetBubbleId) {
    const exact = openCards.filter(
      (c) => c.turnId === input.replyToTargetTurnId && c.bubbleId === input.replyToTargetBubbleId
    );
    if (exact.length > 0) return exact.map((c) => c.key);
  }

  if (input.replyToThreadRootId) {
    const byThread = openCards.filter((c) => c.threadRootId === input.replyToThreadRootId);
    if (byThread.length > 0) return byThread.map((c) => c.key);
  }

  const trimmed = input.text.trim();
  if (!trimmed) return [];

  const mentionedSessions = new Set<string>(extractLinkedSessionIdsFromText(trimmed));
  const mentionedTasks = new Set<number>();
  for (const m of trimmed.matchAll(/(?:^|[^a-z0-9])t(\d{1,4})(?=$|[^a-z0-9])/giu)) {
    mentionedTasks.add(Number(m[1]));
  }
  const mentionedPrs = new Set<number>();
  for (const m of trimmed.matchAll(/(?:^|[^\w/])#(\d{1,7})\b/gu)) {
    mentionedPrs.add(Number(m[1]));
  }
  const userTokens = extractCardMatchTokens(trimmed);

  const scored = openCards.map((card, index) => {
    let score = 0;
    if (card.linkedSessionIds?.some((sid) => mentionedSessions.has(sid))) {
      score += 120;
    }
    if (card.taskNumbers?.some((num) => mentionedTasks.has(num))) {
      score += 100;
    }
    if (card.prNumbers?.some((pr) => mentionedPrs.has(pr))) {
      score += 100;
    }
    if (userTokens.length > 0) {
      const corpus = [
        card.cardTitle,
        card.cardSummary,
        card.bubbleBody,
        ...(card.taskTitles ?? []),
        ...(card.actionTexts ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      for (const token of userTokens) {
        if (corpus.includes(token)) {
          score += 12;
        }
      }
    }
    if (score > 0 && card.isImmediatelyPrecedingTurn) {
      score += 4;
    }
    return { card, score, index };
  });

  const maxScore = Math.max(...scored.map((item) => item.score));
  if (maxScore >= 100) {
    return scored
      .filter((item) => item.score >= 100)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .map((item) => item.card.key);
  }
  if (maxScore > 0) {
    const cutoff = Math.max(12, maxScore * 0.65);
    return scored
      .filter((item) => item.score >= cutoff)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .map((item) => item.card.key);
  }

  const preceding = openCards.filter((c) => c.isImmediatelyPrecedingTurn);
  if (preceding.length === 1) {
    return [preceding[0]!.key];
  }
  if (openCards.length === 1) {
    return [openCards[0]!.key];
  }
  return [];
}
