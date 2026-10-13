import type { InboxBatch, InboxInput } from './model';

export type SessionFenceState = {
  revision: number;
  paused: number;
  blocked: number;
  active_execution: string | null;
  active_input: string | null;
};
export const inputAcceptance = (
  kind: InboxInput['kind'],
  paused: boolean,
  previousCanceled?: boolean
): 'accept' | 'duplicate' | 'reject' =>
  previousCanceled !== undefined
    ? previousCanceled
      ? 'reject'
      : 'duplicate'
    : kind === 'task' && paused
      ? 'reject'
      : 'accept';

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
  !state.blocked &&
  (batch.kind === 'automatic' ? state.revision === batch.revision : !inputCanceled) &&
  state.active_input === batch.inputId &&
  state.active_execution === id &&
  count > 0 &&
  count === batch.memberCount;
