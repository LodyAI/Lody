import { readSessionHistory } from '@lody/shared/session-data';
import {
  hashText,
  hashHistoryEntry,
  resolveImportedTurnHashes,
  storedBaselineHashes,
  areStringArraysEqual,
  decideHistoryRefresh,
  decideHistoryConflictResolution,
  type HistoryConflictResolutionDecision,
  type HistoryImportInput,
} from '@lody/shared/session-data';
export { decideHistoryRefresh, decideHistoryConflictResolution } from '@lody/shared/session-data';
export type {
  HistoryRefreshDecision,
  HistoryConflictResolutionDecision,
} from '@lody/shared/session-data';
import { v4 as uuidV4 } from 'uuid';
import type { SessionInfo } from '@agentclientprotocol/sdk';

import {
  type ACPSessionId,
  type ExternalAcpHistorySyncMeta,
  getMachineRoomId,
  type LocalProjectHistoryCatalogItem,
  type LocalProjectHistoryCatalogResult,
  type LocalProjectHistoryConflictResolveResult,
  type LocalProjectHistoryImportResult,
  type LocalProjectHistorySyncSummary,
  type LocalProjectHistoryProvider,
  type LocalProjectId,
  type MachineId,
  type SessionHistoryInput,
  type SessionMeta,
  type WorkspaceId,
  buildHistoryReplayImport,
  getExternalAcpHistoryImportKey,
  getLocalProjectHistoryProviderKey,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isSessionDocRoomId,
  isActiveSessionStatus,
  isSessionHistoryPendingForDispatch,
  sanitizeLodyInternalInstructions,
  SessionStatusFactory,
  type ProjectRef,
  type SessionId,
} from '@lody/shared';

import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import { readMachineLocalProjects, upsertMachineLocalProject } from '@/lib/local-project-meta';
import {
  listHistorySessionsForLocalProject,
  loadHistorySessionReplay,
  MAX_LOCAL_PROJECT_HISTORY_CATALOG_SESSIONS,
} from './history-session-catalog-client';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

const syncLeases = new Set<string>();

// In-process serializer for machineRoomId-scoped catalog writes. History rows
// are stored in machine Flock localProject entries, but each provider still does
// a read-modify-write for its nested catalog. Two concurrent providers operating
// on the same machine could otherwise clobber each other's history fields.
//
// Per-process only; cross-process races on the same machineRoomId remain
// possible but require simultaneous CLI processes for the same machine, which
// is not the normal mode of operation.
const machineCatalogWriteChains = new Map<string, Promise<unknown>>();

async function withMachineCatalogWriteLock<T>(
  machineRoomId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = machineCatalogWriteChains.get(machineRoomId);
  const current = (async () => {
    if (prev) {
      await prev.catch(() => {
        // swallow prior errors — they belong to other callers, not us
      });
    }
    return fn();
  })();
  machineCatalogWriteChains.set(machineRoomId, current);
  try {
    return await current;
  } finally {
    if (machineCatalogWriteChains.get(machineRoomId) === current) {
      machineCatalogWriteChains.delete(machineRoomId);
    }
  }
}

type ExistingHistorySession = {
  sessionId: SessionId;
  meta: SessionMeta;
};

export type MaterializedReplay = {
  history: SessionHistoryInput[];
  turnHashes: string[];
  replayDigest: string;
  droppedNotifications: number;
};

type HistoryCatalogSnapshot = {
  sessions: SessionInfo[];
  existingByImportKey: Map<string, ExistingHistorySession>;
};

class HistoryRefreshConflict extends Error {}

function emptySummary(): LocalProjectHistorySyncSummary {
  return {
    listed: 0,
    imported: 0,
    refreshed: 0,
    skipped: 0,
    conflicted: 0,
    failed: 0,
    failures: [],
  };
}

function materializeReplay(args: {
  provider: LocalProjectHistoryProvider;
  acpSessionId: ACPSessionId;
  replayNotifications: Parameters<typeof buildHistoryReplayImport>[0];
  userId: string;
}): MaterializedReplay {
  let tempId = 0;
  const nowIso = new Date(getServerNow()).toISOString();
  const providerKey = getLocalProjectHistoryProviderKey(args.provider);
  const replay = buildHistoryReplayImport(args.replayNotifications, {
    provider: args.provider,
    acpSessionId: args.acpSessionId,
    userId: args.userId,
    now: () => nowIso,
    createId: () => `${providerKey}:${args.acpSessionId}:tmp:${tempId++}`,
    mode: 'imported_snapshot',
  });
  const turnHashes = replay.history.map(hashHistoryEntry);
  const history = replay.history.map((entry, index) => ({
    ...entry,
    id: `${providerKey}:${args.acpSessionId}:turn:${index}:${turnHashes[index]!.slice(0, 16)}`,
  }));

  return {
    history,
    turnHashes,
    replayDigest: hashText(turnHashes.join('\n')),
    droppedNotifications: replay.droppedNotifications,
  };
}

