import {
  DEFAULT_SESSION_HISTORY_BACKEND,
  type MessageQueueItem,
  type SessionHistoryBackendKind,
  type SessionHistoryInput,
  type SessionMeta,
  type SessionQueuePromotionRecord,
  type SessionPlanEntry,
} from '@lody/shared';
import {
  readSessionHistory,
  readLatestTurn as readLatestHistoryTurn,
  type HistoryAction,
  type ReplaceEditableTailInput,
  type SessionActionResult,
  type SessionDirectoryRow,
  type SessionEditableTailResult,
  type SessionTurn,
  type SessionTurnRead,
  type OpenAssistantTurnInput,
} from '@lody/shared/session-data';
import type { SessionDocument } from '@/lib/loro/doc';
import type { AcpSessionNotification, MessageContent, ModelInfo } from '@lody/shared';

/**
 * Logical history and delivery operations consumed by session orchestration.
 *
 * This is intentionally narrower than `SessionDocument`: callers get the
 * domain history port and queue operations, but not Loro containers, mirrors,
 * or repo handles. A Roost adapter can implement the same contract while
 * projecting physical segments into the same logical history.
 */
export interface SessionBackend {
  readonly kind: SessionHistoryBackendKind;

  readHistory(): SessionHistoryInput[];
  readHistoryCount(): Promise<number>;
  readHistoryDirectory(from: number, to: number): Promise<readonly SessionDirectoryRow[]>;
  readLatestTurn(role: SessionTurn['role']): Promise<SessionTurn | undefined>;
  readTurn(turnId: string): Promise<SessionTurnRead>;
  applyHistoryAction(action: HistoryAction): Promise<SessionActionResult>;
  replaceEditableTail(input: ReplaceEditableTailInput): Promise<SessionEditableTailResult>;
  openAssistantTurn(input: OpenAssistantTurnInput): Promise<void>;
  respondPermission(
    requestId: string,
    outcome: import('@lody/shared').PermissionOutcome,
    options?: { readonly turnId?: string }
  ): Promise<boolean>;
  applyAgentBatch(input: SessionAgentBatchInput): Promise<void>;
  setPlan(entries: readonly SessionPlanEntry[]): Promise<void>;
  appendHistoryTurn(entry: SessionHistoryInput): Promise<void>;
  appendUserTurn(entry: SessionHistoryInput): Promise<void>;
  publishUserTurnActivation(userTurnId: string): Promise<void>;
  promoteQueuedTurn(input: QueuePromotionInput): Promise<QueuePromotionResult>;
  getMessageQueue(): Promise<readonly MessageQueueItem[]>;
  peekReadyMessageQueue(): Promise<MessageQueueItem | null>;
  removeMessageQueueItem(cid: string): Promise<void>;
  getMetaState(): Promise<SessionMeta | undefined>;
  getQueuePromotionRecord(operationId: string): Promise<SessionQueuePromotionRecord | undefined>;
  setQueuePromotionRecord(
    operationId: string,
    record: SessionQueuePromotionRecord | undefined
  ): Promise<void>;
  getSteerTurnStatuses(): Promise<SessionMeta['steerTurnStatuses']>;
  replaceSteerTurnStatuses(statuses: SessionMeta['steerTurnStatuses']): Promise<void>;

  /** Stable identity used to correlate queue retries with one logical turn. */
  getQueueOperationId(item: MessageQueueItem): string;
}

export type QueuePromotionInput = {
  item: MessageQueueItem;
  entry: SessionHistoryInput;
  operationId: string;
  /**
   * History evidence gathered by the caller's dispatch snapshot. Supplying it
   * keeps queue promotion from materializing the full conversation a second
   * time on the long-dialogue hot path.
   */
  existingEntry?: SessionHistoryInput;
};

export type SessionAgentBatchInput = {
  readonly notifications?: readonly AcpSessionNotification[];
  readonly contents?: readonly MessageContent[];
  readonly targetAssistantEntryId?: string;
  readonly entryBound?: boolean;
  readonly model?: ModelInfo;
  readonly createId?: () => string;
  readonly now?: () => string;
};

export type QueuePromotionResult = {
  status: 'applied' | 'already-applied';
  operationId: string;
  entry: SessionHistoryInput;
};

/** Explicit failure until the Roost adapter is registered in a later phase. */
export class SessionBackendUnavailableError extends Error {
  readonly code = 'session_backend_unavailable';

  constructor(
    readonly backend: SessionHistoryBackendKind,
    sessionId: string
  ) {
    super(`Session backend "${backend}" is not available for session ${sessionId}`);
    this.name = 'SessionBackendUnavailableError';
  }
}

class LoroSessionBackend implements SessionBackend {
  readonly kind = 'loro' as const;

  constructor(private readonly sessionDoc: SessionDocument) {}

