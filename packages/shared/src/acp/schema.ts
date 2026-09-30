import type {
  AvailableCommandsUpdate,
  ConfigOptionUpdate,
  ContentBlock,
  CurrentModeUpdate,
  Plan,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { isLodySubagentEvent, type LodySubagentEvent } from 'acp-extension-core';

const zMeta = z.record(z.string(), z.unknown()).nullish();

const withMeta = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      ...shape,
      _meta: zMeta,
    })
    .passthrough();

const zAnnotations = withMeta({
  audience: z.array(z.enum(['assistant', 'user'])).nullish(),
  lastModified: z.string().nullish(),
  priority: z.number().nullish(),
});

export const zContentBlock = z.discriminatedUnion('type', [
  withMeta({
    type: z.literal('text'),
    text: z.string(),
    annotations: zAnnotations.nullish(),
  }),
  withMeta({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
    uri: z.string().nullish(),
    annotations: zAnnotations.nullish(),
  }),
  withMeta({
    type: z.literal('audio'),
    data: z.string(),
    mimeType: z.string(),
    annotations: zAnnotations.nullish(),
  }),
  withMeta({
    type: z.literal('resource_link'),
    name: z.string(),
    uri: z.string(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    mimeType: z.string().nullish(),
    size: z.number().nullish(),
    annotations: zAnnotations.nullish(),
  }),
  withMeta({
    type: z.literal('resource'),
    resource: z.union([
      withMeta({ uri: z.string(), text: z.string(), mimeType: z.string().nullish() }),
      withMeta({ uri: z.string(), blob: z.string(), mimeType: z.string().nullish() }),
    ]),
    annotations: zAnnotations.nullish(),
  }),
]);

const zToolKind = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);
const zToolCallStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);
const zToolCallLocation = withMeta({
  path: z.string(),
  line: z.number().int().nonnegative().nullish(),
});
const zToolCallContent = z.union([
  withMeta({ type: z.literal('content'), content: zContentBlock }),
  withMeta({
    type: z.literal('diff'),
    path: z.string(),
    oldText: z.string().nullish(),
    newText: z.string(),
  }),
  withMeta({ type: z.literal('terminal'), terminalId: z.string() }),
]);

export const zToolCall = withMeta({
  toolCallId: z.string(),
  title: z.string(),
  kind: zToolKind.optional(),
  status: zToolCallStatus.optional(),
  content: z.array(zToolCallContent).optional().default([]),
  locations: z.array(zToolCallLocation).optional().default([]),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});

export const zToolCallUpdate = withMeta({
  toolCallId: z.string(),
  kind: zToolKind.nullish(),
  status: zToolCallStatus.nullish(),
  title: z.string().nullish(),
  content: z.array(zToolCallContent).nullish(),
  locations: z.array(zToolCallLocation).nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});

const zPlanEntry = withMeta({
  content: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

export const zPlan = withMeta({ entries: z.array(zPlanEntry) });

const zPlanUpdateContent = z.discriminatedUnion('type', [
  withMeta({ type: z.literal('items'), planId: z.string(), entries: z.array(zPlanEntry) }),
  withMeta({ type: z.literal('file'), planId: z.string(), uri: z.string() }),
  withMeta({ type: z.literal('markdown'), planId: z.string(), content: z.string() }),
]);

const zAvailableCommand = withMeta({
  name: z.string(),
  description: z.string(),
  input: withMeta({ hint: z.string() }).nullish(),
});

export const zAvailableCommandsUpdate = withMeta({
  availableCommands: z.array(zAvailableCommand),
});

export const zCurrentModeUpdate = withMeta({ currentModeId: z.string() });

// Config option variants are negotiated by ACP capabilities. Keep their payload intact while
// validating the stable update envelope so new SDK option kinds remain forward compatible.
export const zConfigOptionUpdate = withMeta({
  configOptions: z.array(z.record(z.string(), z.unknown())),
});

const zContentChunk = withMeta({
  content: zContentBlock,
  messageId: z.string().nullish(),
});

export const zSessionUpdate = z.discriminatedUnion('sessionUpdate', [
  withMeta({
    sessionUpdate: z.literal('subagent_event'),
    event: z.custom<LodySubagentEvent>(isLodySubagentEvent),
  }),
  zContentChunk.extend({ sessionUpdate: z.literal('user_message_chunk') }),
  zContentChunk.extend({ sessionUpdate: z.literal('agent_message_chunk') }),
  zContentChunk.extend({ sessionUpdate: z.literal('agent_thought_chunk') }),
  zToolCall.extend({ sessionUpdate: z.literal('tool_call') }),
  zToolCallUpdate.extend({ sessionUpdate: z.literal('tool_call_update') }),
  zPlan.extend({ sessionUpdate: z.literal('plan') }),
  withMeta({ sessionUpdate: z.literal('plan_update'), plan: zPlanUpdateContent }),
  withMeta({ sessionUpdate: z.literal('plan_removed'), planId: z.string() }),
  zAvailableCommandsUpdate.extend({ sessionUpdate: z.literal('available_commands_update') }),
  zCurrentModeUpdate.extend({ sessionUpdate: z.literal('current_mode_update') }),
  zConfigOptionUpdate.extend({ sessionUpdate: z.literal('config_option_update') }),
  withMeta({
    sessionUpdate: z.literal('session_info_update'),
    title: z.string().nullish(),
    updatedAt: z.string().nullish(),
  }),
  withMeta({
    sessionUpdate: z.literal('usage_update'),
    used: z.number(),
    size: z.number(),
    cost: withMeta({ amount: z.number(), currency: z.string() }).nullish(),
  }),
]);

export const zSessionNotification = withMeta({
  sessionId: z.string(),
  update: zSessionUpdate,
});

export type AcpSessionUpdate =
  | SessionUpdate
  | {
      sessionUpdate: 'subagent_event';
      event: LodySubagentEvent;
      _meta?: Record<string, unknown> | null;
    };
export type AcpSessionNotification = Omit<SessionNotification, 'update'> & {
  update: AcpSessionUpdate;
};
export type AcpToolCall = ToolCall;
export type AcpToolCallUpdate = ToolCallUpdate;
export type AcpContentBlock = ContentBlock;
export type AcpAvailableCommandsUpdate = AvailableCommandsUpdate;
export type AcpConfigOptionUpdate = ConfigOptionUpdate;
export type AcpCurrentModeUpdate = CurrentModeUpdate;
export type AcpPlan = Plan;

export const parseSessionNotification = (value: unknown): AcpSessionNotification => {
  return zSessionNotification.parse(value) as AcpSessionNotification;
};

export const parseSessionNotifications = (value: unknown): AcpSessionNotification[] => {
  return zSessionNotification.array().parse(value) as AcpSessionNotification[];
};
