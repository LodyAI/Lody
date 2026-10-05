import type {
  MessageQueueItem,
  PermissionOutcome,
  SessionHistoryInput,
  SessionPlanEntry,
  SessionQueuePromotionRecord,
  SessionSteerOperationRecord,
} from '@lody/shared';
import { fromApplicationJson, type HistoryProjectedMessage } from '@loro-dev/roost/lody-history';
import {
  createRoostHistoryReader,
  projectRoostSegments,
  readLatestTurn,
  type HistoryAction,
  type HistoryImportInput,
  type OpenAssistantTurnInput,
  type RoostHistoryChange,
  type RoostHistoryPort,
  type RoostHistorySegment,
  type SessionActionResult,
  type SessionDirectoryRow,
  type SessionEditableTailResult,
  type SessionHistoryReader,
  type SessionSnapshot,
  type SessionTurn,
  type SessionTurnRead,
} from '@lody/shared/session-data';
import { createRoostReadPort } from '../src/session/roost-history-port';
import type {
  QueuePromotionFailurePoint,
  SessionBackendContractFixture,
} from './session-backend-contract';
import type {
  QueuePromotionInput,
  QueuePromotionResult,
  SessionAgentBatchInput,
  SessionBackend,
  SessionBackendForkSnapshot,
} from '../src/session/session-backend';

const queueItem = {
  $cid: 'roost-queue-cid-1',
  task: 'hello',
  userId: 'user-1',
  userTurnId: 'roost-turn-1',
  operationId: 'queue:roost-turn-1',
  timestamp: '2026-10-03T00:00:00.000Z',
  acpSessionConfig: {},
} as unknown as MessageQueueItem;

const otherQueueItem = {
  ...queueItem,
  $cid: 'roost-queue-cid-2',
  userTurnId: 'roost-turn-2',
  operationId: 'queue:roost-turn-2',
} as MessageQueueItem;

const userEntry: SessionHistoryInput = {
  id: 'roost-turn-1',
  role: 'user',
  timestamp: queueItem.timestamp,
  userId: 'user-1',
  status: 'pending',
  items: [{ type: 'text', text: 'hello' }],
  fileDiff: [],
};

const clone = <T>(value: T): T => structuredClone(value);

const segmentFor = (
  entry: SessionHistoryInput,
  segmentId: string,
  sealed = entry.finished === true
): RoostHistorySegment => ({
  businessId: entry.id,
  segmentId,
  content: clone(entry),
  nextSeq: 1n,
  sealed,
});

class RoostFixtureStore implements RoostHistoryPort {
  private segments: RoostHistorySegment[] = [];
  private readonly listeners = new Set<(change: RoostHistoryChange) => void>();
  private segmentCounter = 0;

  readProjectedMessages(): Promise<readonly RoostHistorySegment[]> {
    return Promise.resolve(clone(this.segments));
  }

  readCandidateProjectedMessages(): Promise<HistoryProjectedMessage[]> {
    return Promise.resolve(
      this.segments.map((segment) => ({
        businessId: segment.businessId,
        segmentId: segment.segmentId,
        turnId: new Uint8Array(16),
        content: fromApplicationJson(segment.content),
        nextSeq: segment.nextSeq ?? 0n,
        sealed: segment.sealed,
      }))
    );
  }

