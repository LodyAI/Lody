import type {
  LodyOperationItemResult,
  MachineId,
  SessionHistoryInput,
  SessionId,
  SessionMeta,
  StoredLodyOperation,
} from '@lody/shared';
import type { HistoryAction, SessionTurnRead } from '@lody/shared/session-data';
import { Context, Data, Effect } from 'effect';
import type { InboxBatch } from './inbox/model';

export const TARGET_CATCH_UP_TIMEOUT_MS = 8_000;

export class TargetCatchUpTimeoutError extends Data.TaggedError('TargetCatchUpTimeoutError')<{
  readonly sessionId: SessionId;
  readonly reason: string;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `Target document catch-up timed out after ${this.timeoutMs}ms (${this.sessionId}, ${this.reason})`;
  }
}

export type CoordinatorHistory = {
  meta: SessionMeta;
  readTurn(id: string): Effect.Effect<SessionTurnRead, unknown>;
  readTurnOutput(id: string): Effect.Effect<SessionHistoryInput[], unknown>;
  applyHistoryAction(action: HistoryAction): Effect.Effect<unknown, unknown>;
  flushLocalWrites: Effect.Effect<void, unknown>;
  observe(wake: Effect.Effect<void>): Effect.Effect<Effect.Effect<void>, unknown>;
};
export class CoordinatorPorts extends Context.Service<
  CoordinatorPorts,
  {
    metadata(id: SessionId): Effect.Effect<{ meta: SessionMeta } | undefined, unknown>;
    execution(id: SessionId): { activeTurnId?: string };
    receipts: Effect.Effect<InboxBatch[], unknown>;
    wakeInbox: Effect.Effect<void, unknown>;
    active(): boolean;
    now(): number;
    claimToken: string;
    session(id: SessionId): Effect.Effect<CoordinatorHistory, unknown>;
    confirmReadable(
      id: SessionId,
      reason: string,
      targetMachineId?: MachineId
    ): Effect.Effect<void, unknown>;
    materialize(
      operation: StoredLodyOperation,
      item: Extract<LodyOperationItemResult, { status: 'active' }>,
      index: number
    ): Effect.Effect<void, unknown>;
    warn(message: string, cause?: unknown): Effect.Effect<void>;
  }
>()('lody/orchestration/CoordinatorPorts') {}