  /** Compatibility surface for older data-only SessionDocument fixtures. */
  private get queuePort() {
    return this.sessionDoc as unknown as {
      appendUserTurn?: (entry: SessionHistoryInput) => Promise<void>;
      publishUserTurnActivation?: (userTurnId: string) => Promise<void>;
      getMessageQueue?: () => Promise<MessageQueueItem[]>;
      peekReadyMessageQueue?: () => Promise<MessageQueueItem | null>;
      removeMessageQueueItem?: (cid: string) => Promise<void>;
      getMetaState?: () => Promise<SessionMeta | undefined>;
      getQueuePromotionRecord?: (
        operationId: string
      ) => Promise<SessionQueuePromotionRecord | undefined>;
      setQueuePromotionRecord?: (
        operationId: string,
        record: SessionQueuePromotionRecord | undefined
      ) => Promise<void>;
    };
  }

  readHistory(): SessionHistoryInput[] {
    return readSessionHistory(this.sessionDoc.sessionData.history) as SessionHistoryInput[];
  }

  async readHistoryCount(): Promise<number> {
    return await this.sessionDoc.sessionData.history.count();
  }

  async readHistoryDirectory(from: number, to: number): Promise<readonly SessionDirectoryRow[]> {
    return await this.sessionDoc.sessionData.history.readDirectory(from, to);
  }

  async readLatestTurn(role: SessionTurn['role']): Promise<SessionTurn | undefined> {
    return readLatestHistoryTurn(this.sessionDoc.sessionData.history, role);
  }

  readTurn(turnId: string): Promise<SessionTurnRead> {
    return Promise.resolve(this.sessionDoc.sessionData.history.readTurn(turnId));
  }

  applyHistoryAction(action: HistoryAction): Promise<SessionActionResult> {
    return this.sessionDoc.sessionData.commands.applyHistoryAction(action);
  }

  replaceEditableTail(input: ReplaceEditableTailInput): Promise<SessionEditableTailResult> {
    return this.sessionDoc.sessionData.commands.replaceEditableTail(input);
  }

  openAssistantTurn(input: OpenAssistantTurnInput): Promise<void> {
    return this.sessionDoc.agentWrites.openAssistantTurn(input);
  }

  respondPermission(
    requestId: string,
    outcome: import('@lody/shared').PermissionOutcome,
    options?: { readonly turnId?: string }
  ): Promise<boolean> {
    return this.sessionDoc.sessionData.commands.respondPermission(requestId, outcome, options);
  }

  applyAgentBatch(input: SessionAgentBatchInput): Promise<void> {
    return this.sessionDoc.agentWrites.applyAgentBatch(input);
  }

  setPlan(entries: readonly SessionPlanEntry[]): Promise<void> {
    return this.sessionDoc.setPlan(entries as SessionPlanEntry[]);
  }

  appendUserTurn(entry: SessionHistoryInput): Promise<void> {
    return this.sessionDoc.appendUserTurn(entry);
  }

  publishUserTurnActivation(userTurnId: string): Promise<void> {
    return this.queuePort.publishUserTurnActivation?.(userTurnId) ?? Promise.resolve();
  }

  appendHistoryTurn(entry: SessionHistoryInput): Promise<void> {
    return this.sessionDoc.sessionData.commands.appendTurn(entry as unknown as SessionTurn);
  }

  async promoteQueuedTurn(input: QueuePromotionInput): Promise<QueuePromotionResult> {
    const { item, entry, operationId } = input;
    if (operationId !== this.getQueueOperationId(item)) {
      throw new Error(`Queue promotion operation does not match queue row ${item.$cid}`);
    }
    if (entry.role !== 'user' || entry.id.trim().length === 0 || entry.id !== entry.id.trim()) {
      throw new Error(`Queue promotion requires a user entry with a stable id`);
    }

    const prior = await this.getQueuePromotionRecord(operationId);
    let existing =
      input.existingEntry?.role === 'user' && input.existingEntry.id === entry.id
        ? input.existingEntry
        : undefined;
    if (!existing) {
      const read = await this.readTurn(entry.id);
      existing =
        read.state === 'ready' && read.turn.role === 'user'
          ? (read.turn as SessionHistoryInput)
          : undefined;
    }
    const alreadyAccepted =
      existing !== undefined ||
      prior?.state === 'history_accepted' ||
      prior?.state === 'activation_published' ||
      prior?.state === 'queue_consumed';

    if (!alreadyAccepted) {
      let preparedReceiptError: unknown;
      try {
        await this.setQueuePromotionRecord(operationId, {
          queueCid: item.$cid,
          userTurnId: entry.id,
          state: 'prepared',
          updatedAt: Date.now(),
        });
      } catch (error) {
        // History is itself an exact idempotency witness. If the control-plane
        // receipt is temporarily unavailable, still accept the turn once so a
        // retry can discover that precise row instead of losing the queue item.
        preparedReceiptError = error;
      }
      // Production uses the receipt-aware split writes. Legacy data-only
      // fixtures expose appendUserTurn, which preserves their old atomic
      // history-plus-activation behavior for tests and migration callers.
      if (
        typeof this.queuePort.getQueuePromotionRecord === 'function' &&
        typeof this.queuePort.setQueuePromotionRecord === 'function'
      ) {
        await this.sessionDoc.sessionData.commands.appendTurn(entry as unknown as SessionTurn);
      } else if (this.queuePort.appendUserTurn) {
        await this.queuePort.appendUserTurn(entry);
      } else {
        await this.sessionDoc.sessionData.commands.appendTurn(entry as unknown as SessionTurn);
      }
      if (preparedReceiptError) throw preparedReceiptError;
      await this.setQueuePromotionRecord(operationId, {
        queueCid: item.$cid,
        userTurnId: entry.id,
        state: 'history_accepted',
        updatedAt: Date.now(),
      });
    }

    // Activation is deliberately replayable. If the process died after the
    // history commit, this write repairs the pointer before consuming the row.
    await this.publishUserTurnActivation(entry.id);
    await this.setQueuePromotionRecord(operationId, {
      queueCid: item.$cid,
      userTurnId: entry.id,
      state: 'activation_published',
      updatedAt: Date.now(),
    });
    await this.removeMessageQueueItem(item.$cid);
    await this.setQueuePromotionRecord(operationId, {
      queueCid: item.$cid,
      userTurnId: entry.id,
      state: 'queue_consumed',
      updatedAt: Date.now(),
    });

    return {
      status: alreadyAccepted ? 'already-applied' : 'applied',
      operationId,
      entry: existing ?? entry,
    };
  }

