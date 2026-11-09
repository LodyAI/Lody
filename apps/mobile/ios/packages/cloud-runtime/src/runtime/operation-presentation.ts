/** Read-only presentation of the public operation_progress/completion/batch history schema.
 * Mirrors Web operation-completion-visibility; never changes the durable receipt.
 */
export type OperationCard = {
  id: string;
  kind: 'created' | 'reply';
  sessionId: string;
  label?: string;
  status: string;
  detail?: string;
  reply?: string;
  replyTruncated?: boolean;
};
export type OperationNotice = {
  kind: 'failed' | 'cancelled' | 'partial' | 'batch' | 'batchUnknown';
  detail?: string;
  count?: number;
};
export type OperationPresentation = {
  cards: OperationCard[];
  notices: OperationNotice[];
};

export function operationPresentation(raw: any): OperationPresentation {
  const cards: OperationCard[] = [];
  const notices: OperationNotice[] = [];
  const creates =
    raw.operationKind === 'session_create' ||
    raw.operationKind === 'session_create_many';
  if (raw.type === 'operation_progress') {
    for (const [index, item] of (raw.items ?? []).entries()) {
      cards.push({
        id: String(index),
        kind: 'created',
        sessionId: item.target.sessionId,
        label: item.label,
        status: item.status,
      });
    }
    return { cards, notices };
  }
  if (raw.type === 'operation_completion_batch') {
    for (const member of raw.members ?? []) {
      const presentation = operationPresentation(member);
      cards.push(
        ...presentation.cards.map((card) => ({
          ...card,
          id: `${member.deliveryId}/${card.id}`,
        })),
      );
      notices.push(...presentation.notices);
    }
    if (
      raw.deliveryStatus === 'unknown' ||
      (raw.members?.length ?? 0) < raw.memberCount ||
      cards.length ||
      notices.length
    ) {
      notices.unshift({
        kind: raw.deliveryStatus === 'unknown' ? 'batchUnknown' : 'batch',
        count: raw.memberCount,
      });
    }
    return { cards, notices };
  }
  const completion = raw.completion;
  if (!completion) return { cards, notices };
  const results =
    completion.type === 'result'
      ? completion.value.items
      : (completion.partial?.items ?? []);
  const failed = results.filter((item: any) => item.status === 'failed').length;
  const cancelled = results.filter(
    (item: any) => item.status === 'cancelled',
  ).length;
  if (
    completion.type === 'error' ||
    (failed > 0 && failed === results.length)
  ) {
    notices.push({ kind: 'failed', detail: completion.error?.message });
  } else if (
    completion.type === 'cancelled' ||
    (cancelled > 0 && cancelled === results.length)
  ) {
    notices.push({ kind: 'cancelled' });
  } else if (failed + cancelled > 0) {
    notices.push({ kind: 'partial' });
  }
  for (const [index, item] of results.entries()) {
    if (
      creates &&
      raw.progressMessageId &&
      item.status !== 'failed' &&
      item.status !== 'cancelled'
    )
      continue;
    if (!item.target) {
      if (item.status === 'failed' || item.status === 'cancelled') {
        notices.push({
          kind: item.status,
          detail: [item.label, item.error?.message].filter(Boolean).join(': '),
        });
      }
      continue;
    }
    cards.push({
      id: String(index),
      kind: creates ? 'created' : 'reply',
      sessionId: item.target.sessionId,
      label: item.label,
      status: item.status === 'active' ? 'running' : item.status,
      detail: item.status === 'failed' ? item.error.message : undefined,
      reply: item.status === 'succeeded' ? item.output?.text : undefined,
      replyTruncated:
        item.status === 'succeeded' ? item.output?.truncated : undefined,
    });
  }
  return { cards, notices };
}
