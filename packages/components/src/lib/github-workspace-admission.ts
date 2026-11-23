import {
  LegacyWorkspaceAdmissionError,
  resolveLegacyWorkspaceQueryStatus,
} from './legacy-workspace-admission';

/** Exact metadata/credential operations supported by encrypted membership. PR content stays legacy. */
export const githubWorkspaceOperations: ReadonlyMap<string, 'use' | 'manage'> = new Map([
  ['github:getWorkspaceRepositories', 'use'],
  ['github:listWorkspaceReposWithStatus', 'use'],
  ['github:getPersonalOperationSettings', 'use'],
  ['github:refreshPersonalGitHubProfile', 'use'],
  ['github:setPersonalOperationPreference', 'use'],
  ['githubPersonalAuthorization:begin', 'use'],
  ['githubPersonalAuthorization:complete', 'use'],
  ['github:getAccessTokenByRepoNameForClient', 'use'],
  ['github:getOperationAccessTokenByRepoNameForClient', 'use'],
  ['github:createGitHubInstallState', 'manage'],
  ['github:removeRepoFromWorkspace', 'manage'],
  ['github:setRepoEnabled', 'manage'],
  ['github:setRepoWorktreeSetup', 'manage'],
  ['github:setRepoWorktreeCleanup', 'manage'],
]);

type AdmissionInput = Parameters<typeof resolveLegacyWorkspaceQueryStatus>[0];

export function resolveGithubWorkspaceStatus(input: AdmissionInput, manage = false) {
  const legacy = resolveLegacyWorkspaceQueryStatus(input);
  if (legacy === 'allowed') return legacy;
  const { runtime, mode, accountId, workspaceId, currentWorkspaceId, routeSlug } = input;
  if (
    !accountId ||
    !workspaceId ||
    !routeSlug ||
    workspaceId !== currentWorkspaceId ||
    runtime?.workspaceId !== workspaceId ||
    runtime.accountId !== accountId ||
    runtime.contentMode !== 'e2ee' ||
    mode?.accountId !== accountId ||
    mode.workspaceId !== workspaceId ||
    mode.workspaceSlug !== routeSlug ||
    !mode.descriptor ||
    mode.descriptor.workspaceId !== workspaceId ||
    !('contentMode' in mode.descriptor) ||
    mode.descriptor.contentMode !== 'e2ee'
  )
    return legacy;
  const role = runtime.protectedMemberRole?.get();
  if (!role) return 'pending';
  return role === 'owner' || role === 'admin' || (!manage && role === 'member')
    ? 'allowed'
    : 'blocked';
}

export function assertGithubWorkspaceAccess(input: AdmissionInput, operation: string): string {
  const access = githubWorkspaceOperations.get(operation);
  if (!access) throw new LegacyWorkspaceAdmissionError('blocked');
  const status = resolveGithubWorkspaceStatus(input, access === 'manage');
  if (status !== 'allowed') throw new LegacyWorkspaceAdmissionError(status);
  return JSON.stringify([
    input.accountId,
    input.workspaceId,
    input.routeSlug,
    input.runtime?.protectedMemberRole?.get(),
  ]);
}