async function applyBoundHistoryImport(
  sessionDoc: SessionDocument,
  input: HistoryImportInput
): Promise<number> {
  const result = await sessionDoc.sessionData.commands.applyHistoryImport(input);
  if (result.status === 'accepted') return result.appended;
  if (result.status === 'rejected') {
    if (
      result.reason.code === 'prefix_mismatch' ||
      result.reason.code === 'local_history_has_untracked_suffix'
    )
      throw new HistoryRefreshConflict(result.reason.code);
    throw new Error(`History import was rejected before commit: ${result.reason.code}`);
  }
  throw new Error('History import outcome is unknown', { cause: result.cause });
}

async function readSessionImportedTurnHashes(
  sessionDoc: SessionDocument,
  externalHistory: ExternalAcpHistorySyncMeta
): Promise<readonly string[]> {
  const cursor = await sessionDoc.getExternalHistoryCursor();
  return resolveImportedTurnHashes(externalHistory, cursor?.importedTurnHashes);
}

function hasPendingDispatchHistory(history: readonly SessionHistoryInput[]): boolean {
  return history.some((entry) => isSessionHistoryPendingForDispatch(entry));
}

function formatHistoryConflictResolutionBlocker(
  decision: Extract<HistoryConflictResolutionDecision, { status: 'blocked' }>
): string {
  switch (decision.reason) {
    case 'source_replay_empty':
      return 'Cannot replace history because the latest source replay produced no turns.';
    case 'source_replay_dropped_notifications':
      return 'Cannot replace history because the latest source replay contains unsupported or malformed notifications.';
    case 'source_replay_behind_import_cursor':
      return 'Cannot replace history because the latest source replay is shorter than the last imported cursor.';
    case 'session_has_pending_local_turn':
      return 'Cannot replace history while the imported session has a pending local turn.';
    case 'not_sync_conflict':
      return 'Only sessions currently marked as history sync conflicts can be re-imported.';
  }
  return 'Cannot replace history because the conflict resolution state is invalid.';
}

async function listWorkspaceSessionMetas(
  manager: LoroDocumentManager
): Promise<Array<{ sessionId: SessionId; meta: SessionMeta }>> {
  const scanner = manager.repo.getMeta();
  if (!scanner) {
    return [];
  }

  const roomIds = new Set<string>();
  for (const row of await scanner.scan({ prefix: ['m'] })) {
    const key = row.key;
    if (!Array.isArray(key) || key.length < 2) {
      continue;
    }
    const roomId = key[1];
    if (typeof roomId === 'string' && isSessionDocRoomId(roomId)) {
      roomIds.add(roomId);
    }
  }

  const metas = await Promise.all(
    [...roomIds].map(async (roomId) => {
      const record = await manager.repo.getDocMeta(roomId);
      if (!record?.meta || isLoroRepoDocDeleted(record)) {
        return null;
      }
      const sessionId = roomId.slice('session-'.length) as SessionId;
      return { sessionId, meta: record.meta as SessionMeta };
    })
  );
  return metas.filter((meta): meta is { sessionId: SessionId; meta: SessionMeta } => meta !== null);
}

