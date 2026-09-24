import type { PromptShortcutIndexEntry } from '@lody/shared/prompt-shortcuts';

/**
 * Narrowest scope axis a Prompt Shortcut is pinned to. Enum only: the
 * repository, project id, machine id, and provider key never leave the client.
 */
export type PromptShortcutAnalyticsScope =
  | 'workspace'
  | 'github_project'
  | 'local_project'
  | 'machine'
  | 'provider';

/**
 * Shortcuts have no template variables; their only structured parts are the
 * frozen references (`mentions`), so `reference_count` is reported instead.
 */
export function getPromptShortcutAnalyticsProperties(
  shortcut: Pick<PromptShortcutIndexEntry, 'scope' | 'visibility'>,
  referenceCount: number
): Record<string, unknown> {
  const { project, machineId, providerKey } = shortcut.scope;
  const scope: PromptShortcutAnalyticsScope = project
    ? project.kind === 'github'
      ? 'github_project'
      : 'local_project'
    : machineId !== undefined
      ? 'machine'
      : providerKey !== undefined
        ? 'provider'
        : 'workspace';
  return {
    scope,
    scope_axis_count: [project, machineId, providerKey].filter((axis) => axis !== undefined).length,
    is_shared: shortcut.visibility === 'workspace',
    reference_count: referenceCount,
  };
}