  observe(listener: (change: RoostHistoryChange) => void) {
    this.listeners.add(listener);
    return {
      initial: this.readProjectedMessages(),
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  append(entry: SessionHistoryInput, sealed = entry.finished === true): void {
    const priorIds = new Set(projectRoostSegments(this.segments).map((turn) => turn.id));
    this.segments.push(segmentFor(entry, `segment-${++this.segmentCounter}`, sealed));
    const kind = priorIds.has(entry.id) ? 'changed' : 'structure';
    for (const listener of this.listeners) {
      listener(
        kind === 'changed'
          ? { kind, businessIds: [entry.id] }
          : { kind, from: priorIds.size, to: priorIds.size + 1 }
      );
    }
  }

  replace(entries: readonly SessionHistoryInput[]): void {
    this.segments = entries.map((entry) =>
      segmentFor(entry, `segment-${++this.segmentCounter}`, entry.finished === true)
    );
    for (const listener of this.listeners) {
      listener({ kind: 'structure', from: 0, to: entries.length });
    }
  }
}

class RoostFixtureBackend implements SessionBackend {
  readonly kind = 'roost' as const;
  readonly history: SessionHistoryReader;
  private readonly promotionRecords = new Map<string, SessionQueuePromotionRecord>();
  private readonly queueRows: MessageQueueItem[];
  private activation: string | undefined;
  private failureConsumed = false;

  constructor(
    private readonly store: RoostFixtureStore,
    private readonly failOnceAt: QueuePromotionFailurePoint | undefined
  ) {
    this.history = createRoostHistoryReader(
      createRoostReadPort(
        { readProjectedMessages: () => store.readCandidateProjectedMessages() },
        store.observe.bind(store)
      )
    );
    this.queueRows = [queueItem, otherQueueItem];
  }

  private failOnce(point: QueuePromotionFailurePoint): void {
    if (this.failOnceAt !== point || this.failureConsumed) return;
    this.failureConsumed = true;
    throw new Error(`injected Roost fixture failure at ${point}`);
  }

  initialize(_options: { skipAutoRead: boolean }): Promise<void> {
    return Promise.resolve();
  }

  async readHistory(): Promise<SessionHistoryInput[]> {
    return (await this.history.readAll()) as SessionHistoryInput[];
  }

  async captureForkSnapshot(): Promise<SessionBackendForkSnapshot> {
    const history = await this.readHistory();
    const storageSnapshot: SessionSnapshot = {
      history,
    } as SessionSnapshot;
    return { backendKind: this.kind, history, storageSnapshot };
  }

  async importForkHistory(
    snapshot: SessionBackendForkSnapshot,
    selection: readonly SessionHistoryInput[]
  ): Promise<void> {
    if (snapshot.backendKind !== this.kind) {
      throw new Error(
        `Cannot import ${snapshot.backendKind} fork snapshot into ${this.kind} history`
      );
    }
    this.store.replace(selection);
  }

  readHistoryCount(): Promise<number> {
    return Promise.resolve(this.history.count());
  }

  readHistoryDirectory(from: number, to: number): Promise<readonly SessionDirectoryRow[]> {
    return Promise.resolve(this.history.readDirectory(from, to));
  }

  async readLatestTurn(role: SessionTurn['role']): Promise<SessionTurn | undefined> {
    return readLatestTurn(this.history, role);
  }

  readTurn(turnId: string): Promise<SessionTurnRead> {
    return Promise.resolve(this.history.readTurn(turnId));
  }

  async readTurnOutput(userTurnId: string): Promise<SessionHistoryInput[]> {
    return (await this.history.readTurnOutput(userTurnId)) as SessionHistoryInput[];
  }

  async getTurnStorageMetadata(
    turnId: string
  ): Promise<{ readonly capturedAtMs: number; readonly orderKey: string } | undefined> {
    const read = await this.history.readTurn(turnId);
    if (read.state !== 'ready') return undefined;
    const capturedAtMs = Date.parse(read.turn.timestamp);
    return {
      capturedAtMs: Number.isFinite(capturedAtMs) ? capturedAtMs : 0,
      orderKey: `${capturedAtMs}:${turnId}`,
    };
  }

  subscribeHistory(listener: () => void): () => void {
    const observation = this.history.observe(() => listener());
    return observation.unsubscribe;
  }

  applyHistoryAction(_action: HistoryAction): Promise<SessionActionResult> {
    return Promise.resolve({ matched: false });
  }

  applyHistoryImport(_input: HistoryImportInput) {
    return Promise.resolve({ status: 'accepted' as const, appended: 0 });
  }

  applyAcpRuntimeConfigPatch(
    _basedOnUserTurnId: string,
    _patch: Parameters<SessionBackend['applyAcpRuntimeConfigPatch']>[1]
  ): Promise<boolean> {
    return Promise.resolve(false);
  }

  replaceEditableTail(
    _input: Parameters<SessionBackend['replaceEditableTail']>[0]
  ): Promise<SessionEditableTailResult> {
    return Promise.resolve({
      status: 'rejected',
      reason: { code: 'unsupported' },
    });
  }

  async openAssistantTurn(input: OpenAssistantTurnInput): Promise<void> {
    const existing = await this.history.readTurn(input.turnId);
    if (existing.state === 'ready') return;
    this.store.append({
      id: input.turnId,
      role: 'assistant',
      timestamp: input.timestamp,
      ...(input.userTurnId ? { userTurnId: input.userTurnId } : {}),
      ...(input.modelInfo ? { modelInfo: input.modelInfo } : {}),
      items: [],
      fileDiff: [],
    });
  }

  respondPermission(
    _requestId: string,
    _outcome: PermissionOutcome,
    _options?: { readonly turnId?: string }
  ): Promise<boolean> {
    return Promise.resolve(false);
  }

  applyAgentBatch(_input: SessionAgentBatchInput): Promise<void> {
    return Promise.resolve();
  }

  setPlan(_entries: readonly SessionPlanEntry[]): Promise<void> {
    return Promise.resolve();
  }

  appendHistoryTurn(entry: SessionHistoryInput): Promise<void> {
    this.store.append(entry);
    return Promise.resolve();
  }

  appendUserTurn(entry: SessionHistoryInput): Promise<void> {
    this.store.append(entry);
    this.failOnce('history_acceptance');
    return Promise.resolve();
  }

  publishUserTurnActivation(userTurnId: string): Promise<void> {
    this.activation = userTurnId;
    this.failOnce('activation_publication');
    return Promise.resolve();
  }

  async promoteQueuedTurn(input: QueuePromotionInput): Promise<QueuePromotionResult> {
    const { item, entry, operationId } = input;
    if (operationId !== this.getQueueOperationId(item)) {
      throw new Error(`Queue promotion operation does not match queue row ${item.$cid}`);
    }
    if (entry.role !== 'user' || entry.id.trim().length === 0 || entry.id !== entry.id.trim()) {
      throw new Error('Queue promotion requires a user entry with a stable id');
    }

    const prior = this.promotionRecords.get(operationId);
    const existingRead = input.existingEntry
      ? { state: 'ready' as const, turn: input.existingEntry }
      : await this.history.readTurn(entry.id);
    const existing =
      existingRead.state === 'ready' && existingRead.turn.role === 'user'
        ? (existingRead.turn as SessionHistoryInput)
        : undefined;
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
        preparedReceiptError = error;
      }
      await this.appendUserTurn(entry);
      if (preparedReceiptError) throw preparedReceiptError;
      await this.setQueuePromotionRecord(operationId, {
        queueCid: item.$cid,
        userTurnId: entry.id,
        state: 'history_accepted',
        updatedAt: Date.now(),
      });
    }

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
    return Promise.resolve([...this.queueRows]);
  }

