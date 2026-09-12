import type { MessageContent } from '../ai';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import {
  deriveLocationsFromToolCallContent,
  stripToolCallContentForHistory,
} from '../acp/tool-call-history';
type ToolCallMessageContent = Extract<MessageContent, { type: 'tool_call' }>;
const sanitizeToolCallContentForHistory = (
  content: ToolCallMessageContent['content'] | undefined,
  kind: ToolCallMessageContent['kind'] | undefined
): ToolCallMessageContent['content'] | undefined => {
  if (!content) return undefined;
  const filtered = stripToolCallContentForHistory(kind ?? null, content);
  return filtered.length ? filtered : undefined;
};

export const mergeToolCallWithPermission = (
  toolCall: ToolCallMessageContent,
  requestId: string,
  request: RequestPermissionRequest
): ToolCallMessageContent => {
  const tool = request.toolCall;
  const kind = (toolCall.kind ?? tool.kind ?? undefined) as
    | ToolCallMessageContent['kind']
    | undefined;
  const content = sanitizeToolCallContentForHistory(
    toolCall.content ?? tool.content ?? undefined,
    kind
  );
  const locations =
    toolCall.locations ??
    (Array.isArray(tool.locations) && tool.locations.length > 0 ? tool.locations : undefined) ??
    deriveLocationsFromToolCallContent(tool.content);
  const requestMeta = (request as { _meta?: unknown })._meta;
  const permissionMeta =
    typeof requestMeta === 'object' && requestMeta !== null && !Array.isArray(requestMeta)
      ? (requestMeta as Record<string, unknown>)
      : undefined;
  return {
    ...toolCall,
    title: toolCall.title ?? tool.title ?? null,
    kind,
    status: toolCall.status ?? tool.status ?? 'pending',
    content,
    locations,
    permissionRequest: {
      requestId,
      options: request.options,
      ...(permissionMeta ? { _meta: permissionMeta } : {}),
      outcome: toolCall.permissionRequest?.outcome,
    },
  };
};

export const buildToolCallFromPermissionRequest = (
  requestId: string,
  request: RequestPermissionRequest
): ToolCallMessageContent => {
  const kind = request.toolCall.kind ?? undefined;
  const content = sanitizeToolCallContentForHistory(request.toolCall.content ?? undefined, kind);
  const explicitLocations =
    Array.isArray(request.toolCall.locations) && request.toolCall.locations.length > 0
      ? request.toolCall.locations
      : undefined;
  const locations =
    explicitLocations ?? deriveLocationsFromToolCallContent(request.toolCall.content);
  const base: ToolCallMessageContent = {
    type: 'tool_call',
    toolCallId: request.toolCall.toolCallId,
    title: request.toolCall.title ?? null,
    status: request.toolCall.status ?? 'pending',
    kind,
    content,
    locations,
  };
  return mergeToolCallWithPermission(base, requestId, request);
};
