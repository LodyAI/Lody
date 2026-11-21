import type { SubagentRunItem } from '../ai';

/** How a preview reads one stored value: a Loro container or plain JSON. */
export type RunPreviewAccess = {
  field(value: unknown, key: string): unknown;
  string(value: unknown): string | undefined;
  /** The last 512 characters of a string or text value. */
  textTail(value: unknown): string | undefined;
};

/** Plain JSON values, as a remote read returns them. */
export const jsonRunPreviewAccess: RunPreviewAccess = {
  field: (value, key) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : undefined,
  string: (value) => (typeof value === 'string' ? value : undefined),
  textTail: (value) => (typeof value === 'string' ? value.slice(-512) : undefined),
};

/**
 * A run's display preview: the latest step that has something to show, read
 * from the end. `stepAt(index)` returns the step at `index` of `length`; the
 * scan stops at the first step that yields a preview.
 */
export async function latestRunStepPreview(
  length: number,
  stepAt: (index: number) => unknown,
  access: RunPreviewAccess
): Promise<SubagentRunItem[]> {
  for (let index = length - 1; index >= 0; index--) {
    const preview = runStepPreview(await stepAt(index), access);
    if (preview) return [preview];
  }
  return [];
}

/** The preview of one run step, or undefined when it has none. */
export function runStepPreview(
  item: unknown,
  access: RunPreviewAccess
): SubagentRunItem | undefined {
  const type = access.string(access.field(item, 'type'));
  if (type === 'tool_call')
    return {
      type,
      toolCallId: access.string(access.field(item, 'toolCallId')) ?? '',
      status: (access.string(access.field(item, 'status')) ?? 'pending') as Extract<
        SubagentRunItem,
        { type: 'tool_call' }
      >['status'],
      title: access.textTail(access.field(item, 'title')),
      toolName: access.textTail(access.field(item, 'toolName')),
    };
  if (type === 'thought') return { type, text: '' };
  if (type === 'plan') return { type, entries: [] };
  if (type === 'text') {
    const tail = access.textTail(access.field(item, 'text')) ?? '';
    if (tail.trim()) return { type, text: tail };
  }
  return undefined;
}