  getMessageQueue(): Promise<readonly MessageQueueItem[]> {
    return this.queuePort.getMessageQueue?.() ?? Promise.resolve([]);
  }

  peekReadyMessageQueue(): Promise<MessageQueueItem | null> {
    if (this.queuePort.peekReadyMessageQueue) return this.queuePort.peekReadyMessageQueue();
    return (
      this.queuePort.getMessageQueue?.().then((queue) => queue[0] ?? null) ?? Promise.resolve(null)
    );
  }

  removeMessageQueueItem(cid: string): Promise<void> {
    return this.queuePort.removeMessageQueueItem?.(cid) ?? Promise.resolve();
  }

  getMetaState(): Promise<SessionMeta | undefined> {
    return this.queuePort.getMetaState?.() ?? Promise.resolve(undefined);
  }

  getQueuePromotionRecord(operationId: string): Promise<SessionQueuePromotionRecord | undefined> {
    return this.queuePort.getQueuePromotionRecord?.(operationId) ?? Promise.resolve(undefined);
  }

  setQueuePromotionRecord(
    operationId: string,
    record: SessionQueuePromotionRecord | undefined
  ): Promise<void> {
    return this.queuePort.setQueuePromotionRecord?.(operationId, record) ?? Promise.resolve();
  }

  getSteerTurnStatuses(): Promise<SessionMeta['steerTurnStatuses']> {
    return this.sessionDoc.getSteerTurnStatuses();
  }

  replaceSteerTurnStatuses(statuses: SessionMeta['steerTurnStatuses']): Promise<void> {
    return this.sessionDoc.replaceSteerTurnStatuses(statuses);
  }

  getQueueOperationId(item: MessageQueueItem): string {
    return item.operationId ?? `queue:${item.userTurnId?.trim() || item.$cid}`;
  }
}

type SessionBackendBinding = {
  readonly kind: SessionHistoryBackendKind;
  readonly backend: SessionBackend;
};

/** One backend instance owns one opened session document for its whole lifetime. */
const sessionBackendBindings = new WeakMap<object, SessionBackendBinding>();

/** Legacy documents without a discriminator remain Loro-backed. */
export function resolveSessionBackendKind(
  meta?: Pick<SessionMeta, 'historyBackend'> | null
): SessionHistoryBackendKind {
  return meta?.historyBackend ?? DEFAULT_SESSION_HISTORY_BACKEND;
}

/**
 * Build the backend for one already-open session. Backend choice is fixed by
 * session metadata; there is deliberately no per-operation fallback.
 */
export function createSessionBackend(
  sessionDoc: SessionDocument,
  meta?: Pick<SessionMeta, 'historyBackend'> | null
): SessionBackend {
  const kind = resolveSessionBackendKind(meta);
  const existing = sessionBackendBindings.get(sessionDoc);
  if (existing) {
    if (existing.kind !== kind) {
      throw new Error(
        `Session backend changed for ${sessionDoc.sessionId}: ${existing.kind} -> ${kind}`
      );
    }
    return existing.backend;
  }
  if (kind !== 'loro') {
    throw new SessionBackendUnavailableError(kind, sessionDoc.sessionId);
  }
  const backend = new LoroSessionBackend(sessionDoc);
  sessionBackendBindings.set(sessionDoc, { kind, backend });
  return backend;
}
