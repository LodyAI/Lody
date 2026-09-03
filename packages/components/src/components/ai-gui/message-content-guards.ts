import { SESSION_IMAGE_MAX_COUNT, type MessageContent } from '@lody/shared';

import { isToolCallRef } from './tool-call-skeleton';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStringLike = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const toString = (value as { toString?: unknown }).toString;
  if (typeof toString !== 'function' || toString === Object.prototype.toString) {
    return null;
  }
  const text = toString.call(value);
  return typeof text === 'string' && text !== '[object Object]' ? text : null;
};

const normalizeProposedPlanContent = (
  value: Record<string, unknown>
): Extract<MessageContent, { type: 'proposed_plan' }> | null => {
  if (value.type !== 'proposed_plan') return null;
  const turnId = readStringLike(value.turnId);
  const markdown = readStringLike(value.markdown);
  const status = readStringLike(value.status);
  if (!turnId || markdown === null || !status || typeof value.isLatest !== 'boolean') {
    return null;
  }
  if (status !== 'delta' && status !== 'completed' && status !== 'cleared') {
    return null;
  }
  return {
    type: 'proposed_plan',
    turnId,
    markdown,
    status,
    isLatest: value.isLatest,
  };
};

const isWorktreeScriptStep = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.command === 'string' &&
  (value.status === 'in_progress' || value.status === 'completed' || value.status === 'failed') &&
  typeof value.output === 'string';

const isLodyError = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.code === 'string' &&
  typeof value.message === 'string' &&
  typeof value.retryable === 'boolean';

const isOperationItem = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  const targetValid =
    value.target === undefined ||
    (isRecord(value.target) &&
      typeof value.target.sessionId === 'string' &&
      typeof value.target.userTurnId === 'string');
  if (!targetValid) return false;
  if (value.status === 'active') {
    return value.target !== undefined && typeof value.inputDurable === 'boolean';
  }
  if (value.status === 'succeeded') {
    return value.target !== undefined && typeof value.assistantTurnId === 'string';
  }
  if (value.status === 'failed') return isLodyError(value.error);
  return value.status === 'cancelled';
};

const isOperationResult = (value: unknown): boolean =>
  isRecord(value) && Array.isArray(value.items) && value.items.every(isOperationItem);

const isOperationCompletion = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.type === 'result') return isOperationResult(value.value);
  if (value.type === 'error') return isLodyError(value.error);
  return (
    value.type === 'cancelled' && (value.partial === undefined || isOperationResult(value.partial))
  );
};

export const isMessageContent = (value: unknown): value is MessageContent => {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (typeof type !== 'string') return false;

  switch (type) {
    case 'text':
    case 'thought':
      return typeof value.text === 'string';
    case 'image':
      return (
        typeof value.imageId === 'string' &&
        typeof value.mimeType === 'string' &&
        typeof value.sizeBytes === 'number'
      );
    case 'image_group':
      return (
        Array.isArray(value.images) &&
        value.images.length > 0 &&
        value.images.length <= SESSION_IMAGE_MAX_COUNT &&
        value.images.every(
          (item) =>
            isRecord(item) &&
            typeof item.imageId === 'string' &&
            typeof item.mimeType === 'string' &&
            typeof item.sizeBytes === 'number'
        )
      );
    case 'file':
      return (
        typeof value.fileId === 'string' &&
        typeof value.fileName === 'string' &&
        typeof value.mimeType === 'string' &&
        typeof value.sizeBytes === 'number' &&
        typeof value.sha256 === 'string' &&
        typeof value.textPreview === 'boolean' &&
        (value.transport === 'r2' || value.transport === 'local') &&
        typeof value.uploadedAt === 'number'
      );
    case 'plan':
      return Array.isArray(value.entries);
    case 'proposed_plan':
      return (
        typeof value.turnId === 'string' &&
        typeof value.markdown === 'string' &&
        typeof value.status === 'string' &&
        typeof value.isLatest === 'boolean'
      );
    case 'goal':
      return (
        typeof value.threadId === 'string' &&
        typeof value.objective === 'string' &&
        typeof value.status === 'string' &&
        (value.tokensUsed === undefined || typeof value.tokensUsed === 'number') &&
        (value.timeUsedSeconds === undefined || typeof value.timeUsedSeconds === 'number') &&
        (value.createdAt === undefined || typeof value.createdAt === 'number') &&
        (value.updatedAt === undefined || typeof value.updatedAt === 'number')
      );
    case 'tool_call':
      // Sealed turns may store a skeleton with no `toolCallId` and no
      // `content`; its payload pointer `ref` identifies it instead (see
      // `tool-call-skeleton.ts` and `packages/shared/src/schema.ts`).
      return (
        typeof value.status === 'string' &&
        (typeof value.toolCallId === 'string' || isToolCallRef(value.ref)) &&
        (value.content === undefined || Array.isArray(value.content))
      );
    case 'subagent_task':
      return typeof value.taskId === 'string' && typeof value.status === 'string';
    case 'available_commands':
      return Array.isArray(value.commands);
    case 'system_notice':
      return typeof value.name === 'string';
    case 'operation_completion':
      return (
        typeof value.deliveryId === 'string' &&
        typeof value.operationId === 'string' &&
        typeof value.operationKind === 'string' &&
        isOperationCompletion(value.completion)
      );
    case 'worktree_script':
      return (
        (value.phase === 'setup' || value.phase === 'cleanup') &&
        (value.status === 'in_progress' ||
          value.status === 'completed' ||
          value.status === 'failed') &&
        Array.isArray(value.steps) &&
        value.steps.every(isWorktreeScriptStep)
      );
    case 'comment_reference':
      return (
        (value.source === 'lody' || value.source === 'github') &&
        typeof value.path === 'string' &&
        typeof value.lineNumber === 'number' &&
        (value.side === 'additions' || value.side === 'deletions') &&
        typeof value.commentBody === 'string' &&
        typeof value.authorName === 'string'
      );
    case 'visual_annotation_reference':
      return (
        value.source === 'visual_annotation' &&
        typeof value.commentId === 'string' &&
        typeof value.body === 'string' &&
        isRecord(value.anchor)
      );
    default:
      return false;
  }
};

export const normalizeMessageContent = (value: unknown): MessageContent | null => {
  if (isMessageContent(value)) return value;
  if (!isRecord(value)) return null;
  return normalizeProposedPlanContent(value);
};

/**
 * Whether a history item renders as a row in the system-message group.
 *
 * Three item types render as system rows. The one conditional case is the
 * agent's task proposal: the Tasks MCP surface is not gated (the beta gate is
 * frontend-only), so an agent can propose a task into a workspace whose user
 * never enabled Tasks. Such a proposal is dropped entirely rather than falling
 * through to the generic notice, which would describe a feature that is not
 * there.
 *
 * Kept here, named and pure, because the call site expresses it as a filter
 * predicate where a mis-inverted boolean would silently stop rendering
 * worktree-script and operation-completion notices for every user — a failure
 * nothing else would catch.
 */
export const shouldRenderSystemRowItem = <T extends { type: string }>(
  item: T,
  tasksEnabled: boolean
): item is Extract<
  T,
  { type: 'system_notice' | 'worktree_script' | 'operation_completion' }
> => {
  if (item.type === 'system_notice' && 'name' in item && item.name === 'task_proposal') {
    return tasksEnabled;
  }
  return (
    item.type === 'system_notice' ||
    item.type === 'worktree_script' ||
    item.type === 'operation_completion'
  );
};
