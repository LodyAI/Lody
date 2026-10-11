import {
  type MessageQueueItem,
  normalizeSessionTurnInputConfig,
  type PermissionOutcome,
  type SessionAcpRuntimeConfigPatch,
  type SessionHistoryInput,
  type SessionHistoryBackendKind,
  type SessionMeta,
  type SessionPlanEntry,
  type SessionQueuePromotionRecord,
  type SessionSteerOperationRecord,
} from '@lody/shared';
import { resolveSessionHistoryStatus } from '@lody/shared';
import {
  readLatestTurn as readLatestHistoryTurn,
  type HistoryAction,
  type HistoryImportInput,
  type OpenAssistantTurnInput,
  type ReplaceEditableTailInput,
  type RoostSessionData,
  type SessionActionResult,
  type SessionDirectoryRow,
  type SessionEditableTailResult,
  type SessionHistoryReader,
  type SessionImportResult,
  type SessionSnapshot,
  type SessionTurn,
  type SessionTurnRead,
} from '@lody/shared/session-data';
import type { SessionDocument } from '@/lib/loro/doc';
import type { SessionAgentWrites } from '@/lib/loro/session-agent-writes';
import type {
  QueuePromotionInput,
  QueuePromotionResult,
  SessionAgentBatchInput,
  SessionBackend,
  SessionBackendFactory,
  SessionBackendForkSnapshot,
} from './session-backend';

/**
 * Runtime services owned by the Roost adapter. The control document remains
 * Loro-owned; this object owns only the selected session's history and its
 * history-local write implementation.
 */
export type RoostSessionBackendServices = {
  readonly sessionData: RoostSessionData;
  readonly agentWrites: SessionAgentWrites;
  readonly setPlan: (entries: readonly SessionPlanEntry[]) => Promise<void>;
  readonly initialize?: (options: { readonly skipAutoRead: boolean }) => Promise<void>;
  readonly flushLocalWrites?: () => Promise<void>;
  /**
   * Confirms local history durability and any backend-owned synchronization
   * that actually exists. A true result is not a claim that Roost history
   * reached a remote server unless the host supplies that implementation.
   */
  readonly waitUntilSynced?: (options?: { readonly timeoutMs?: number }) => Promise<boolean>;
  readonly getTurnStorageMetadata?: (
    turnId: string
  ) => Promise<{ readonly capturedAtMs: number; readonly orderKey: string } | undefined>;
  readonly dispose?: () => void | Promise<void>;
};

export type RoostSessionBackendServiceFactory = (
  sessionDoc: SessionDocument,
  meta?: Pick<SessionMeta, 'historyBackend'> | null
) => RoostSessionBackendServices | Promise<RoostSessionBackendServices>;

/**
 * A backend implementation for an already-created Roost history service.
 *
 * This class intentionally does not construct a Roost owner. The host supplies
 * the owner through `RoostSessionBackendServices`; this keeps identity, local
 * database, and browser/Node lifecycle outside session orchestration while
 * allowing the rest of Lody to use the normal SessionBackend contract.
 */
export class RoostSessionBackend implements SessionBackend {
  readonly kind: SessionHistoryBackendKind = 'roost';
  private autoReadUnsubscribe: (() => void) | undefined;
  private autoReadInFlight: Promise<void> | undefined;

  constructor(
    private readonly sessionDoc: SessionDocument,
    private readonly services: RoostSessionBackendServices,
    private readonly fallbackMeta?: Pick<SessionMeta, 'historyBackend'> | SessionMeta | null
  ) {}

  get history(): SessionHistoryReader {
    return this.services.sessionData.history;
  }

  async initialize(options: { skipAutoRead: boolean }): Promise<void> {
    await this.services.initialize?.(options);
    if (options.skipAutoRead) return;

    const markLatestPendingUserAsSeen = async (): Promise<void> => {
      if (this.autoReadInFlight) return this.autoReadInFlight;
      const run = (async () => {
        const latestUser = await this.readLatestTurn('user');
        if (!latestUser || resolveSessionHistoryStatus(latestUser) !== 'pending') return;
        await this.applyHistoryAction({
          kind: 'user-status',
          turnId: latestUser.id,
          status: 'seen',
        });
      })();
      this.autoReadInFlight = run;
      try {
        await run;
      } finally {
        if (this.autoReadInFlight === run) this.autoReadInFlight = undefined;
      }
    };

    const observation = this.history.observe(() => {
      void markLatestPendingUserAsSeen().catch(() => {});
    });
    this.autoReadUnsubscribe = observation.unsubscribe;
    await markLatestPendingUserAsSeen();
  }

