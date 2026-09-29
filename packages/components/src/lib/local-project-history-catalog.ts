import {
  getExternalAcpHistoryImportKey,
  getLocalProjectHistoryProviderKey,
  matchesHistoryProviderBinding,
  type LocalProjectHistoryCatalogItem,
  type LocalProjectHistoryCatalogResult,
  type LocalProjectHistoryProvider,
  type LocalProjectHistorySyncSummary,
  type LocalProjectId,
  type MachineId,
  type SessionMeta,
} from '@lody/shared';

export const MAX_VISIBLE_LOCAL_PROJECT_HISTORY_FAILURES = 3;

export function getVisibleLocalProjectHistoryFailures(
  summary: LocalProjectHistorySyncSummary,
  limit = MAX_VISIBLE_LOCAL_PROJECT_HISTORY_FAILURES
) {
  const failures = summary.failures.slice(0, Math.max(0, limit));
  return {
    failures,
    remaining: Math.max(0, summary.failures.length - failures.length),
  };
}

function buildActiveImportIndex(options: {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  provider: LocalProjectHistoryProvider;
  sessionMetas: SessionMeta[];
}): Map<string, SessionMeta> {
  const providerKey = getLocalProjectHistoryProviderKey(options.provider);
  const index = new Map<string, SessionMeta>();
  const sortedSessions = [...options.sessionMetas].sort((left, right) => {
    const leftCreatedAt = Date.parse(left.createdAt);
    const rightCreatedAt = Date.parse(right.createdAt);
    const createdAtDiff =
      (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0) -
      (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0);
    if (createdAtDiff !== 0) return createdAtDiff;
    return left.id.localeCompare(right.id);
  });

  for (const session of sortedSessions) {
    if (session.machineId !== options.machineId) continue;
    if (!matchesHistoryProviderBinding(session.agentConfigId, options.provider)) continue;
    if (session.cliType !== options.provider.cliType) continue;
    if (session.agentType !== options.provider.agentType) continue;
    if (session.project?.kind !== 'local') continue;
    if (session.project.localProjectId !== options.localProjectId) continue;
    if (!session.externalHistory) continue;
    if (getLocalProjectHistoryProviderKey(session.externalHistory.provider) !== providerKey)
      continue;

    const key = getExternalAcpHistoryImportKey({
      machineId: options.machineId,
      localProjectId: options.localProjectId,
      provider: options.provider,
      sourceAcpSessionId: session.externalHistory.sourceAcpSessionId,
    });
    if (!index.has(key)) {
      index.set(key, session);
    }
  }

  return index;
}

function reconcileCatalogItem(options: {
  item: LocalProjectHistoryCatalogItem;
  machineId: MachineId;
  localProjectId: LocalProjectId;
  provider: LocalProjectHistoryProvider;
  activeImports: Map<string, SessionMeta>;
}): LocalProjectHistoryCatalogItem {
  const key = getExternalAcpHistoryImportKey({
    machineId: options.machineId,
    localProjectId: options.localProjectId,
    provider: options.provider,
    sourceAcpSessionId: options.item.acpSessionId,
  });
  const importedSession = options.activeImports.get(key);
  if (importedSession) {
    const externalHistoryStatus = importedSession.externalHistory?.status;
    return {
      ...options.item,
      importedSessionId: importedSession.id,
      status:
        externalHistoryStatus === 'metadata_only'
          ? 'available'
          : externalHistoryStatus === 'sync_conflict'
            ? 'sync_conflict'
            : 'imported',
    };
  }

  if (
    options.item.status === 'imported' ||
    options.item.status === 'sync_conflict' ||
    options.item.importedSessionId !== undefined
  ) {
    const next: LocalProjectHistoryCatalogItem = {
      acpSessionId: options.item.acpSessionId,
      title: options.item.title,
      status: 'available',
    };
    if (options.item.updatedAt !== undefined) {
      next.updatedAt = options.item.updatedAt;
    }
    return next;
  }

  return options.item;
}

export function reconcileLocalProjectHistoryCatalog(options: {
  catalog: LocalProjectHistoryCatalogResult | null;
  machineId: MachineId;
  localProjectId: LocalProjectId;
  provider: LocalProjectHistoryProvider;
  sessionMetas: SessionMeta[];
}): LocalProjectHistoryCatalogResult | null {
  if (!options.catalog) {
    return null;
  }

  const activeImports = buildActiveImportIndex(options);
  return {
    ...options.catalog,
    sessions: options.catalog.sessions.map((item) =>
      reconcileCatalogItem({
        item,
        machineId: options.machineId,
        localProjectId: options.localProjectId,
        provider: options.provider,
        activeImports,
      })
    ),
  };
}
