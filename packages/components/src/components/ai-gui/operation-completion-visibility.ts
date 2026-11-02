import type { MessageContent, OperationCompletionContent } from '@lody/shared';

export function getOperationCompletionItems(completion: OperationCompletionContent) {
  const result = completion.completion;
  const items =
    result.type === 'result'
      ? result.value.items
      : result.type === 'cancelled'
        ? (result.partial?.items ?? [])
        : [];
  const hasCreationProgress =
    !!completion.progressMessageId &&
    (completion.operationKind === 'session_create' ||
      completion.operationKind === 'session_create_many');
  // Existing progress owns successful targets; problems still need their details.
  return hasCreationProgress
    ? items.filter((item) => item.status === 'failed' || item.status === 'cancelled')
    : items;
}

/** Presentation only: keep durable receipts and model input untouched. */
export function hasVisibleOperationContent(item: MessageContent): boolean {
  if (item.type === 'operation_completion_batch') {
    const members = item.members ?? [];
    return (
      item.deliveryStatus === 'unknown' ||
      members.length < item.memberCount ||
      members.some(hasVisibleOperationContent)
    );
  }
  if (item.type !== 'operation_completion') return true;
  return (
    item.completion.type !== 'result' ||
    getOperationCompletionItems(item).some(
      (result) => !!result.target || result.status === 'failed' || result.status === 'cancelled'
    )
  );
}
