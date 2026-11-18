import type {
  SessionBackend,
  SessionBackendForkSnapshot,
  QueuePromotionInput,
  QueuePromotionResult,
  SessionAgentBatchInput,
} from '@lody/shared/node/native-session-contract';
export type {
  SessionBackend,
  SessionBackendForkSnapshot,
  QueuePromotionInput,
  QueuePromotionResult,
  SessionAgentBatchInput,
} from '@lody/shared/node/native-session-contract';
import { promoteSessionQueuedTurn } from './native-session-queue-promotion';
import {
  resolveSessionHistoryBackendKind,
  type MessageQueueItem,
  type SessionHistoryBackendKind,
  type SessionHistoryInput,
  type SessionMeta,
  type SessionQueuePromotionRecord,
  type SessionAcpRuntimeConfigPatch,
  type SessionSteerOperationRecord,
  type SessionPlanEntry,
  type SessionGoalMessage,
} from '@lody/shared';
import {
  readSessionHistory,
  readLatestTurn as readLatestHistoryTurn,
  type HistoryImportInput,
  type HistoryAction,
  type HistoryQueryRow,
  type ReplaceEditableTailInput,
  type SessionImportResult,
  type SessionActionResult,
  type SessionHistoryReader,
  type SessionDirectoryRow,
  type SessionEditableTailResult,
  type SessionTurn,
  type SessionTurnRead,
  type OpenAssistantTurnInput,
} from '@lody/shared/session-data';
import type { SessionDocument } from '@/lib/loro/doc';
import type { AcpSessionNotification, MessageContent, ModelInfo } from '@lody/shared';
import type { SessionSnapshot } from '@lody/shared/session-data';
import {
  readDispatchHistory,
  readDispatchSelection,
  type SessionDispatchEntry,
  type SessionDispatchSelection,
  type SessionDispatchSelector,
} from './session-dispatch-history';

export const getSteerOperationId = (userTurnId: string): string => `steer:${userTurnId.trim()}`;

/** Read the first stored occurrence, retaining duplicate-ID semantics on Loro. */
export async function readHistoryEntry(
  backend: Pick<SessionBackend, 'readHistoryEntry' | 'readHistorySelection'>,
  turnId: string
): Promise<SessionHistoryInput | undefined> {
  if (backend.readHistoryEntry) return backend.readHistoryEntry(turnId);
  const [entry] = await backend.readHistorySelection((rows) => {
    const index = rows.findIndex((row) => row.id === turnId);
    return index < 0 ? [] : [index];
  });
  return entry;
}

