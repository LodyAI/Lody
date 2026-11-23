import {
  SESSION_HISTORY_SUBSCRIPTION_MAX_DELTA_BYTES,
  SESSION_HISTORY_SUBSCRIPTION_MAX_PUBLICATIONS,
  SessionHistoryChangesSchema,
  type SessionHistoryPublication,
  type SessionHistoryReadQuery,
  type SessionHistoryReadResponse,
  type SessionHistorySubscription,
} from '@lody/shared';

export async function publishRoostHistorySubscription(options: {
  subscription: Extract<SessionHistorySubscription, { action: 'open' }>;
  signal: AbortSignal;
  read: (
    query: SessionHistoryReadQuery & { inlineOnly?: true }
  ) => Promise<SessionHistoryReadResponse>;
  waitForChange: (checkpoint: string) => Promise<void>;
  publish: (publication: SessionHistoryPublication) => Promise<void>;
}): Promise<void> {
  const { signal, subscription, read, waitForChange, publish } = options;
  let checkpoint = subscription.checkpoint;
  let emitted = 0;
  let superseded = 0;
  while (!signal.aborted && emitted < SESSION_HISTORY_SUBSCRIPTION_MAX_PUBLICATIONS) {
    const response = await read(
      checkpoint
        ? {
            kind: 'readChanges',
            checkpoint,
            includeBodiesFrom: subscription.includeBodiesFrom,
            withPatches: subscription.withPatches,
            inlineOnly: true,
          }
        : { kind: 'count', withCheckpoint: true }
    );
    if (signal.aborted) return;
    if (!response.success) {
      if (response.retryReason === 'superseded' && ++superseded <= 2) continue;
      throw new Error(response.error ?? 'History observation unavailable');
    }
    superseded = 0;
    const result = response.result as { checkpoint?: unknown } | undefined;
    const next = result?.checkpoint;
    if (typeof next !== 'string' || response.historyRevision === undefined)
      throw new Error('History observation has no durable checkpoint');
    if (emitted === 0 || next !== checkpoint) {
      const changes = SessionHistoryChangesSchema.safeParse(result);
      const from = subscription.includeBodiesFrom;
      await publish({
        checkpoint: next,
        revision: response.historyRevision,
        ...(checkpoint &&
        from !== undefined &&
        next !== checkpoint &&
        changes.success &&
        changes.data.state === 'ready' &&
        changes.data.bodies &&
        Buffer.byteLength(JSON.stringify(response)) <= SESSION_HISTORY_SUBSCRIPTION_MAX_DELTA_BYTES
          ? {
              delta: {
                baseCheckpoint: checkpoint,
                includeBodiesFrom: from,
                withPatches: subscription.withPatches,
                response,
              },
            }
          : {}),
      });
      emitted++;
    }
    checkpoint = next;
    if (emitted < SESSION_HISTORY_SUBSCRIPTION_MAX_PUBLICATIONS && !signal.aborted)
      await waitForChange(checkpoint);
  }
}