export function buildExistingHistorySessionIndex(
  metas: Array<{ sessionId: SessionId; meta: SessionMeta }>,
  machineId: MachineId,
  provider: LocalProjectHistoryProvider,
  localProjectId: LocalProjectId
): Map<string, ExistingHistorySession> {
  const index = new Map<string, ExistingHistorySession>();
  const providerKey = getLocalProjectHistoryProviderKey(provider);
  const sortedMetas = [...metas].sort((left, right) => {
    const leftCreatedAt = Date.parse(left.meta.createdAt);
    const rightCreatedAt = Date.parse(right.meta.createdAt);
    const createdAtDiff =
      (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0) -
      (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0);
    if (createdAtDiff !== 0) return createdAtDiff;
    return left.sessionId.localeCompare(right.sessionId);
  });
  for (const entry of sortedMetas) {
    if (entry.meta.machineId !== machineId) continue;
    if (entry.meta.cliType !== provider.cliType) continue;
    if (entry.meta.agentType !== provider.agentType) continue;
    if (entry.meta.project?.kind !== 'local') continue;
    if (entry.meta.project.localProjectId !== localProjectId) continue;
    const acpSessionIds = new Set<string>();
    if (
      entry.meta.externalHistory &&
      getLocalProjectHistoryProviderKey(entry.meta.externalHistory.provider) === providerKey
    ) {
      const sourceAcpSessionId = entry.meta.externalHistory.sourceAcpSessionId;
      if (sourceAcpSessionId) {
        acpSessionIds.add(sourceAcpSessionId);
      }
      if (entry.meta.acpSessionId && entry.meta.acpSessionId !== sourceAcpSessionId) {
        acpSessionIds.add(entry.meta.acpSessionId);
      }
    } else if (entry.meta.acpSessionId) {
      acpSessionIds.add(entry.meta.acpSessionId);
    }
    for (const acpSessionId of acpSessionIds) {
      const importKey = getExternalAcpHistoryImportKey({
        machineId,
        localProjectId,
        provider,
        sourceAcpSessionId: acpSessionId,
      });
      if (!index.has(importKey)) {
        index.set(importKey, entry);
      }
    }
  }
  return index;
}

function getProviderLabel(provider: LocalProjectHistoryProvider): string {
  return getLocalProjectHistoryProviderKey(provider);
}

function getHistoryImportKey(args: {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  provider: LocalProjectHistoryProvider;
  acpSessionId: string;
}): string {
  return getExternalAcpHistoryImportKey({
    machineId: args.machineId,
    localProjectId: args.localProjectId,
    provider: args.provider,
    sourceAcpSessionId: args.acpSessionId,
  });
}

const MAX_IMPORTED_SESSION_TITLE_CHARS = 80;

function resolveSessionTitle(info: SessionInfo, provider: LocalProjectHistoryProvider): string {
  // Provider titles are usually derived from the first recorded user message,
  // which can carry Lody-appended instruction tails.
  const cleaned = info.title?.trim() ? sanitizeLodyInternalInstructions(info.title) : '';
  const title = cleaned.replace(/\s+/g, ' ').trim().slice(0, MAX_IMPORTED_SESSION_TITLE_CHARS);
  return title || `${getProviderLabel(provider)} session`;
}

function parseUpdatedAtMs(updatedAt: string | undefined): number {
  if (!updatedAt) return 0;
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Exported only for unit tests; do not call from outside this module.
export function compareCatalogItems(
  left: LocalProjectHistoryCatalogItem,
  right: LocalProjectHistoryCatalogItem
): number {
  const leftUpdatedAt = parseUpdatedAtMs(left.updatedAt);
  const rightUpdatedAt = parseUpdatedAtMs(right.updatedAt);
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }
  return left.title.localeCompare(right.title);
}

export function selectLatestCatalogItems(
  items: readonly LocalProjectHistoryCatalogItem[]
): LocalProjectHistoryCatalogItem[] {
  return [...items].sort(compareCatalogItems).slice(0, MAX_LOCAL_PROJECT_HISTORY_CATALOG_SESSIONS);
}

export function getHistoryCatalogStatus(existing?: {
  meta: SessionMeta;
}): LocalProjectHistoryCatalogItem['status'] {
  if (!existing) return 'available';
  if (existing.meta.externalHistory?.status === 'metadata_only') return 'available';
  return existing.meta.externalHistory?.status === 'sync_conflict' ? 'sync_conflict' : 'imported';
}

function buildCatalogItem(
  provider: LocalProjectHistoryProvider,
  info: SessionInfo,
  existing?: ExistingHistorySession
): LocalProjectHistoryCatalogItem {
  const acpSessionId = info.sessionId;
  return {
    acpSessionId,
    title: resolveSessionTitle(info, provider),
    updatedAt: info.updatedAt ?? undefined,
    importedSessionId: existing?.sessionId,
    status: getHistoryCatalogStatus(existing),
  };
}

function shouldSkipBySourceUpdatedAt(
  info: SessionInfo,
  externalHistory: ExternalAcpHistorySyncMeta
): boolean {
  if (externalHistory.status === 'metadata_only') {
    return false;
  }
  if (!info.updatedAt || !externalHistory.sourceUpdatedAt) {
    return false;
  }
  const next = Date.parse(info.updatedAt);
  const current = Date.parse(externalHistory.sourceUpdatedAt);
  return Number.isFinite(next) && Number.isFinite(current) && next <= current;
}

