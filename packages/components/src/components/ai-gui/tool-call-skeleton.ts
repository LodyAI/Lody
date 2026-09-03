import type { MessageContent, ToolCallRef } from '@lody/shared';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Runtime shape of a sealed tool_call skeleton's payload pointer. Mirrors the
 * validation in `packages/shared/src/schema.ts` — kept structural (not
 * imported) so this guard stays usable on raw history values.
 */
export const isToolCallRef = (value: unknown): value is ToolCallRef =>
  isRecord(value) &&
  typeof value.machineId === 'string' &&
  typeof value.turnId === 'string' &&
  typeof value.index === 'number';

/**
 * A sealed tool_call skeleton: the turn stores only `kind`/`status`/`title`/
 * `locations`/`ref`, and the execution payload (`content`/`rawInput`/
 * `rawOutput`) stays on the origin machine. The `MessageContent` type still
 * declares `toolCallId` required, so at runtime a skeleton is recognized by
 * the presence of a valid `ref`, never by casting.
 */
export const isToolCallSkeleton = (
  content: ToolCallMessage
): content is ToolCallMessage & { ref: ToolCallRef } => isToolCallRef(content.ref);

/**
 * Stable identity for rows and keys. Sealed skeletons have no `toolCallId`,
 * so they fall back to their payload ref; either way the value is unique
 * within a turn and stable across renders.
 */
export const getToolCallStableId = (content: ToolCallMessage): string => {
  const toolCallId = content.toolCallId as string | undefined;
  if (typeof toolCallId === 'string') return toolCallId;
  if (isToolCallRef(content.ref)) {
    return `ref:${content.ref.machineId}:${content.ref.turnId}:${content.ref.index}`;
  }
  return '';
};

/** Display fallback for a machine whose meta has not loaded (or never will). */
export const getShortMachineId = (machineId: string): string =>
  machineId.length > 12 ? `${machineId.slice(0, 8)}…` : machineId;
