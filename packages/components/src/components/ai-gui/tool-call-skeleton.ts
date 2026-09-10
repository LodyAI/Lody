import { isToolCallRef, type MessageContent, type ToolCallRef } from '@lody/shared';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

export { isToolCallRef };

/**
 * A sealed tool_call skeleton: the turn stores only `kind`/`status`/`title`/
 * `locations`/`ref`, and the execution payload (`content`/`rawInput`/
 * `rawOutput`) stays on the origin machine. A full call and a skeleton share the
 * `tool_call` discriminant, so callers narrow with this guard rather than
 * casting around `toolCallId`.
 */
export const isToolCallSkeleton = (
  content: ToolCallMessage
): content is ToolCallMessage & { ref: ToolCallRef } => isToolCallRef(content.ref);

/**
 * Stable identity for rows and React keys. A full call uses its `toolCallId`; a
 * skeleton falls back to its payload ref, which is unique within the turn and
 * stable across renders. Never returns `undefined`, so keys cannot collide on
 * the string "undefined".
 */
export const getToolCallStableId = (content: ToolCallMessage): string => {
  if (typeof content.toolCallId === 'string') return content.toolCallId;
  if (isToolCallRef(content.ref)) {
    return `ref:${content.ref.machineId}:${content.ref.turnId}:${content.ref.index}`;
  }
  return '';
};

/** Display fallback for a machine whose meta has not loaded (or never will). */
export const getShortMachineId = (machineId: string): string =>
  machineId.length > 12 ? `${machineId.slice(0, 8)}…` : machineId;