/** Explicit failure when a persisted backend has no installed product adapter. */
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

  constructor(
    private readonly sessionDoc: SessionDocument,
    private readonly fallbackMeta?: Pick<SessionMeta, 'historyBackend'> | SessionMeta | null
  ) {}

  get history(): SessionHistoryReader {
    return this.sessionDoc.sessionData.history;
  }

  async initialize(options: { skipAutoRead: boolean }): Promise<void> {
    if (options.skipAutoRead) return;
    this.sessionDoc.attachAutoRead();
    this.sessionDoc.attachModelSummary();
    await this.sessionDoc.markLatestUserHistoryAsSeenIfNeeded();
  }

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
      getSteerTurnStatuses?: () => Promise<SessionMeta['steerTurnStatuses']>;
      replaceSteerTurnStatuses?: (statuses: SessionMeta['steerTurnStatuses']) => Promise<void>;
      getSteerOperationRecord?: (
        operationId: string
      ) => Promise<SessionSteerOperationRecord | undefined>;
      getSteerOperationLedger?: () => Promise<SessionMeta['steerOperationLedger']>;
      setSteerOperationRecord?: (
        operationId: string,
        record: SessionSteerOperationRecord | undefined
      ) => Promise<void>;
    };
  }

  async readHistory(): Promise<SessionHistoryInput[]> {
    return readSessionHistory(this.sessionDoc.sessionData.history) as SessionHistoryInput[];
  }

  async foldHistory<T>(
    create: () => T,
    visit: (state: T, entry: SessionHistoryInput) => void
  ): Promise<T> {
    const state = create();
    this.sessionDoc.sessionData.writer.forEachStored((entry) => visit(state, entry));
    return state;
  }

  async readHistoryQuery(options?: {
    from?: number;
    to?: number;
    transcriptVisibility?: boolean;
  }): Promise<readonly HistoryQueryRow[]> {
    return this.sessionDoc.sessionData.writer
      .readQuery(options)
      .slice(options?.from ?? 0, options?.to);
  }

  async readHistorySelection(
    select: (rows: readonly HistoryQueryRow[]) => readonly number[],
    options?: { transcriptVisibility?: boolean }
  ): Promise<SessionHistoryInput[]> {
    return this.sessionDoc.sessionData.writer.readSelected(select, options);
  }

  async readLatestGoal(): Promise<SessionGoalMessage | null> {
    return this.sessionDoc.sessionData.readLatestGoal();
  }

  async readLatestUserId(): Promise<string | undefined> {
    return this.sessionDoc.sessionData.readLatestUserId();
  }

  readDispatchHistory(includeTurnIds: readonly string[]): Promise<SessionDispatchEntry[]> {
    return readDispatchHistory(this.history, includeTurnIds);
  }

  readDispatchSelection(
    includeTurnIds: readonly string[],
    select: SessionDispatchSelector
  ): Promise<SessionDispatchSelection> {
    return readDispatchSelection(this.history, includeTurnIds, select);
  }

  async captureForkSnapshot(): Promise<SessionBackendForkSnapshot> {
    const storageSnapshot = await this.sessionDoc.sessionData.snapshots.capture();
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
    await this.sessionDoc.sessionData.snapshots.copyFrom(
      snapshot.storageSnapshot as SessionSnapshot,
      selection as unknown as readonly SessionTurn[]
    );
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

  async readTurnOutput(userTurnId: string): Promise<SessionHistoryInput[]> {
    return (await this.sessionDoc.sessionData.history.readTurnOutput(
      userTurnId
    )) as SessionHistoryInput[];
  }

  async getTurnStorageMetadata(
    turnId: string
  ): Promise<{ readonly capturedAtMs: number; readonly orderKey: string } | undefined> {
    return (
      this.sessionDoc as unknown as {
        getAssistantHistoryEntryTurnStorageMetadata?: (
          turnId: string
        ) => { readonly capturedAtMs: number; readonly orderKey: string } | undefined;
      }
    ).getAssistantHistoryEntryTurnStorageMetadata?.(turnId);
  }

  subscribeHistory(listener: () => void): () => void {
    const observation = this.sessionDoc.sessionData.history.observe(() => listener());
    return () => observation.unsubscribe();
  }

  applyHistoryAction(action: HistoryAction): Promise<SessionActionResult> {
    return this.sessionDoc.sessionData.commands.applyHistoryAction(action);
  }

  applyHistoryImport(input: HistoryImportInput): Promise<SessionImportResult> {
    return this.sessionDoc.sessionData.commands.applyHistoryImport(input);
  }

  async applyAcpRuntimeConfigPatch(
    basedOnUserTurnId: string,
    patch: SessionAcpRuntimeConfigPatch
  ): Promise<boolean> {
    return this.sessionDoc.applyAcpRuntimeConfigPatch(basedOnUserTurnId, patch);
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
    return promoteSessionQueuedTurn(
      this,
      async (entry) => {
        // Data-only legacy fixtures retain their old append+activation behavior.
        if (
          typeof this.queuePort.getQueuePromotionRecord !== 'function' ||
          typeof this.queuePort.setQueuePromotionRecord !== 'function'
        ) {
          if (this.queuePort.appendUserTurn) return this.queuePort.appendUserTurn(entry);
        }
        await this.sessionDoc.sessionData.commands.appendTurn(entry as unknown as SessionTurn);
      },
      input
    );
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
    return (
      this.queuePort.getMetaState?.() ??
      Promise.resolve(this.fallbackMeta as SessionMeta | undefined)
    );
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
    return (
      this.queuePort.getSteerTurnStatuses?.() ??
      Promise.resolve((this.fallbackMeta as SessionMeta | undefined)?.steerTurnStatuses)
    );
  }

  replaceSteerTurnStatuses(statuses: SessionMeta['steerTurnStatuses']): Promise<void> {
    if (this.queuePort.replaceSteerTurnStatuses) {
      return this.queuePort.replaceSteerTurnStatuses(statuses);
    }
    if (this.fallbackMeta) {
      (this.fallbackMeta as SessionMeta).steerTurnStatuses = statuses;
    }
    return Promise.resolve();
  }

  getSteerOperationRecord(operationId: string): Promise<SessionSteerOperationRecord | undefined> {
    return (
      this.queuePort.getSteerOperationRecord?.(operationId) ??
      Promise.resolve(
        (this.fallbackMeta as SessionMeta | undefined)?.steerOperationLedger?.[operationId]
      )
    );
  }

  getSteerOperationLedger(): Promise<SessionMeta['steerOperationLedger']> {
    return (
      this.queuePort.getSteerOperationLedger?.() ??
      Promise.resolve((this.fallbackMeta as SessionMeta | undefined)?.steerOperationLedger)
    );
  }

  setSteerOperationRecord(
    operationId: string,
    record: SessionSteerOperationRecord | undefined
  ): Promise<void> {
    if (this.queuePort.setSteerOperationRecord) {
      return this.queuePort.setSteerOperationRecord(operationId, record);
    }
    if (this.fallbackMeta) {
      const ledger = { ...((this.fallbackMeta as SessionMeta).steerOperationLedger ?? {}) };
      if (record) ledger[operationId] = record;
      else delete ledger[operationId];
      (this.fallbackMeta as SessionMeta).steerOperationLedger = ledger;
    }
    return Promise.resolve();
  }

  flushLocalWrites(): Promise<void> {
    return this.sessionDoc.flushLocalWrites();
  }

  waitUntilSynced(options?: { timeoutMs?: number }): Promise<boolean> {
    return this.sessionDoc.waitUntilSynced(options);
  }

  getQueueOperationId(item: MessageQueueItem): string {
    return item.operationId ?? `queue:${item.userTurnId?.trim() || item.$cid}`;
  }
}