  peekReadyMessageQueue(): Promise<MessageQueueItem | null> {
    return Promise.resolve(this.queueRows[0] ?? null);
  }

  removeMessageQueueItem(cid: string): Promise<void> {
    const index = this.queueRows.findIndex((item) => item.$cid === cid);
    if (index >= 0) this.queueRows.splice(index, 1);
    this.failOnce('queue_consumption');
    return Promise.resolve();
  }

  getMetaState() {
    return Promise.resolve(undefined);
  }

  getQueuePromotionRecord(operationId: string): Promise<SessionQueuePromotionRecord | undefined> {
    return Promise.resolve(this.promotionRecords.get(operationId));
  }

  setQueuePromotionRecord(
    operationId: string,
    record: SessionQueuePromotionRecord | undefined
  ): Promise<void> {
    if (!record) this.promotionRecords.delete(operationId);
    else this.promotionRecords.set(operationId, record);
    if (record?.state === 'prepared') this.failOnce('prepared_receipt');
    if (record?.state === 'history_accepted') this.failOnce('history_receipt');
    if (record?.state === 'activation_published') this.failOnce('activation_receipt');
    if (record?.state === 'queue_consumed') this.failOnce('consumed_receipt');
    return Promise.resolve();
  }

  getSteerTurnStatuses(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  replaceSteerTurnStatuses(_statuses: undefined): Promise<void> {
    return Promise.resolve();
  }

  getSteerOperationRecord(_operationId: string): Promise<SessionSteerOperationRecord | undefined> {
    return Promise.resolve(undefined);
  }

  getSteerOperationLedger(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  setSteerOperationRecord(
    _operationId: string,
    _record: SessionSteerOperationRecord | undefined
  ): Promise<void> {
    return Promise.resolve();
  }

  flushLocalWrites(): Promise<void> {
    return Promise.resolve();
  }

  waitUntilSynced(_options?: { timeoutMs?: number }): Promise<boolean> {
    return Promise.resolve(true);
  }

  getQueueOperationId(item: MessageQueueItem): string {
    return item.operationId ?? `queue:${item.userTurnId?.trim() || item.$cid}`;
  }

  getActivation(): string | undefined {
    return this.activation;
  }

  getPromotionRecord(operationId: string): SessionQueuePromotionRecord | undefined {
    return this.promotionRecords.get(operationId);
  }
}

export async function createRoostSessionBackendFixture(
  options: {
    failOnceAt?: QueuePromotionFailurePoint;
  } = {}
): Promise<SessionBackendContractFixture> {
  const store = new RoostFixtureStore();
  const backend = new RoostFixtureBackend(store, options.failOnceAt);
  return {
    backend,
    queueItem,
    entry: userEntry,
    readCopies: async (turnId) =>
      (await backend.readHistory()).filter((entry) => entry.id === turnId),
    readQueueCids: async () => (await backend.getMessageQueue()).map((item) => item.$cid),
    readActivation: async () => backend.getActivation(),
    readPromotionRecord: async (operationId) => backend.getPromotionRecord(operationId),
  };
}

export function createRoostFixtureReader(): {
  backend: SessionBackend;
  store: RoostFixtureStore;
} {
  const store = new RoostFixtureStore();
  return { backend: new RoostFixtureBackend(store, undefined), store };
}

export { otherQueueItem, queueItem, userEntry };