  async readHistory(): Promise<SessionHistoryInput[]> {
    const entries = await this.history.readAll();
    return entries.map((entry) => ({
      ...entry,
      inputConfig: normalizeSessionTurnInputConfig(entry.inputConfig),
    })) as SessionHistoryInput[];
  }

  async captureForkSnapshot(): Promise<SessionBackendForkSnapshot> {
    const storageSnapshot = await this.services.sessionData.snapshots.capture();
    return {
      backendKind: this.kind,
      history: storageSnapshot.history,
      storageSnapshot,
    };
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
    await this.services.sessionData.snapshots.copyFrom(
      snapshot.storageSnapshot as SessionSnapshot,
      selection as unknown as readonly SessionTurn[]
    );
  }

  async readHistoryCount(): Promise<number> {
    return await this.history.count();
  }

  async readHistoryDirectory(from: number, to: number): Promise<readonly SessionDirectoryRow[]> {
    return await this.history.readDirectory(from, to);
  }

  async readLatestTurn(role: SessionTurn['role']): Promise<SessionTurn | undefined> {
    const paged = this.history.readLatestDirectoryPage;
    const older = this.history.readOlderDirectoryPage;
    if (!paged || !older) return readLatestHistoryTurn(this.history, role);

    let page = await paged(40);
    for (;;) {
      for (let index = page.rows.length - 1; index >= 0; index -= 1) {
        const row = page.rows[index];
        if (!row?.turnId || row.scalars?.role !== role) continue;
        const read = await this.history.readTurn(row.turnId);
        if (read.state === 'ready' && read.turn.role === role) return read.turn;
      }
      if (!page.hasMoreOlder || !page.cursor) return undefined;
      page = await older(page.cursor, 40);
    }
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
    const provided = await this.services.getTurnStorageMetadata?.(turnId);
    if (provided) return provided;
    const read = await this.history.readTurn(turnId);
    if (read.state !== 'ready') return undefined;
    const capturedAtMs = Date.parse(read.turn.timestamp);
    if (!Number.isFinite(capturedAtMs)) return undefined;
    return {
      capturedAtMs,
      orderKey: `${capturedAtMs}:${turnId}`,
    };
  }

  subscribeHistory(listener: () => void): () => void {
    const observation = this.history.observe(() => listener());
    return observation.unsubscribe;
  }

  applyHistoryAction(action: HistoryAction): Promise<SessionActionResult> {
    return this.services.sessionData.commands.applyHistoryAction(action);
  }

  applyHistoryImport(input: HistoryImportInput): Promise<SessionImportResult> {
    return this.services.sessionData.commands.applyHistoryImport(input);
  }

  applyAcpRuntimeConfigPatch(
    basedOnUserTurnId: string,
    patch: SessionAcpRuntimeConfigPatch
  ): Promise<boolean> {
    return Promise.resolve(this.sessionDoc.applyAcpRuntimeConfigPatch(basedOnUserTurnId, patch));
  }

  replaceEditableTail(input: ReplaceEditableTailInput): Promise<SessionEditableTailResult> {
    return this.services.sessionData.commands.replaceEditableTail(input);
  }

  openAssistantTurn(input: OpenAssistantTurnInput): Promise<void> {
    return this.services.agentWrites.openAssistantTurn(input);
  }

  respondPermission(
    requestId: string,
    outcome: PermissionOutcome,
    options?: { readonly turnId?: string }
  ): Promise<boolean> {
    return this.services.sessionData.commands.respondPermission(requestId, outcome, options);
  }

  applyAgentBatch(input: SessionAgentBatchInput): Promise<void> {
    return this.services.agentWrites.applyAgentBatch(input);
  }

  setPlan(entries: readonly SessionPlanEntry[]): Promise<void> {
    return this.services.setPlan(entries);
  }

  appendHistoryTurn(entry: SessionHistoryInput): Promise<void> {
    return this.services.sessionData.commands.appendTurn(entry as unknown as SessionTurn);
  }

