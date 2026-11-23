import type {
  LodyOperationCompletion,
  LodyOperationItemResult,
  MachineId,
  SessionId,
  StoredLodyOperation,
  WorkspaceId,
} from '@lody/shared';
import { Context, Effect } from 'effect';

export type AcceptOperationInput = Omit<
  StoredLodyOperation,
  'fingerprint' | 'state' | 'completion' | 'finishedAt'
>;
export type AcceptOperationOptions = { materializationClaimToken?: string };
export class OperationRepository extends Context.Service<
  OperationRepository,
  {
    accept(
      input: AcceptOperationInput,
      options?: AcceptOperationOptions
    ): Effect.Effect<
      { created: boolean; operation: StoredLodyOperation; claimedItemIndexes: number[] },
      unknown
    >;
    get(sessionId: SessionId, operationId: string): Effect.Effect<StoredLodyOperation, unknown>;
    inputCancellationReason(
      workspaceId: WorkspaceId,
      sessionId: SessionId,
      inputId: string
    ): Effect.Effect<'user_stop' | undefined, unknown>;
    finish(
      sessionId: SessionId,
      operationId: string,
      completion: LodyOperationCompletion
    ): Effect.Effect<StoredLodyOperation, unknown>;
    updateItems(
      sessionId: SessionId,
      operationId: string,
      items: LodyOperationItemResult[]
    ): Effect.Effect<StoredLodyOperation, unknown>;
    listActive(
      workspaceId: WorkspaceId,
      machineId: MachineId
    ): Effect.Effect<StoredLodyOperation[], unknown>;
    listPendingProgress(
      workspaceId: WorkspaceId,
      machineId: MachineId
    ): Effect.Effect<StoredLodyOperation[], unknown>;
    settleProgress(sessionId: SessionId, operationId: string): Effect.Effect<void, unknown>;
    claimItemMaterialization(
      sessionId: SessionId,
      operationId: string,
      index: number,
      token: string
    ): Effect.Effect<{ claimed: boolean; retryAtMs?: number }, unknown>;
    markItemInputDurable(
      sessionId: SessionId,
      operationId: string,
      index: number,
      token?: string
    ): Effect.Effect<StoredLodyOperation, unknown>;
  }
>()('lody/orchestration/Operations') {}
