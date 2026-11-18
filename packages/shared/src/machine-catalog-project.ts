import { getLocalProjectHistoryCatalogKey } from './project';
import { machineFlockKeys, parseMachineFlockRow } from './machine-flock';
import {
  MachineCatalogError,
  type MachineCatalogProjectEdit,
  type MachineCatalogProjectSummary,
} from './machine-catalog';
import type { LocalProjectId, LocalProjectMeta } from './project';

const summary = (project: LocalProjectMeta): MachineCatalogProjectSummary => ({
  id: project.id,
  name: project.name,
  rootPath: project.rootPath,
  createdAtMs: project.createdAtMs,
  ...(project.lastOpenedAtMs === undefined ? {} : { lastOpenedAtMs: project.lastOpenedAtMs }),
  ...(project.githubRepoFullName === undefined
    ? {}
    : { githubRepoFullName: project.githubRepoFullName }),
  ...(project.standaloneVisible === undefined
    ? {}
    : { standaloneVisible: project.standaloneVisible }),
});
const stored = (id: LocalProjectId, value: unknown) => {
  const row = parseMachineFlockRow(machineFlockKeys.localProject(id), value);
  if (!row || row.key[0] !== 'localProject') throw new MachineCatalogError('not_found');
  return row.value as LocalProjectMeta;
};
/** Registration deduplicates by the daemon-validated project identity. Existing
 * names, root paths, history and future fields remain owned by that row. */
export function planLocalProjectEnsure(current: unknown, proposed: LocalProjectMeta) {
  const project = stored(proposed.id, current === undefined ? proposed : current);
  return {
    project: summary(project),
    ...(current === undefined ? { value: proposed as unknown as Record<string, unknown> } : {}),
  };
}
export function planLocalProjectEdit(
  current: unknown,
  id: LocalProjectId,
  changes: MachineCatalogProjectEdit
) {
  const project = stored(id, current);
  let changed = false;
  const next = { ...(current as Record<string, unknown>) };
  if (
    changes.standaloneVisible !== undefined &&
    (project.standaloneVisible !== false) !== changes.standaloneVisible
  ) {
    next.standaloneVisible = changes.standaloneVisible;
    changed = true;
  }
  if (changes.githubRepoFullName) {
    const desired =
      changes.githubRepoFullName.kind === 'clear' ? undefined : changes.githubRepoFullName.value;
    if (desired !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(desired))
      throw new MachineCatalogError('invalid_edit');
    if (project.githubRepoFullName !== desired) {
      if (desired === undefined) delete next.githubRepoFullName;
      else next.githubRepoFullName = desired;
      changed = true;
    }
  }
  return { project: summary(stored(id, next)), ...(changed ? { value: next } : {}) };
}

/** Clearing an imported Session association never exposes or replaces its private
 * history catalog. Compare the exact owning Session and preserve future fields. */
export function planLocalProjectHistoryInvalidation(
  current: unknown,
  input: {
    projectId: LocalProjectId;
    provider: import('./project').LocalProjectHistoryProvider;
    sourceAcpSessionId: string;
    importedSessionId: import('./ids').SessionId;
  }
) {
  if (current === undefined) return {};
  const project = stored(input.projectId, current);
  const key = getLocalProjectHistoryCatalogKey(input.provider);
  const catalog = project.history?.[key];
  const item = catalog?.sessions?.[input.sourceAcpSessionId];
  if (
    !catalog ||
    !item ||
    (item.importedSessionId && item.importedSessionId !== input.importedSessionId)
  )
    return {};
  if (item.status === 'available' && item.importedSessionId === undefined) return {};
  if (item.acpSessionId !== input.sourceAcpSessionId || typeof item.title !== 'string') return {};
  const next = { ...item, status: 'available' as const };
  delete next.importedSessionId;
  return {
    value: {
      ...(current as Record<string, unknown>),
      history: {
        ...project.history,
        [key]: { ...catalog, sessions: { ...catalog.sessions, [input.sourceAcpSessionId]: next } },
      },
    },
  };
}
