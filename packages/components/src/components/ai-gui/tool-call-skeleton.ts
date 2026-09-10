import { isToolCallRef, type MessageContent, type ToolCallRef } from '@lody/shared';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

export { isToolCallRef };

/**
 * A sealed tool_call skeleton: the turn stores only `kind`/`status`/`title`/
 * `locations`/`ref`, with no execution payload, because `content`/`rawInput`/
 * `rawOutput` stay on the origin machine.
 *
 * `ref` alone is NOT enough: a full call may also carry a `ref`, and treating it
 * as a skeleton would make the card render the "stored on <machine>" placeholder
 * instead of the payload it actually has. A skeleton must therefore actually omit
 * the payload (an empty `content` array counts as omitted).
 */
export const isToolCallSkeleton = (
  content: ToolCallMessage
): content is ToolCallMessage & { ref: ToolCallRef } =>
  isToolCallRef(content.ref) &&
  (content.content?.length ?? 0) === 0 &&
  content.rawInput === undefined &&
  content.rawOutput === undefined;

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
