import type { LodyOperationCompletion, LodyOperationItemTarget } from '@lody/shared';
import type { InboxBatch } from './model';

export type SessionFenceState = {
  revision: number;
  paused: number;
  active_execution: string | null;
  active_input: string | null;
};
/**
 * Stop pauses only automatic result wakes. Fresh human and Agent-chat inputs are
 * explicit instructions of the same rank: both are admitted and both clear pause.
 */
export const inputAcceptance = (previousCanceled?: boolean): 'accept' | 'duplicate' | 'reject' =>
  previousCanceled !== undefined ? (previousCanceled ? 'reject' : 'duplicate') : 'accept';

export const canFenceBatch = (
  state: SessionFenceState,
  batch: InboxBatch,
  id: string,
  currentOwner: boolean,
  inputCanceled: boolean,
  count: number
): boolean =>
  currentOwner &&
  !state.paused &&
  (batch.kind === 'automatic' ? state.revision === batch.revision : !inputCanceled) &&
  state.active_input === batch.inputId &&
  state.active_execution === id &&
  count > 0 &&
  count === batch.memberCount;

/** Preserve queryable cancellation, but user Stop is not an Agent continuation. */
export const operationInboxCompletion = (
  completion: LodyOperationCompletion
): LodyOperationCompletion | undefined => {
  if (completion.type !== 'result') return completion;
  const items = completion.value.items.filter(
    (item) => item.status !== 'cancelled' || item.cancellationReason !== 'user_stop'
  );
  if (items.length === completion.value.items.length) return completion;
  return items.length ? { ...completion, value: { ...completion.value, items } } : undefined;
};

/** Apply the Stop records captured inside the final completion transaction. */
export const cancelManuallyStoppedTargets = (
  completion: LodyOperationCompletion,
  stopped: readonly LodyOperationItemTarget[]
): LodyOperationCompletion => {
  if (completion.type !== 'result' || stopped.length === 0) return completion;
  return {
    ...completion,
    value: {
      ...completion.value,
      items: completion.value.items.map((item) =>
        item.target &&
        stopped.some(
          (target) =>
            target.sessionId === item.target?.sessionId &&
            target.userTurnId === item.target?.userTurnId
        )
          ? {
              status: 'cancelled',
              cancellationReason: 'user_stop',
              target: item.target,
              ...(item.label ? { label: item.label } : {}),
            }
          : item
      ),
    },
  };
};
