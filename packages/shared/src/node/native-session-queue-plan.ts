import { isDeepStrictEqual } from 'node:util';
import type { MessageQueueItem, MessageQueueItemInput, SessionImagePayload } from '@lody/shared';
/** One operation names one frozen input across legacy/native queue writers. */
export function prepareSessionQueueAppend(
  rows: readonly MessageQueueItem[],
  item: MessageQueueItemInput
) {
  const operationId =
    item.operationId ??
    (typeof item.userTurnId === 'string' && item.userTurnId.trim().length > 0
      ? `queue:${item.userTurnId.trim()}`
      : undefined);
  const prior = operationId ? rows.find((row) => row.operationId === operationId) : undefined;
  if (prior) {
    if (
      prior.userTurnId !== item.userTurnId ||
      prior.userId !== item.userId ||
      prior.task !== item.task ||
      !isDeepStrictEqual(prior.acpSessionConfig, item.acpSessionConfig) ||
      !isDeepStrictEqual(prior.project, item.project)
    )
      throw new Error('Queue operation identity conflict');
    return;
  }
  return { ...item, ...(operationId ? { operationId } : {}) };
}
/** Mutate only matching locators inside the caller's detached/owned draft. */
export function promoteSessionQueueImageReferences(
  rows: readonly MessageQueueItem[],
  image: SessionImagePayload
): void {
  for (const item of rows) {
    const blocks = item.acpSessionConfig?.inputBlocks;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (
        block &&
        typeof block === 'object' &&
        block.type === 'image' &&
        block.transport === 'local' &&
        block.localImageId === image.localImageId &&
        block.machineId === image.machineId &&
        block.storageSessionId === image.storageSessionId
      )
        Object.assign(block, image);
    }
  }
}
