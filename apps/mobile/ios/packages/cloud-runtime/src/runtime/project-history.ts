import type { Flock } from '@loro-dev/flock-wasm/base64';
import { projectControl } from './local-projects';
import type {
  HistoryRequest,
  HistoryResult,
  HistoryTarget,
} from '../models/project-history.ts';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export function historyTargets(
  meta: Flock,
  machines: Map<string, Flock>,
  userId: string,
): HistoryTarget[] {
  const targets: HistoryTarget[] = [];
  for (const [machineId, flock] of machines) {
    const room = `machine-${machineId}`;
    const machine = object(meta.get(['m', room]));
    const field = (key: string) => meta.get(['m', room, key]) ?? machine[key];
    if (
      !userId ||
      field('ownerUserId') !== userId ||
      field('supportsLocalProjectHistoryRpc') !== true ||
      meta.get(['e', room]) !== true
    )
      continue;
    const providers = new Map<string, HistoryTarget['provider']>();
    for (const row of flock.scan()) {
      const value = object(row.value);
      if (
        row.key[0] !== 'agentConfig' ||
        value.machineId !== machineId ||
        !['builtin', 'registry', 'custom'].includes(text(value.cliType)) ||
        !text(value.agentType)
      )
        continue;
      const provider = {
        cliType: value.cliType as HistoryTarget['provider']['cliType'],
        agentType: text(value.agentType),
      };
      providers.set(`${provider.cliType}:${provider.agentType}`, provider);
    }
    for (const row of flock.scan()) {
      const value = object(row.value),
        localProjectId = text(row.key[1]);
      if (
        row.key[0] !== 'localProject' ||
        !localProjectId ||
        !text(value.rootPath) ||
        flock.get(['cmd', 'deleteLocalProject', localProjectId]) !== undefined
      )
        continue;
      for (const provider of providers.values())
        targets.push({
          machineId,
          machineName: text(field('name')) || machineId,
          localProjectId,
          projectName: text(value.name) || localProjectId,
          rootPath: text(value.rootPath),
          provider,
        });
    }
  }
  return targets;
}

export function historyResult(
  value: Record<string, unknown>,
  kind: HistoryRequest['kind'],
): HistoryResult {
  const catalog = kind === 'sync' ? value : object(value.catalog);
  if (!Array.isArray(catalog.sessions))
    throw new Error('invalid_history_response');
  const sessions = catalog.sessions.map((item: unknown) => {
    const row = object(item);
    if (
      !text(row.acpSessionId) ||
      typeof row.title !== 'string' ||
      (row.status !== undefined &&
        !['available', 'imported', 'sync_conflict'].includes(
          text(row.status),
        )) ||
      (row.importedSessionId !== undefined && !text(row.importedSessionId)) ||
      (row.updatedAt !== undefined && typeof row.updatedAt !== 'string')
    )
      throw new Error('invalid_history_response');
    return {
      acpSessionId: text(row.acpSessionId),
      title: row.title,
      status: row.status as HistoryResult['sessions'][number]['status'],
      importedSessionId: row.importedSessionId as string | undefined,
      updatedAt: row.updatedAt as string | undefined,
    };
  });
  if (new Set(sessions.map((row) => row.acpSessionId)).size !== sessions.length)
    throw new Error('invalid_history_response');
  let failures: HistoryResult['failures'];
  if (kind === 'import') {
    const summary = object(value.summary);
    if (
      !Array.isArray(summary.failures) ||
      typeof summary.failed !== 'number' ||
      summary.failed !== summary.failures.length
    )
      throw new Error('invalid_history_response');
    failures = summary.failures.map((item: unknown) => {
      const row = object(item);
      if (!text(row.acpSessionId) || typeof row.message !== 'string')
        throw new Error('invalid_history_response');
      return { acpSessionId: text(row.acpSessionId), message: row.message };
    });
  }
  if (kind === 'resolve' && value.status !== 'resolved')
    throw new Error('invalid_history_response');
  return { sessions, failures };
}

export async function projectHistory(
  request: HistoryRequest,
  workspaceId: string,
  userId: string,
  meta: Flock,
  machines: Map<string, Flock>,
  grant: Parameters<typeof projectControl>[3],
  signal: AbortSignal,
) {
  const targets = historyTargets(meta, machines, userId);
  if (request.kind === 'targets') return targets;
  const target = targets.find(
    (item) =>
      item.machineId === request.target?.machineId &&
      item.localProjectId === request.target.localProjectId &&
      item.provider.cliType === request.target.provider?.cliType &&
      item.provider.agentType === request.target.provider.agentType,
  );
  if (!target) throw new Error('history_unavailable');
  const types = {
    sync: 'local-project/sync-history',
    import: 'local-project/import-history',
    resolve: 'local-project/resolve-history-conflict',
  };
  if (!(request.kind in types)) throw new Error('invalid_history_request');
  const payload: Record<string, unknown> = {
    type: types[request.kind],
    localProjectId: target.localProjectId,
    provider: target.provider,
    requestedByUserId: userId,
  };
  if (request.kind === 'import') {
    if (
      !Array.isArray(request.acpSessionIds) ||
      !request.acpSessionIds.length ||
      request.acpSessionIds.length > 5 ||
      request.acpSessionIds.some((id) => !text(id))
    )
      throw new Error('invalid_history_request');
    payload.acpSessionIds = [...new Set(request.acpSessionIds)];
  }
  if (request.kind === 'resolve') {
    if (!text(request.sessionId) || !text(request.acpSessionId))
      throw new Error('invalid_history_request');
    payload.sessionId = request.sessionId;
    payload.acpSessionId = request.acpSessionId;
  }
  return historyResult(
    await projectControl(workspaceId, target.machineId, payload, grant, signal),
    request.kind,
  );
}
