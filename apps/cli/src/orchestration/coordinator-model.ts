import type { MessageContent, SessionHistoryInput, StoredLodyOperation } from '@lody/shared';
import {
  getOperationProgressTargetKey,
  type OperationProgressStatusByTarget,
} from '@lody/shared/session-data';
const TARGET_OUTPUT_PREVIEW_MAX_BYTES = 8 * 1024;
const truncateTargetOutput = (
  text: string
): { text: string; truncated?: true; omittedBytes?: number } => {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= TARGET_OUTPUT_PREVIEW_MAX_BYTES) return { text };
  const marker = '\n…\n';
  const characters = Array.from(text);
  const render = (keptCharacters: number) => {
    const headCount = Math.ceil(keptCharacters / 2);
    const tailCount = keptCharacters - headCount;
    return `${characters.slice(0, headCount).join('')}${marker}${characters
      .slice(characters.length - tailCount)
      .join('')}`;
  };
  let low = 0;
  let high = characters.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(render(middle), 'utf8') <= TARGET_OUTPUT_PREVIEW_MAX_BYTES) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const headCount = Math.ceil(best / 2);
  const tailCount = best - headCount;
  const kept = `${characters.slice(0, headCount).join('')}${characters
    .slice(characters.length - tailCount)
    .join('')}`;
  return {
    text: render(best),
    truncated: true,
    omittedBytes: originalBytes - Buffer.byteLength(kept, 'utf8'),
  };
};

export const assistantOutputPreview = (
  assistant: Pick<SessionHistoryInput, 'items'>
): ReturnType<typeof truncateTargetOutput> | undefined => {
  const text = (assistant.items ?? [])
    .filter((item): item is Extract<MessageContent, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .filter((item) => item.length > 0)
    .join('\n\n');
  return text.length > 0 ? truncateTargetOutput(text) : undefined;
};

export const isTerminalAssistantEntry = (entry: SessionHistoryInput): boolean =>
  entry.role === 'assistant' && (entry.finished === true || typeof entry.endedAt === 'number');
export function progressIsSettled(
  operation: StoredLodyOperation,
  row: SessionHistoryInput | undefined,
  observed: OperationProgressStatusByTarget
): boolean {
  const content = row?.items?.find((item) => item.type === 'operation_progress');
  const published = new Map(
    (content?.items ?? []).map((item) => [getOperationProgressTargetKey(item.target), item.status])
  );
  const expected = new Map(observed);
  for (const item of operation.items) {
    if (!('target' in item) || !item.target) continue;
    const key = getOperationProgressTargetKey(item.target);
    if (expected.has(key)) continue;
    if (
      item.status === 'succeeded' ||
      item.status === 'cancelled' ||
      (item.status === 'failed' && item.error.code === 'TARGET_FAILED')
    ) {
      if (item.status === 'succeeded' || published.has(key)) expected.set(key, item.status);
    } else if (item.status === 'active' && item.inputDurable) expected.set(key, 'created');
  }
  // Previously published targets stay owned even when metadata is temporarily absent.
  if (published.size !== expected.size) return false;
  return [...expected].every(
    ([key, status]) => status !== 'created' && status !== 'running' && published.get(key) === status
  );
}
