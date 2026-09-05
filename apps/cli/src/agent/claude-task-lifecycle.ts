import { z } from 'zod';
import { parseSessionNotification, type AcpSessionNotification } from '@lody/shared';
import type { LodyTaskMeta } from 'acp-extension-core';

const MAX_TITLE_LENGTH = 160;
const MAX_TEXT_LENGTH = 1_200;
const MAX_META_TEXT_LENGTH = 2_000;

const TaskUsageSchema = z
  .object({
    total_tokens: z.number().optional(),
    tool_uses: z.number().optional(),
    duration_ms: z.number().optional(),
  })
  .passthrough();

const BaseTaskMessageSchema = z
  .object({
    type: z.literal('system').optional(),
    task_id: z.string().min(1),
    tool_use_id: z.string().optional(),
    description: z.string().optional(),
    subagent_type: z.string().optional(),
    task_type: z.string().optional(),
    uuid: z.string().optional(),
    session_id: z.string().optional(),
  })
  .passthrough();

const TaskStartedMessageSchema = BaseTaskMessageSchema.extend({
  subtype: z.literal('task_started'),
  prompt: z.string().optional(),
  skip_transcript: z.boolean().optional(),
  workflow_name: z.string().optional(),
});

const TaskProgressMessageSchema = BaseTaskMessageSchema.extend({
  subtype: z.literal('task_progress'),
  usage: TaskUsageSchema.optional(),
  last_tool_name: z.string().optional(),
});

const TaskUpdatedMessageSchema = BaseTaskMessageSchema.extend({
  subtype: z.literal('task_updated'),
  patch: z
    .object({
      status: z.string().optional(),
      error: z.string().optional(),
      is_backgrounded: z.boolean().optional(),
    })
    .passthrough(),
});

const TaskNotificationMessageSchema = BaseTaskMessageSchema.extend({
  subtype: z.literal('task_notification'),
  status: z.string().optional(),
  output_file: z.string().optional(),
  summary: z.string().optional(),
  usage: TaskUsageSchema.optional(),
});

const ClaudeTaskLifecycleParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    acpSessionId: z.string().optional(),
    message: z.discriminatedUnion('subtype', [
      TaskStartedMessageSchema,
      TaskProgressMessageSchema,
      TaskUpdatedMessageSchema,
      TaskNotificationMessageSchema,
    ]),
  })
  .passthrough();

type ClaudeTaskLifecycleMessage = z.infer<typeof ClaudeTaskLifecycleParamsSchema>['message'];
type ClaudeTaskUsage = z.infer<typeof TaskUsageSchema>;
type TaskLifecycleAcpUpdate = Extract<
  AcpSessionNotification['update'],
  { sessionUpdate: 'tool_call' | 'tool_call_update' }
>;
type TaskLifecycleAcpStatus = NonNullable<
  Extract<AcpSessionNotification['update'], { sessionUpdate: 'tool_call' }>['status']
>;

export type ClaudeTaskLifecycleConversionResult =
  { ok: true; notification: AcpSessionNotification } | { ok: false; reason: string };

export type TaskLifecycleConversionOptions = {
  defaultActor: string;
};

export const convertTaskLifecycleNotification = (
  params: unknown,
  options: TaskLifecycleConversionOptions
): ClaudeTaskLifecycleConversionResult => {
  const parsed = ClaudeTaskLifecycleParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.message };
  }

  try {
    return {
      ok: true,
      notification: parseSessionNotification(
        buildTaskLifecycleAcpNotification(parsed.data.sessionId, parsed.data.message, options)
      ),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

export const convertClaudeTaskLifecycleNotification = (
  params: unknown
): ClaudeTaskLifecycleConversionResult =>
  convertTaskLifecycleNotification(params, {
    defaultActor: 'Claude task',
  });

const buildTaskLifecycleAcpNotification = (
  sessionId: string,
  message: ClaudeTaskLifecycleMessage,
  options: TaskLifecycleConversionOptions
) => {
  const taskId = message.task_id;
  const event = message.subtype;
  const rawStatus = extractRawStatus(message);
  const status = mapTaskStatus(event, rawStatus);
  const description = sanitizeText(message.description, MAX_META_TEXT_LENGTH);
  const summary =
    event === 'task_notification' ? sanitizeText(message.summary, MAX_META_TEXT_LENGTH) : undefined;
  const usage =
    event === 'task_progress' || event === 'task_notification'
      ? sanitizeUsage(message.usage)
      : undefined;
  const lastToolName =
    event === 'task_progress' ? sanitizeText(message.last_tool_name, MAX_TITLE_LENGTH) : undefined;
  const title = buildTitle(message, rawStatus, options.defaultActor);
  const contentText = buildContentText({ description, summary, rawStatus, usage, lastToolName });
  const task = buildTaskMeta({
    message,
    status,
    description,
    summary,
    usage,
    lastToolName,
    defaultActor: options.defaultActor,
  });

  const updateBase = {
    toolCallId: `task:${taskId}`,
    title,
    kind: 'think' as const,
    status,
    _meta: { lody: { task } },
    ...(contentText
      ? {
          content: [
            {
              type: 'content' as const,
              content: { type: 'text' as const, text: contentText },
            },
          ],
        }
      : {}),
  };

  const update: TaskLifecycleAcpUpdate =
    event === 'task_started'
      ? { sessionUpdate: 'tool_call', ...updateBase }
      : { sessionUpdate: 'tool_call_update', ...updateBase };

  return { sessionId, update };
};

const sanitizeText = (value: string | undefined, maxLength: number): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return truncate(trimmed, maxLength);
};

const sanitizeTitleText = (value: string | undefined): string | undefined =>
  sanitizeText(value?.replace(/\s+/g, ' '), MAX_TITLE_LENGTH);

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
};

