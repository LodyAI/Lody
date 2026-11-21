import { z } from 'zod';
import { extractLinkedSessionIdsFromText } from './coordinator-threads';
import type { SessionId } from './ids';

export const COORDINATOR_ACTIONS_MAX_COUNT = 6;
export const COORDINATOR_ACTION_ID_MAX_CHARS = 128;
export const COORDINATOR_ACTION_LABEL_MAX_CHARS = 80;
export const COORDINATOR_ACTION_DESCRIPTION_MAX_CHARS = 240;
export const COORDINATOR_ACTION_DEDUP_KEY_MAX_CHARS = 200;
export const COORDINATOR_ACTION_COMMAND_MAX_CHARS = 128;
export const COORDINATOR_ACTION_PROMPT_MAX_CHARS = 8192;
export const COORDINATOR_ACTION_SUMMARY_MAX_CHARS = 160;

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
