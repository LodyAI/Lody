import {
  getExternalAcpHistoryImportKey,
  getLocalProjectHistoryProviderKey,
  sanitizeLodyInternalInstructions,
  type ACPSessionId,
  type ExternalAcpHistorySyncMeta,
  type LocalProjectHistoryCatalogItem,
  type LocalProjectHistoryProvider,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

import type { MaterializedReplay } from './materialize';

/**
 * Structural view of the provider session rows a history catalog is built from.
 * Matches `SessionInfo` from `@agentclientprotocol/sdk` without importing the
 * transport SDK into this package.
 */
export type HistorySourceSessionInfo = {
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
};

export type ExistingHistorySession = {
  sessionId: SessionId;
  meta: SessionMeta;
};

/**
 * Catalog rows are stored inline in the machine Flock local-project entry, so
 * the listing is capped rather than paged.
 */
export const MAX_LOCAL_PROJECT_HISTORY_CATALOG_SESSIONS = 100;

const MAX_IMPORTED_SESSION_TITLE_CHARS = 80;

export function getProviderLabel(provider: LocalProjectHistoryProvider): string {
  return getLocalProjectHistoryProviderKey(provider);
}

export function getHistoryImportKey(args: {
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

export function resolveSessionTitle(
  info: HistorySourceSessionInfo,
  provider: LocalProjectHistoryProvider
): string {
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

export function buildCatalogItem(
  provider: LocalProjectHistoryProvider,
  info: HistorySourceSessionInfo,
  existing?: ExistingHistorySession
): LocalProjectHistoryCatalogItem {
  return {
    acpSessionId: info.sessionId,
    title: resolveSessionTitle(info, provider),
    updatedAt: info.updatedAt ?? undefined,
    importedSessionId: existing?.sessionId,
    status: getHistoryCatalogStatus(existing),
  };
}

export function shouldSkipBySourceUpdatedAt(
  info: HistorySourceSessionInfo,
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

export function resolveSourceUpdatedAtMs(info: HistorySourceSessionInfo, fallback: number): number {
  if (!info.updatedAt) {
    return fallback;
  }
  const parsed = Date.parse(info.updatedAt);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildExternalHistoryMeta(args: {
  provider: LocalProjectHistoryProvider;
  sourceAcpSessionId: ACPSessionId;
  sourceUpdatedAt?: string | null;
  materialized: MaterializedReplay;
  /** Caller-supplied clock (the CLI passes `getServerNow()`). */
  lastSyncAt: number;
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
    hashVersion: args.materialized.hashVersion,
    lastSyncAt: args.lastSyncAt,
    status: args.status ?? 'synced',
    conflictReason: args.conflictReason,
  };
}

/**
 * Index existing sessions by import key so a re-listing can tell which provider
 * sessions already have a Lody session. Ordering is by `createdAt` so the
 * oldest import wins a duplicate key deterministically.
 */
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
      const importKey = getHistoryImportKey({
        machineId,
        localProjectId,
        provider,
        acpSessionId,
      });
      if (!index.has(importKey)) {
        index.set(importKey, entry);
      }
    }
  }
  return index;
}
