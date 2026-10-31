import type { WorkspacesState } from '@lody/platform';
import type { WorkspaceContentMode } from '../atoms/workspace-content-mode';
import type { WorkspaceRuntime } from '../atoms/runtime';

export type LegacyWorkspaceQueryStatus = 'pending' | 'allowed' | 'blocked';

/** The renderer admission publication is the only positive legacy-mode verdict. */
export function resolveLegacyWorkspaceQueryStatus({
  workspaceId,
  platformKind,
  mode,
  runtime,
  accountId,
  currentWorkspaceId,
  routeSlug,
  workspacesState,
}: {
  workspaceId: string | null | undefined;
  platformKind: string;
  mode: WorkspaceContentMode | null;
  runtime: WorkspaceRuntime | null;
  accountId: string | null;
  currentWorkspaceId: string | null;
  routeSlug: string | null;
  workspacesState: WorkspacesState;
}): LegacyWorkspaceQueryStatus {
  if (platformKind === 'local') return 'allowed';
  if (!workspaceId) return 'pending';
  if (
    (mode?.workspaceId === workspaceId &&
      mode.descriptor &&
      'contentMode' in mode.descriptor &&
      mode.descriptor.contentMode === 'e2ee') ||
    (runtime?.workspaceId === workspaceId && runtime.contentMode === 'e2ee') ||
    (workspacesState.status === 'ready' &&
      workspacesState.workspaces.some(
        (workspace) => workspace.id === workspaceId && workspace.contentMode === 'e2ee'
      ))
  )
    return 'blocked';
  if (
    !accountId ||
    !routeSlug ||
    currentWorkspaceId !== workspaceId ||
    mode?.accountId !== accountId ||
    mode.workspaceSlug !== routeSlug ||
    mode.workspaceId !== workspaceId ||
    mode.descriptor?.workspaceId !== workspaceId
  )
    return 'pending';
  const descriptor = mode.descriptor;
  return ('contentMode' in descriptor &&
    descriptor.contentMode === 'plaintext' &&
    descriptor.contentModeVersion === 1) ||
    ('admission' in descriptor && descriptor.admission === 'legacy-unclassified')
    ? 'allowed'
    : 'pending';
}

export function assertLegacyWorkspaceAccess(
  input: Parameters<typeof resolveLegacyWorkspaceQueryStatus>[0]
): string {
  const status = resolveLegacyWorkspaceQueryStatus(input);
  if (status !== 'allowed') throw new LegacyWorkspaceAdmissionError(status);
  return JSON.stringify([input.accountId, input.workspaceId, input.routeSlug]);
}

export class LegacyWorkspaceAdmissionError extends Error {
  readonly code: string;
  constructor(status: LegacyWorkspaceQueryStatus | 'account_changed' | 'changed') {
    super(
      status === 'pending'
        ? 'Workspace access is still being verified. Please try again.'
        : 'This operation is unavailable for the current workspace or account.'
    );
    this.name = 'LegacyWorkspaceAdmissionError';
    this.code = `legacy_workspace_admission_${status}`;
  }
}
