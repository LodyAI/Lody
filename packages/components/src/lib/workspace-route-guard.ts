type WorkspaceRouteLike = {
  slug?: string | null;
};

type ResolveOptimisticWorkspaceRouteGuardArgs = {
  workspaceName: string;
  organizations: WorkspaceRouteLike[] | undefined;
  activeOrganization: WorkspaceRouteLike | null | undefined;
  error?: unknown;
  serverAccessConfirmed?: boolean;
};

export type OptimisticWorkspaceRouteGuardResult =
  | 'render'
  | 'wait-for-switch'
  | 'switch-error'
  | 'redirect';

type ResolveWorkspaceAccessDeniedFallbackArgs = {
  workspaceName: string;
  organizations: WorkspaceRouteLike[] | undefined;
  activeOrganization: WorkspaceRouteLike | null | undefined;
  preferredWorkspaceSlug?: string | null;
  /** Injectable for tests; defaults to the module-level denied set. */
  deniedSlugs?: ReadonlySet<string>;
};

/**
 * Slugs the server DEFINITIVELY denied (`not_found` / `not_member`) this page
 * load. The fallback resolver must never offer a slug that was itself denied:
 * with a stale cached org list still naming A and B after the user lost access
 * to both, an A→B fallback and a B→A fallback otherwise alternate forever —
 * each hop remounting the whole workspace subtree until React's nested-update
 * limit crashes the renderer (#185). Module-level on purpose: the alternation
 * crosses route remounts, so component state cannot remember it. A direct user
 * navigation never consults this set, and a slug is cleared the moment the
 * server confirms membership again, so the worst a stale entry can do is
 * suppress one automatic fallback.
 */
const deniedWorkspaceSlugs = new Set<string>();

export const recordWorkspaceAccessDenied = (slug: string): void => {
  deniedWorkspaceSlugs.add(slug);
};

export const clearWorkspaceAccessDenied = (slug: string): void => {
  deniedWorkspaceSlugs.delete(slug);
};

export const clearAllWorkspaceAccessDeniedForTest = (): void => {
  deniedWorkspaceSlugs.clear();
};

export type WorkspaceAccessDeniedFallbackResult =
  | { kind: 'wait' }
  | { kind: 'workspace'; slug: string }
  | { kind: 'create-workspace' };

export function resolveOptimisticWorkspaceRouteGuard({
  workspaceName,
  organizations,
  activeOrganization,
  error,
  serverAccessConfirmed = false,
}: ResolveOptimisticWorkspaceRouteGuardArgs): OptimisticWorkspaceRouteGuardResult {
  if (serverAccessConfirmed) {
    return 'render';
  }

  const hasOrganizations = Array.isArray(organizations);
  const activeWorkspaceSlug = activeOrganization?.slug ?? null;

  if (hasOrganizations && organizations.length > 0) {
    const hasAccess = organizations.some((organization) => organization.slug === workspaceName);
    if (!hasAccess) {
      return 'redirect';
    }
    if (activeWorkspaceSlug && activeWorkspaceSlug !== workspaceName) {
      return error ? 'switch-error' : 'wait-for-switch';
    }
    return 'render';
  }

  if (activeWorkspaceSlug && activeWorkspaceSlug !== workspaceName) {
    return error ? 'switch-error' : 'wait-for-switch';
  }

  return 'render';
}

export function resolveWorkspaceAccessDeniedFallback({
  workspaceName,
  organizations,
  activeOrganization,
  preferredWorkspaceSlug,
  deniedSlugs = deniedWorkspaceSlugs,
}: ResolveWorkspaceAccessDeniedFallbackArgs): WorkspaceAccessDeniedFallbackResult {
  if (!Array.isArray(organizations)) {
    return { kind: 'wait' };
  }

  const fallbackSlugs = organizations
    .map((organization) => organization.slug ?? null)
    .filter(
      (slug): slug is string =>
        typeof slug === 'string' &&
        slug.length > 0 &&
        slug !== workspaceName &&
        !deniedSlugs.has(slug)
    );

  if (fallbackSlugs.length > 0) {
    if (preferredWorkspaceSlug && fallbackSlugs.includes(preferredWorkspaceSlug)) {
      return { kind: 'workspace', slug: preferredWorkspaceSlug };
    }

    const activeWorkspaceSlug = activeOrganization?.slug ?? null;
    if (activeWorkspaceSlug && fallbackSlugs.includes(activeWorkspaceSlug)) {
      return { kind: 'workspace', slug: activeWorkspaceSlug };
    }

    const firstFallbackSlug = fallbackSlugs[0];
    if (firstFallbackSlug) {
      return { kind: 'workspace', slug: firstFallbackSlug };
    }
  }

  if (organizations.length === 0) {
    return { kind: 'create-workspace' };
  }

  return { kind: 'wait' };
}