const sanitizeUsage = (usage: ClaudeTaskUsage | undefined) => {
  if (!usage) return undefined;
  const totalTokens = sanitizeNumber(usage.total_tokens);
  const toolUses = sanitizeNumber(usage.tool_uses);
  const durationMs = sanitizeNumber(usage.duration_ms);
  if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

const sanitizeNumber = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return value;
};

const extractRawStatus = (message: ClaudeTaskLifecycleMessage): string | undefined => {
  switch (message.subtype) {
    case 'task_updated':
      return sanitizeText(message.patch.status, MAX_TITLE_LENGTH);
    case 'task_notification':
      return sanitizeText(message.status, MAX_TITLE_LENGTH);
    case 'task_started':
    case 'task_progress':
      return undefined;
  }
  return undefined;
};

const mapTaskStatus = (
  event: ClaudeTaskLifecycleMessage['subtype'],
  rawStatus: string | undefined
): TaskLifecycleAcpStatus => {
  if (event === 'task_started' || event === 'task_progress') return 'in_progress';

  const normalized = rawStatus?.trim().toLowerCase();
  switch (normalized) {
    case 'completed':
    case 'complete':
    case 'succeeded':
    case 'success':
      return 'completed';
    case 'failed':
    case 'killed':
    case 'cancelled':
    case 'canceled':
    case 'stopped':
    case 'error':
      return 'failed';
    case 'pending':
      return 'pending';
    default:
      return 'in_progress';
  }
};

const buildTitle = (
  message: ClaudeTaskLifecycleMessage,
  rawStatus: string | undefined,
  defaultActor: string
): string => {
  const actor = sanitizeTitleText(message.subagent_type) ?? defaultActor;
  const detail =
    sanitizeTitleText(message.description) ??
    (message.subtype === 'task_notification' ? sanitizeTitleText(message.summary) : undefined) ??
    sanitizeTitleText(rawStatus);
  return detail ? `${actor}: ${detail}` : actor;
};

const buildContentText = (args: {
  description: string | undefined;
  summary: string | undefined;
  rawStatus: string | undefined;
  usage: ReturnType<typeof sanitizeUsage>;
  lastToolName: string | undefined;
}): string | undefined => {
  const lines: string[] = [];
  if (args.description) lines.push(args.description);
  if (args.summary && args.summary !== args.description) lines.push(args.summary);
  if (args.lastToolName) lines.push(`Last tool: ${args.lastToolName}`);
  if (args.rawStatus) lines.push(`Status: ${args.rawStatus}`);
  const usageText = formatUsage(args.usage);
  if (usageText) lines.push(usageText);

  if (lines.length === 0) return undefined;
  return truncate(lines.join('\n'), MAX_TEXT_LENGTH);
};

const formatUsage = (usage: ReturnType<typeof sanitizeUsage>): string | undefined => {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens} tokens`);
  if (usage.toolUses !== undefined) parts.push(`${usage.toolUses} tool uses`);
  if (usage.durationMs !== undefined) parts.push(`${usage.durationMs} ms`);
  if (parts.length === 0) return undefined;
  return `Usage: ${parts.join(', ')}`;
};

const buildTaskMeta = (args: {
  message: ClaudeTaskLifecycleMessage;
  status: TaskLifecycleAcpStatus;
  description: string | undefined;
  summary: string | undefined;
  usage: ReturnType<typeof sanitizeUsage>;
  lastToolName: string | undefined;
  defaultActor: string;
}): LodyTaskMeta => {
  const { message } = args;
  const meta: Record<string, unknown> = {
    version: 1,
    taskId: message.task_id,
    kind:
      message.subtype === 'task_updated' && message.patch.is_backgrounded
        ? 'background'
        : 'subagent',
    status: args.status,
  };
  setIfDefined(
    meta,
    'actor',
    sanitizeText(
      message.subagent_type ??
        (message.subtype === 'task_started' ? message.workflow_name : undefined) ??
        message.task_type ??
        args.defaultActor,
      MAX_META_TEXT_LENGTH
    )
  );
  setIfDefined(meta, 'description', args.description);
  setIfDefined(meta, 'parentToolCallId', message.tool_use_id);
  setIfDefined(meta, 'summary', args.summary);
  setIfDefined(meta, 'usage', args.usage);
  setIfDefined(meta, 'lastToolName', args.lastToolName);
  if (message.subtype === 'task_started') {
    if (message.skip_transcript !== undefined) {
      meta.skipTranscript = message.skip_transcript;
    }
  }
  if (message.subtype === 'task_updated') {
    setIfDefined(meta, 'error', sanitizeText(message.patch.error, MAX_META_TEXT_LENGTH));
  }
  return meta as LodyTaskMeta;
};

const setIfDefined = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (value !== undefined) {
    target[key] = value;
  }
};
