import type {
  MessageQueueItem,
  SessionHistoryBackendKind,
  SessionHistoryInput,
  SessionMeta,
  SessionQueuePromotionRecord,
  SessionAcpRuntimeConfigPatch,
  SessionSteerOperationRecord,
  SessionPlanEntry,
  SessionGoalMessage,
  AcpSessionNotification,
  MessageContent,
  ModelInfo,
} from '../index';
import type {
  HistoryImportInput,
  HistoryAction,
  HistoryQueryRow,
  ReplaceEditableTailInput,
  SessionImportResult,
  SessionActionResult,
  SessionHistoryReader,
  SessionDirectoryRow,
  SessionEditableTailResult,
  SessionTurn,
  SessionTurnRead,
  OpenAssistantTurnInput,
} from '../session-data';
import type {
  SessionDispatchEntry,
  SessionDispatchSelection,
  SessionDispatchSelector,
} from './native-session-dispatch-history';
/**
 * Logical history and delivery operations consumed by session orchestration.
 *
 * This is intentionally narrower than `SessionDocument`: callers get the
 * domain history port and queue operations, but not Loro containers, mirrors,
 * or repo handles. A Roost adapter can implement the same contract while
 * projecting physical segments into the same logical history.
 */
export interface SessionBackend {
  readonly inputAcceptance?: import('@lody/shared/session-data').SessionInputAcceptance;
  readonly kind: SessionHistoryBackendKind;
  readonly history: SessionHistoryReader;

  initialize(options: { skipAutoRead: boolean }): Promise<void>;
  readHistory(): Promise<SessionHistoryInput[]>;
  readonly readHistoryInspection?: (
    query: import('@lody/shared').SessionHistoryInspectionQuery
  ) => Promise<import('@lody/shared').SessionHistoryReadResponse>;
  readonly readHistoryReplay?: (
    excludeTurnId?: string
  ) => Promise<import('@lody/shared').ReplayPromptResult>;
  readonly readHistoryTranscript?: (options: { limit?: number; reverse?: boolean }) => Promise<{
    total: number;
    positions: number[];
    entries: SessionHistoryInput[];
  }>;
  readonly readHistoryEntry?: (turnId: string) => Promise<SessionHistoryInput | undefined>;
  foldHistory<T>(
    create: () => T,
    visit: (state: T, entry: SessionHistoryInput) => void
  ): Promise<T>;
  readHistoryQuery(options?: {
    from?: number;
    to?: number;
    transcriptVisibility?: boolean;
  }): Promise<readonly HistoryQueryRow[]>;
  readHistorySelection(
    select: (rows: readonly HistoryQueryRow[]) => readonly number[],
    options?: { transcriptVisibility?: boolean }
  ): Promise<SessionHistoryInput[]>;
  /** Read the latest goal from local history. */
  readonly readLatestGoal: () => Promise<SessionGoalMessage | null>;
  readonly readLatestUserId?: () => Promise<string | undefined>;
  readDispatchHistory(includeTurnIds: readonly string[]): Promise<SessionDispatchEntry[]>;
  readDispatchSelection(
    includeTurnIds: readonly string[],
    select: SessionDispatchSelector
  ): Promise<SessionDispatchSelection>;
  captureForkSnapshot(): Promise<SessionBackendForkSnapshot>;
  importForkHistory(
    snapshot: SessionBackendForkSnapshot,
    selection: readonly SessionHistoryInput[]
  ): Promise<void>;
  readHistoryCount(): Promise<number>;
  readHistoryDirectory(from: number, to: number): Promise<readonly SessionDirectoryRow[]>;
  readLatestTurn(role: SessionTurn['role']): Promise<SessionTurn | undefined>;
  readTurn(turnId: string): Promise<SessionTurnRead>;
  readTurnOutput(userTurnId: string): Promise<SessionHistoryInput[]>;
  /** Stable logical ordering metadata used to persist turn-scoped diff evidence. */
  getTurnStorageMetadata(
    turnId: string
  ): Promise<{ readonly capturedAtMs: number; readonly orderKey: string } | undefined>;
  subscribeHistory(listener: () => void): () => void;
  applyHistoryAction(action: HistoryAction): Promise<SessionActionResult>;
  applyHistoryImport(input: HistoryImportInput): Promise<SessionImportResult>;
  applyAcpRuntimeConfigPatch(
    basedOnUserTurnId: string,
    patch: SessionAcpRuntimeConfigPatch
  ): Promise<boolean>;
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
  getSteerOperationRecord(operationId: string): Promise<SessionSteerOperationRecord | undefined>;
  getSteerOperationLedger(): Promise<SessionMeta['steerOperationLedger']>;
  setSteerOperationRecord(
    operationId: string,
    record: SessionSteerOperationRecord | undefined
  ): Promise<void>;
  flushLocalWrites(): Promise<void>;
  waitUntilSynced(options?: { timeoutMs?: number }): Promise<boolean>;
  dispose?(): void | Promise<void>;

  /** Stable identity used to correlate queue retries with one logical turn. */
  getQueueOperationId(item: MessageQueueItem): string;
}

/** Opaque source snapshot plus the logical rows needed to select a fork range. */
export type SessionBackendForkSnapshot = {
  readonly backendKind: SessionHistoryBackendKind;
  readonly history: readonly SessionHistoryInput[];
  /** Passed through to the destination backend; callers must not inspect it. */
  readonly storageSnapshot: unknown;
};

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
  /**
   * Stable per-item identities aligned with `notifications` or `contents`.
   * Backends must make a retry with the same identity idempotent, including
   * when an earlier item in the batch committed before a later item failed.
   */
  readonly operationIds?: readonly string[];
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