export type SessionBackendFactory = (
  sessionDoc: SessionDocument,
  meta?: Pick<SessionMeta, 'historyBackend'> | null
) => SessionBackend | Promise<SessionBackend>;

type SessionBackendBinding = {
  readonly kind: SessionHistoryBackendKind;
  readonly backend: Promise<SessionBackend>;
};

/** One backend instance owns one opened session document for its whole lifetime. */
const sessionBackendBindings = new WeakMap<object, SessionBackendBinding>();
const sessionBackendFactories = new Map<SessionHistoryBackendKind, SessionBackendFactory>();

sessionBackendFactories.set('loro', (sessionDoc, meta) => new LoroSessionBackend(sessionDoc, meta));

/** Register a backend without importing its storage library into session orchestration. */
export function registerSessionBackendFactory(
  kind: SessionHistoryBackendKind,
  factory: SessionBackendFactory
): () => void {
  if (kind === 'loro') throw new Error('The Loro backend factory is built in');
  if (sessionBackendFactories.has(kind)) {
    throw new Error(`A session backend factory is already registered for ${kind}`);
  }
  sessionBackendFactories.set(kind, factory);
  return () => {
    if (sessionBackendFactories.get(kind) === factory) sessionBackendFactories.delete(kind);
  };
}

/**
 * Daemon composition for Roost history: a Session owned by another machine uses
 * the owner route; this machine's Sessions, or ones whose owner is not yet known,
 * keep the installed local owner.
 */
export function routeRemoteOwnedSessionHistory(
  localMachineId: string,
  remote: SessionBackendFactory
): SessionBackendFactory {
  return async (sessionDoc, meta) => {
    const owner = (await (sessionDoc.getMetaState?.() ?? Promise.resolve(undefined)))?.machineId;
    if (owner && owner !== localMachineId) return await remote(sessionDoc, meta);
    const local = sessionBackendFactories.get('roost');
    if (!local) throw new SessionBackendUnavailableError('roost', sessionDoc.sessionId);
    return await local(sessionDoc, meta);
  };
}

/** Legacy documents without a discriminator remain Loro-backed. */
export function resolveSessionBackendKind(
  meta?: Pick<SessionMeta, 'historyBackend'> | null
): SessionHistoryBackendKind {
  return resolveSessionHistoryBackendKind(meta);
}

/**
 * Build the backend for one already-open session. Backend choice is fixed by
 * session metadata; there is deliberately no per-operation fallback.
 */
export async function createSessionBackend(
  sessionDoc: SessionDocument,
  meta?: Pick<SessionMeta, 'historyBackend'> | null
): Promise<SessionBackend> {
  const existing = sessionBackendBindings.get(sessionDoc);
  if (existing) {
    if (meta !== undefined) {
      const requestedKind = resolveSessionBackendKind(meta);
      if (existing.kind !== requestedKind) {
        throw new Error(
          `Session backend changed for ${sessionDoc.sessionId}: ${existing.kind} -> ${requestedKind}`
        );
      }
    }
    return await existing.backend;
  }
  const sessionMeta =
    meta === undefined ? await (sessionDoc.getMetaState?.() ?? Promise.resolve(undefined)) : meta;
  const kind = resolveSessionBackendKind(sessionMeta);
  const native = sessionDoc.getNativeSessionBackend?.();
  if (native && kind !== 'loro')
    throw new Error('Native Session owner cannot replace Roost history');
  const factory = native
    ? () => native
    : kind === 'roost'
      ? (sessionDoc.historyBackendFactory ?? sessionBackendFactories.get(kind))
      : sessionBackendFactories.get(kind);
  if (!factory) throw new SessionBackendUnavailableError(kind, sessionDoc.sessionId);
  const backend = Promise.resolve()
    .then(() => factory(sessionDoc, sessionMeta))
    .then((value) =>
      native || kind !== 'loro' ? value : (sessionDoc.guardLegacySessionBackend?.(value) ?? value)
    );
  const binding = { kind, backend };
  sessionBackendBindings.set(sessionDoc, binding);
  try {
    const resolved = await backend;
    if (resolved.kind !== kind) {
      throw new Error(
        `Session backend factory returned ${resolved.kind} for ${sessionDoc.sessionId}; expected ${kind}`
      );
    }
    return resolved;
  } catch (error) {
    if (sessionBackendBindings.get(sessionDoc) === binding)
      sessionBackendBindings.delete(sessionDoc);
    throw error;
  }
}

/** Release backend-owned observers and storage handles before the session doc closes. */
export async function disposeSessionBackend(sessionDoc: SessionDocument): Promise<void> {
  const binding = sessionBackendBindings.get(sessionDoc);
  if (!binding) return;
  const backend = await binding.backend;
  await backend.dispose?.();
  if (sessionBackendBindings.get(sessionDoc) === binding) sessionBackendBindings.delete(sessionDoc);
}

export {
  createRoostSessionBackendFactory,
  RoostSessionBackend,
  type RoostSessionBackendServiceFactory,
  type RoostSessionBackendServices,
} from './roost-session-backend';