function resolveSourceUpdatedAtMs(info: SessionInfo, fallback: number): number {
  if (!info.updatedAt) {
    return fallback;
  }
  const parsed = Date.parse(info.updatedAt);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildExternalHistoryMeta(args: {
  provider: LocalProjectHistoryProvider;
  sourceAcpSessionId: ACPSessionId;
  sourceUpdatedAt?: string | null;
  materialized: MaterializedReplay;
  status?: ExternalAcpHistorySyncMeta['status'];
  conflictReason?: string;
}): ExternalAcpHistorySyncMeta {
  return {
    provider: args.provider,
    source: 'local-acp-history',
    sourceAcpSessionId: args.sourceAcpSessionId,
    sourceUpdatedAt: args.sourceUpdatedAt ?? undefined,
    replayDigest: args.materialized.replayDigest,
    importedTurnCount: args.materialized.turnHashes.length,
    lastSyncAt: getServerNow(),
    status: args.status ?? 'synced',
    conflictReason: args.conflictReason,
  };
}

export class LocalProjectHistorySyncService {
  private readonly provider: LocalProjectHistoryProvider;
  private readonly providerKey: string;

  constructor(
    private readonly manager: LoroDocumentManager,
    private readonly logger: Logger,
    private readonly context: {
      workspaceId: WorkspaceId;
      machineId: MachineId;
      userId: string;
    },
    provider: LocalProjectHistoryProvider
  ) {
    this.provider = provider;
    this.providerKey = getLocalProjectHistoryProviderKey(provider);
  }

  async syncLocalProject(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
  }): Promise<LocalProjectHistoryCatalogResult> {
    const leaseKey =
      `${this.providerKey}:${this.context.workspaceId}:` +
      `${this.context.machineId}:${args.localProjectId}`;
    if (syncLeases.has(leaseKey)) {
      throw new Error(
        `${getProviderLabel(this.provider)} history sync is already running for this local project`
      );
    }
    syncLeases.add(leaseKey);
    try {
      return await this.syncLocalProjectInner(args);
    } finally {
      syncLeases.delete(leaseKey);
    }
  }

  private async syncLocalProjectInner(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
  }): Promise<LocalProjectHistoryCatalogResult> {
    const snapshot = await this.listCatalogSnapshot(args);
    return await this.writeCatalogResult({
      localProjectId: args.localProjectId,
      sessions: snapshot.sessions,
      existingByImportKey: snapshot.existingByImportKey,
    });
  }

  async importLocalProjectSessions(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    acpSessionIds: string[];
  }): Promise<LocalProjectHistoryImportResult> {
    const leaseKey =
      `${this.providerKey}:${this.context.workspaceId}:` +
      `${this.context.machineId}:${args.localProjectId}`;
    if (syncLeases.has(leaseKey)) {
      throw new Error(
        `${getProviderLabel(this.provider)} history sync is already running for this local project`
      );
    }
    syncLeases.add(leaseKey);
    try {
      return await this.importLocalProjectSessionsInner(args);
    } finally {
      syncLeases.delete(leaseKey);
    }
  }

  async resolveHistoryConflict(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    sessionId: SessionId;
    acpSessionId: string;
  }): Promise<LocalProjectHistoryConflictResolveResult> {
    const leaseKey =
      `${this.providerKey}:${this.context.workspaceId}:` +
      `${this.context.machineId}:${args.localProjectId}`;
    if (syncLeases.has(leaseKey)) {
      throw new Error(
        `${getProviderLabel(this.provider)} history sync is already running for this local project`
      );
    }
    syncLeases.add(leaseKey);
    try {
      return await this.resolveHistoryConflictInner(args);
    } finally {
      syncLeases.delete(leaseKey);
    }
  }

  private async importLocalProjectSessionsInner(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    acpSessionIds: string[];
  }): Promise<LocalProjectHistoryImportResult> {
    const summary = emptySummary();
    const selectedIds = [...new Set(args.acpSessionIds)];
    summary.listed = selectedIds.length;
    const snapshot = await this.listCatalogSnapshot({
      ...args,
      requiredSessionIds: selectedIds,
    });
    const infoByAcpSessionId = new Map(snapshot.sessions.map((info) => [info.sessionId, info]));
    const project: ProjectRef = { kind: 'local', localProjectId: args.localProjectId };

    for (const selectedId of selectedIds) {
      const acpSessionId = selectedId as unknown as ACPSessionId;
      const info = infoByAcpSessionId.get(selectedId);
      try {
        if (!info) {
          throw new Error(
            `${getProviderLabel(this.provider)} session was not found in the local project catalog`
          );
        }

        const importKey = getHistoryImportKey({
          machineId: this.context.machineId,
          localProjectId: args.localProjectId,
          provider: this.provider,
          acpSessionId: selectedId,
        });
        const existing =
          (await this.findExistingHistorySession(args.localProjectId, selectedId)) ??
          snapshot.existingByImportKey.get(importKey);
        if (!existing) {
          const replayNotifications = await loadHistorySessionReplay({
            provider: this.provider,
            rootPath: args.rootPath,
            acpSessionId,
            logger: this.logger,
          });
          const materialized = materializeReplay({
            provider: this.provider,
            acpSessionId,
            replayNotifications,
            userId: this.context.userId,
          });
          const importedSession = await this.importNewSession({
            info,
            acpSessionId,
            project,
            materialized,
          });
          snapshot.existingByImportKey.set(importKey, importedSession);
          summary.imported += 1;
          continue;
        }

        snapshot.existingByImportKey.set(importKey, existing);
        const status = await this.refreshExistingSession({
          existing,
          info,
          acpSessionId,
          rootPath: args.rootPath,
        });
        summary[status] += 1;
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({
          acpSessionId,
          message: formatErrorMessage(error),
        });
        this.logger.warn(
          `[${this.providerKey}-history-sync] Failed to import ${getProviderLabel(
            this.provider
          )} session ${acpSessionId}: ${formatErrorMessage(error)}`
        );
      }
    }

    const catalog = await this.writeCatalogResult({
      localProjectId: args.localProjectId,
      sessions: snapshot.sessions,
      existingByImportKey: snapshot.existingByImportKey,
    });
    return { summary, catalog };
  }

  private async resolveHistoryConflictInner(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    sessionId: SessionId;
    acpSessionId: string;
  }): Promise<LocalProjectHistoryConflictResolveResult> {
    const snapshot = await this.listCatalogSnapshot({
      ...args,
      requiredSessionIds: [args.acpSessionId],
    });
    const info = snapshot.sessions.find((session) => session.sessionId === args.acpSessionId);
    if (!info) {
      throw new Error(
        `${getProviderLabel(this.provider)} session was not found in the local project catalog`
      );
    }

    const importKey = getHistoryImportKey({
      machineId: this.context.machineId,
      localProjectId: args.localProjectId,
      provider: this.provider,
      acpSessionId: args.acpSessionId,
    });
    const finishResolved = async (
      meta: SessionMeta
    ): Promise<LocalProjectHistoryConflictResolveResult> => {
      snapshot.existingByImportKey.set(importKey, { sessionId: args.sessionId, meta });
      const catalog = await this.writeCatalogResult({
        localProjectId: args.localProjectId,
        sessions: snapshot.sessions,
        existingByImportKey: snapshot.existingByImportKey,
      });
      return {
        sessionId: args.sessionId,
        acpSessionId: args.acpSessionId,
        status: 'resolved',
        catalog,
      };
    };
    const indexedExisting = snapshot.existingByImportKey.get(importKey);
    if (!indexedExisting || indexedExisting.sessionId !== args.sessionId) {
      throw new Error('Imported session no longer matches the selected ACP history session.');
    }

    const roomId = getSessionRoomId(args.sessionId);
    const record = await this.manager.repo.getDocMeta(roomId);
    if (!record?.meta || isLoroRepoDocDeleted(record)) {
      throw new Error('Imported session was deleted.');
    }
    const meta = record.meta as SessionMeta;
    if (!this.isMatchingHistorySession(meta, args.localProjectId, args.acpSessionId)) {
      throw new Error('Imported session metadata no longer matches the selected ACP history.');
    }
    if (isActiveSessionStatus(meta.status)) {
      throw new Error('Cannot replace history while the imported session is active.');
    }

    const sessionDoc = await this.manager.getOrCreateSessionDoc(args.sessionId);
    const currentHistoryBeforeReplay = await readSessionHistory(sessionDoc.sessionData.history);
    if (hasPendingDispatchHistory(currentHistoryBeforeReplay)) {
      throw new Error(
        'Cannot replace history while the imported session has a pending local turn.'
      );
    }
    const existingExternalHistory = meta.externalHistory;
    if (!existingExternalHistory) {
      throw new Error('Imported session metadata no longer matches the selected ACP history.');
    }
    if (existingExternalHistory.status !== 'sync_conflict') {
      const cursor = await sessionDoc.getExternalHistoryCursor();
      const importedTurnHashes = await readSessionImportedTurnHashes(
        sessionDoc,
        existingExternalHistory
      );
      if (
        areStringArraysEqual(
          currentHistoryBeforeReplay.map(hashHistoryEntry),
          storedBaselineHashes(cursor, importedTurnHashes)
        )
      ) {
        return finishResolved(meta);
      }
      throw new Error(
        formatHistoryConflictResolutionBlocker({
          status: 'blocked',
          reason: 'not_sync_conflict',
        })
      );
    }

    const acpSessionId = args.acpSessionId as unknown as ACPSessionId;
    const replayNotifications = await loadHistorySessionReplay({
      provider: this.provider,
      rootPath: args.rootPath,
      acpSessionId,
      logger: this.logger,
    });
    const materialized = materializeReplay({
      provider: this.provider,
      acpSessionId,
      replayNotifications,
      userId: this.context.userId,
    });

    const latestRecord = await this.manager.repo.getDocMeta(roomId);
    if (!latestRecord?.meta || isLoroRepoDocDeleted(latestRecord)) {
      throw new Error('Imported session was deleted.');
    }
    const latestMeta = latestRecord.meta as SessionMeta;
    if (!this.isMatchingHistorySession(latestMeta, args.localProjectId, args.acpSessionId)) {
      throw new Error('Imported session metadata no longer matches the selected ACP history.');
    }
    if (isActiveSessionStatus(latestMeta.status)) {
      throw new Error('Cannot replace history while the imported session is active.');
    }
    const latestExternalHistory = latestMeta.externalHistory;
    if (!latestExternalHistory) {
      throw new Error('Imported session metadata no longer matches the selected ACP history.');
    }

    const latestImportedTurnHashes = await readSessionImportedTurnHashes(
      sessionDoc,
      latestExternalHistory
    );
    const latestCursor = await sessionDoc.getExternalHistoryCursor();
    const latestHistory = await readSessionHistory(sessionDoc.sessionData.history);
    const decision = decideHistoryConflictResolution({
      externalHistory: latestExternalHistory,
      importedTurnHashes: latestImportedTurnHashes,
      materialized,
      currentHistoryHashes: latestHistory.map(hashHistoryEntry),
      storedHistoryHashes: storedBaselineHashes(latestCursor, latestImportedTurnHashes),
      currentHistoryHasPendingDispatch: hasPendingDispatchHistory(latestHistory),
    });
    if (decision.status === 'blocked') {
      throw new Error(formatHistoryConflictResolutionBlocker(decision));
    }
    if (decision.status === 'already_resolved') {
      return finishResolved(latestMeta);
    }

    const nextExternalHistory = buildExternalHistoryMeta({
      provider: this.provider,
      sourceAcpSessionId: acpSessionId,
      sourceUpdatedAt: info.updatedAt,
      materialized,
    });
    const lastMessageAt = resolveSourceUpdatedAtMs(info, getServerNow());

    await applyBoundHistoryImport(sessionDoc, {
      mode: 'resolve-conflict',
      replay: materialized,
      externalHistory: latestExternalHistory,
    });
    await this.manager.repo.upsertDocMeta(roomId, {
      origin: 'external-acp',
      lastMessageAt,
      externalHistory: nextExternalHistory,
    } satisfies Partial<SessionMeta>);

    const synced = await sessionDoc.waitUntilSynced();
    if (!synced) {
      throw new Error(
        `Replaced history for ${args.sessionId} did not confirm sync before timeout.`
      );
    }

    return finishResolved({
      ...latestMeta,
      origin: 'external-acp',
      lastMessageAt,
      externalHistory: nextExternalHistory,
    });
  }

  private async listCatalogSnapshot(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    requiredSessionIds?: readonly string[];
  }): Promise<HistoryCatalogSnapshot> {
    const catalog = await listHistorySessionsForLocalProject({
      provider: this.provider,
      rootPath: args.rootPath,
      logger: this.logger,
      requiredSessionIds: args.requiredSessionIds,
    });

    const sessionMetas = await listWorkspaceSessionMetas(this.manager);
    const existingByImportKey = buildExistingHistorySessionIndex(
      sessionMetas,
      this.context.machineId,
      this.provider,
      args.localProjectId
    );

    return { sessions: catalog.sessions, existingByImportKey };
  }

  private async findExistingHistorySession(
    localProjectId: LocalProjectId,
    acpSessionId: string
  ): Promise<ExistingHistorySession | undefined> {
    const importKey = getHistoryImportKey({
      machineId: this.context.machineId,
      localProjectId,
      provider: this.provider,
      acpSessionId,
    });
    const sessionMetas = await listWorkspaceSessionMetas(this.manager);
    return buildExistingHistorySessionIndex(
      sessionMetas,
      this.context.machineId,
      this.provider,
      localProjectId
    ).get(importKey);
  }

  private isMatchingHistorySession(
    meta: SessionMeta,
    localProjectId: LocalProjectId,
    acpSessionId: string
  ): boolean {
    if (meta.machineId !== this.context.machineId) return false;
    if (meta.cliType !== this.provider.cliType) return false;
    if (meta.agentType !== this.provider.agentType) return false;
    if (meta.project?.kind !== 'local') return false;
    if (meta.project.localProjectId !== localProjectId) return false;
    if (
      !meta.externalHistory ||
      getLocalProjectHistoryProviderKey(meta.externalHistory.provider) !== this.providerKey
    ) {
      return false;
    }
    return meta.externalHistory.sourceAcpSessionId === acpSessionId;
  }

  private async writeCatalogResult(args: {
    localProjectId: LocalProjectId;
    sessions: SessionInfo[];
    existingByImportKey: Map<string, ExistingHistorySession>;
  }): Promise<LocalProjectHistoryCatalogResult> {
    const lastListedAt = Math.round(getServerNow());
    const sessions = selectLatestCatalogItems(
      args.sessions.map((info) =>
        buildCatalogItem(
          this.provider,
          info,
          args.existingByImportKey.get(
            getHistoryImportKey({
              machineId: this.context.machineId,
              localProjectId: args.localProjectId,
              provider: this.provider,
              acpSessionId: info.sessionId,
            })
          )
        )
      )
    );

    const catalog = {
      listed: sessions.length,
      lastListedAt,
      sessions,
    };

    const machineRoomId = getMachineRoomId(this.context.machineId);
    // Serialize the read-modify-write of the project row so concurrent providers
    // on the same machine cannot snapshot the same project and clobber each other's
    // nested history fields.
    await withMachineCatalogWriteLock(machineRoomId, async () => {
      const existing = await readMachineLocalProjects(
        this.manager.repo,
        this.context.workspaceId,
        this.context.machineId
      );
      const previous = existing[args.localProjectId];
      if (!previous) {
        return;
      }
      await upsertMachineLocalProject(
        this.manager.repo,
        this.context.workspaceId,
        this.context.machineId,
        {
          ...previous,
          history: {
            ...(previous.history ?? {}),
            [this.providerKey]: {
              lastListedAt,
              sessions: Object.fromEntries(sessions.map((item) => [item.acpSessionId, item])),
            },
          },
        },
        lastListedAt,
        { sync: this.manager, reason: 'local-project-history-sync' }
      );
    });

    return catalog;
  }

  private async importNewSession(args: {
    info: SessionInfo;
    acpSessionId: ACPSessionId;
    project: ProjectRef;
    materialized: MaterializedReplay;
  }): Promise<ExistingHistorySession> {
    const sessionId = uuidV4() as SessionId;
    const roomId = getSessionRoomId(sessionId);
    const nowMs = getServerNow();
    const lastMessageAt = resolveSourceUpdatedAtMs(args.info, nowMs);
    const meta: SessionMeta = {
      id: sessionId,
      machineId: this.context.machineId,
      createdAt: new Date(nowMs).toISOString(),
      userId: this.context.userId,
      status: SessionStatusFactory.idle(),
      isArchived: false,
      origin: 'external-acp',
      cliType: this.provider.cliType,
      agentType: this.provider.agentType,
      project: args.project,
      title: resolveSessionTitle(args.info, this.provider),
      // Imported titles are placeholders derived from provider data; allow the title
      // generator to replace them later, same as web-created draft titles.
      titleSource: 'draft',
      lastMessageAt,
      externalHistory: buildExternalHistoryMeta({
        provider: this.provider,
        sourceAcpSessionId: args.acpSessionId,
        sourceUpdatedAt: args.info.updatedAt,
        materialized: args.materialized,
      }),
    };

    try {
      const sessionDoc = await this.manager.getOrCreateSessionDoc(sessionId);
      await applyBoundHistoryImport(sessionDoc, { mode: 'initialize', replay: args.materialized });
      await this.manager.repo.upsertDocMeta(roomId, meta);
      const synced = await sessionDoc.waitUntilSynced();
      if (!synced) {
        this.logger.warn(
          `[${this.providerKey}-history-sync] Imported history for ${sessionId} did not ` +
            'confirm remote sync before unload; it remains locally durable and will retry sync.'
        );
      }
    } catch (error) {
      await this.manager.repo.deleteDoc(roomId).catch((cleanupError) => {
        this.logger.warn(
          `[${this.providerKey}-history-sync] Failed to delete incomplete imported session ` +
            `${sessionId}: ${formatErrorMessage(cleanupError)}`
        );
      });
      await this.manager
        .cleanSessionDoc(sessionId, { preserveStatus: true })
        .catch((cleanupError) => {
          this.logger.warn(
            `[${this.providerKey}-history-sync] Failed to unload incomplete imported session ` +
              `${sessionId}: ${formatErrorMessage(cleanupError)}`
          );
        });
      throw error;
    }
    await this.manager
      .cleanSessionDoc(sessionId, { preserveStatus: true })
      .catch((cleanupError) => {
        this.logger.warn(
          `[${this.providerKey}-history-sync] Failed to unload imported session ` +
            `${sessionId}: ${formatErrorMessage(cleanupError)}`
        );
      });
    return { sessionId, meta };
  }

  private async refreshExistingSession(args: {
    existing: ExistingHistorySession;
    info: SessionInfo;
    acpSessionId: ACPSessionId;
    rootPath: string;
  }): Promise<'refreshed' | 'skipped' | 'conflicted'> {
    const externalHistory = args.existing.meta.externalHistory;
    if (
      !externalHistory ||
      getLocalProjectHistoryProviderKey(externalHistory.provider) !== this.providerKey
    ) {
      return 'skipped';
    }
    if (shouldSkipBySourceUpdatedAt(args.info, externalHistory)) {
      return 'skipped';
    }

    const replayNotifications = await loadHistorySessionReplay({
      provider: this.provider,
      rootPath: args.rootPath,
      acpSessionId: args.acpSessionId,
      logger: this.logger,
    });
    const materialized = materializeReplay({
      provider: this.provider,
      acpSessionId: args.acpSessionId,
      replayNotifications,
      userId: this.context.userId,
    });
    const sessionDoc = await this.manager.getOrCreateSessionDoc(args.existing.sessionId);
    let appended = 0;
    try {
      appended = await applyBoundHistoryImport(sessionDoc, {
        mode: 'refresh',
        replay: materialized,
        externalHistory,
      });
    } catch (error) {
      if (!(error instanceof HistoryRefreshConflict)) throw error;
      await this.markConflict(args.existing.sessionId, args.info, materialized, error.message);
      // Wait for the conflict marker to reach Streams before unloading the doc
      // handle. If we unload too early, the conflict state can remain
      // local-cache only and the user sees an "imported" session while other
      // clients keep seeing the stale state.
      const synced = await sessionDoc.waitUntilSynced();
      if (!synced) {
        this.logger.debug(
          `[${this.providerKey}-history-sync] Conflict marker for ${
            args.existing.sessionId
          } did not confirm sync before unload; clients may see the previous state until next sync.`
        );
      }
      await this.manager.cleanSessionDoc(args.existing.sessionId, { preserveStatus: true });
      return 'conflicted';
    }

    await this.manager.repo.upsertDocMeta(getSessionRoomId(args.existing.sessionId), {
      origin: 'external-acp',
      lastMessageAt: resolveSourceUpdatedAtMs(args.info, getServerNow()),
      externalHistory: buildExternalHistoryMeta({
        provider: this.provider,
        sourceAcpSessionId: args.acpSessionId,
        sourceUpdatedAt: args.info.updatedAt,
        materialized,
      }),
    } satisfies Partial<SessionMeta>);
    // Wait for the appended history and updated cursor to reach Streams before
    // unloading. Otherwise the new turns may live only in this process's local
    // cache, and a refresh from another client will see the prior cursor and
    // think the import never happened.
    const synced = await sessionDoc.waitUntilSynced();
    if (!synced) {
      this.logger.debug(
        `[${this.providerKey}-history-sync] Appended history for ${
          args.existing.sessionId
        } did not confirm sync before unload; ` +
          'other clients may see the previous state until next sync.'
      );
    }
    await this.manager.cleanSessionDoc(args.existing.sessionId, { preserveStatus: true });
    return externalHistory.status === 'metadata_only' || appended > 0 ? 'refreshed' : 'skipped';
  }

  private async markConflict(
    sessionId: SessionId,
    info: SessionInfo,
    materialized: MaterializedReplay,
    reason: string
  ): Promise<void> {
    await this.manager.repo.upsertDocMeta(getSessionRoomId(sessionId), {
      origin: 'external-acp',
      externalHistory: buildExternalHistoryMeta({
        provider: this.provider,
        sourceAcpSessionId: info.sessionId as unknown as ACPSessionId,
        sourceUpdatedAt: info.updatedAt,
        materialized,
        status: 'sync_conflict',
        conflictReason: reason,
      }),
    } satisfies Partial<SessionMeta>);
  }
}