  async appendUserTurn(entry: SessionHistoryInput): Promise<void> {
    if (entry.role !== 'user') {
      throw new Error(
        `appendUserTurn requires a user entry, received role "${entry.role}" for ${entry.id}`
      );
    }
    await this.appendHistoryTurn(entry);
    await this.publishUserTurnActivation(entry.id);
  }

  publishUserTurnActivation(userTurnId: string): Promise<void> {
    return this.sessionDoc.publishUserTurnActivation(userTurnId);
  }

  async promoteQueuedTurn(input: QueuePromotionInput): Promise<QueuePromotionResult> {
    const { item, entry, operationId } = input;
    if (operationId !== this.getQueueOperationId(item)) {
      throw new Error(`Queue promotion operation does not match queue row ${item.$cid}`);
    }
    if (entry.role !== 'user' || entry.id.trim().length === 0 || entry.id !== entry.id.trim()) {
      throw new Error('Queue promotion requires a user entry with a stable id');
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
        preparedReceiptError = error;
      }
      await this.appendHistoryTurn(entry);
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
    return this.sessionDoc.getMessageQueue();
  }

  peekReadyMessageQueue(): Promise<MessageQueueItem | null> {
    return this.sessionDoc.peekReadyMessageQueue();
  }

  removeMessageQueueItem(cid: string): Promise<void> {
    return this.sessionDoc.removeMessageQueueItem(cid);
  }

  getMetaState(): Promise<SessionMeta | undefined> {
    return this.sessionDoc
      .getMetaState()
      .then((meta) => meta ?? (this.fallbackMeta as SessionMeta));
  }

  getQueuePromotionRecord(operationId: string): Promise<SessionQueuePromotionRecord | undefined> {
    return this.sessionDoc.getQueuePromotionRecord(operationId);
  }

  setQueuePromotionRecord(
    operationId: string,
    record: SessionQueuePromotionRecord | undefined
  ): Promise<void> {
    return this.sessionDoc.setQueuePromotionRecord(operationId, record);
  }

  getSteerTurnStatuses(): Promise<SessionMeta['steerTurnStatuses']> {
    return this.sessionDoc.getSteerTurnStatuses();
  }

  replaceSteerTurnStatuses(statuses: SessionMeta['steerTurnStatuses']): Promise<void> {
    return this.sessionDoc.replaceSteerTurnStatuses(statuses);
  }

  getSteerOperationRecord(operationId: string): Promise<SessionSteerOperationRecord | undefined> {
    return this.sessionDoc.getSteerOperationRecord(operationId);
  }

  getSteerOperationLedger(): Promise<SessionMeta['steerOperationLedger']> {
    return this.sessionDoc.getSteerOperationLedger();
  }

  setSteerOperationRecord(
    operationId: string,
    record: SessionSteerOperationRecord | undefined
  ): Promise<void> {
    return this.sessionDoc.setSteerOperationRecord(operationId, record);
  }

  async flushLocalWrites(): Promise<void> {
    await this.services.flushLocalWrites?.();
    await this.sessionDoc.flushLocalWrites();
  }

  /** The local Node owner currently has no remote Roost transport. */
  async waitUntilSynced(options?: { timeoutMs?: number }): Promise<boolean> {
    const [historySynced, controlSynced] = await Promise.all([
      this.services.waitUntilSynced?.(options) ?? Promise.resolve(true),
      this.sessionDoc.waitUntilSynced(options),
    ]);
    return historySynced && controlSynced;
  }

  async dispose(): Promise<void> {
    this.autoReadUnsubscribe?.();
    this.autoReadUnsubscribe = undefined;
    if (this.services.dispose) await this.services.dispose();
    else this.services.sessionData.dispose?.();
  }

  getQueueOperationId(item: MessageQueueItem): string {
    return item.operationId ?? `queue:${item.userTurnId?.trim() || item.$cid}`;
  }
}

/**
 * Adapt an owner/service resolver to Lody's existing backend factory shape.
 * Registration remains explicit; importing this module never changes the
 * default Loro selector.
 */
export function createRoostSessionBackendFactory(
  resolveServices: RoostSessionBackendServiceFactory
): SessionBackendFactory {
  return async (sessionDoc, meta) =>
    new RoostSessionBackend(sessionDoc, await resolveServices(sessionDoc, meta), meta);
}
