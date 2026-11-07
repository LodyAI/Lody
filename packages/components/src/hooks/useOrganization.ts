import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { recordBootRequestResult } from '@/lib/boot-request-failures';
import {
  clearPreferredWorkspaceSlugIfMatch,
  generateWorkspaceSlug,
  isUsableWorkspaceSlug,
  normalizeWorkspaceSlug,
} from '@/lib/workspace';
import {
  cacheWorkspaceInfo,
  clearCachedWorkspaceInfo,
  getCachedWorkspaceId,
} from '@/lib/local-storage-cache';
import { atom, useAtom, useSetAtom, useStore } from 'jotai';
import { useOptionalCloudPlatformQuery } from '../providers/cloud-platform-api';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  clearSessionRunConfigDraftsAtom,
  sessionRunConfigDraftAccountAtom,
} from '@/atoms/session-run-config-drafts';
import {
  setWorkspaceContextAtRevisionAtom,
  setWorkspaceContextAtom,
  workspaceContextSnapshotAtom,
} from '@/atoms';
import { WorkspaceId } from '@lody/shared';
import { useStableSession } from '@/hooks/useStableSession';
import { useAuthClient } from '../providers/convex-provider';
import { resolveWorkspaceRemovalTransition } from '@/lib/workspace-removal-transition';
import type { LodyAuthClient } from '@/lib/auth';
import type { PlatformUser, WorkspaceSummary } from '@lody/platform';
import { usePlatformSession } from '@lody/platform/react';
import { isLocalAppPlatform } from '@/lib/app-platform';
import { useImplicitLocalWorkspace } from '../providers/local-platform-provider';

type UseOrganizationOptions = {
  targetSlug?: string;
};

const selectedEncryptedWorkspaceAtom = atom<{ accountId: string; id: string } | null>(null);

const inFlightSetActiveRequests = new Map<string, Promise<void>>();
let completedUnobservedSetActiveRequestKey: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function getSetActiveRequestKey(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

function getResponseErrorMessage(response: unknown): string | null {
  if (!isRecord(response) || !('error' in response) || response.error == null) {
    return null;
  }

  const error = response.error;
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Failed to switch organization';
}

/** Spacing of the single retries a spent organization-list retry burst still gets. */
export const ORGANIZATIONS_SLOW_RETRY_MS = 30_000;

async function setActiveOrganizationOnce(
  authClient: LodyAuthClient,
  userId: string,
  organizationId: string
): Promise<void> {
  const requestKey = getSetActiveRequestKey(userId, organizationId);

  if (completedUnobservedSetActiveRequestKey === requestKey) {
    return;
  }

  const inFlightRequest = inFlightSetActiveRequests.get(requestKey);
  if (inFlightRequest) {
    await inFlightRequest;
    return;
  }

  completedUnobservedSetActiveRequestKey = null;

  const request = (async () => {
    const response = await authClient.organization.setActive({
      organizationId,
    });
    const errorMessage = getResponseErrorMessage(response);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    completedUnobservedSetActiveRequestKey = requestKey;
  })();

  inFlightSetActiveRequests.set(requestKey, request);

  try {
    await request;
  } finally {
    inFlightSetActiveRequests.delete(requestKey);
  }
}

/**
 * Organization/workspace state adapter for better-auth + Jotai.
 *
 * Key semantics:
 * - `organizations === undefined` means "not ready": session not available, first load in-flight,
 *   or a transient cross-domain instability window.
 * - `organizations === []` means "ready and empty": the user truly has zero organizations.
 * - `loading` is a coarse flag for "do not render org-list-dependent UI yet" and includes mutations.
 *   It does NOT wait for `activeOrganization` to become non-null, because some routes only need the list.
 *
 * Why retries exist:
 * With better-auth + crossDomain, right after OAuth callback we can briefly observe:
 *   `organizationsError !== null` AND `organizations === []`
 * before the session/org context stabilizes. Treating `[]` as authoritative in that window causes
 * incorrect routing (e.g. forcing workspace creation). We normalize that intermediate state back to
 * `undefined` and retry a few times.
 */
export function useOrganization(options?: UseOrganizationOptions) {
  // The platform kind is a build-time constant (`isLocalAppPlatform`), so
  // exactly one branch exists for the whole app lifetime and hook order is
  // stable. The local branch must never touch Better Auth: it would issue
  // cloud HTTP from a build that promised zero cloud I/O.
  if (isLocalAppPlatform()) {
    // oxlint-disable-next-line rules-of-hooks
    return useLocalOrganizationState();
  }
  // oxlint-disable-next-line rules-of-hooks
  return useCloudOrganizationState(options);
}

type UseOrganizationResult = ReturnType<typeof useCloudOrganizationState>;
type ActiveOrganizationValue = NonNullable<UseOrganizationResult['activeOrganization']>;

const LOCAL_ORGANIZATION_EPOCH = new Date(0);

/**
 * Projects the implicit local workspace (D-O14) into the cloud organization
 * shape so shared consumers (sidebar, settings, tasks) keep working unchanged.
 */
function buildLocalActiveOrganization(
  workspace: WorkspaceSummary,
  user: PlatformUser
): ActiveOrganizationValue {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug ?? workspace.id,
    logo: null,
    createdAt: LOCAL_ORGANIZATION_EPOCH,
    metadata: null,
    members: [
      {
        id: `${workspace.id}:local-member`,
        organizationId: workspace.id,
        userId: user.id,
        role: workspace.role,
        createdAt: LOCAL_ORGANIZATION_EPOCH,
        user: {
          id: user.id,
          name: user.name ?? 'Local',
          email: 'local@lody.local',
        },
      },
    ],
    invitations: [],
  } as unknown as ActiveOrganizationValue;
}

const rejectLocalWorkspaceMutation = () =>
  Promise.reject(new Error('Workspace management is not available on the local platform'));

function useLocalOrganizationState(): UseOrganizationResult {
  const workspace = useImplicitLocalWorkspace();
  const session = usePlatformSession();
  return useMemo(() => {
    const user = session.status === 'authenticated' ? session.user : null;
    const activeOrganization =
      workspace && user ? buildLocalActiveOrganization(workspace, user) : null;
    const loading = activeOrganization === null;
    return {
      organizations: activeOrganization ? [activeOrganization] : undefined,
      organizationsLoading: loading,
      activeOrganizationLoading: loading,
      refetchOrganizations: () => Promise.resolve(),
      refetchActiveOrganization: () => Promise.resolve(),
      role: workspace?.role,
      hasAdminPermission: true,
      loading,
      organizationsError: null,
      error: null,
      activeOrganization,
      activateOrganization: () => Promise.resolve(),
      switchOrganization: () => Promise.resolve(),
      createOrganization: rejectLocalWorkspaceMutation,
      updateOrganization: rejectLocalWorkspaceMutation,
      deleteOrganization: rejectLocalWorkspaceMutation,
      leaveOrganization: rejectLocalWorkspaceMutation,
    } as unknown as UseOrganizationResult;
  }, [session, workspace]);
}

function useCloudOrganizationState(options?: UseOrganizationOptions) {
  const authClient = useAuthClient();
  const targetSlug = options?.targetSlug;
  const [isMutating, setIsMutating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const mutationErrorObject = useMemo(() => {
    return mutationError ? new Error(mutationError) : null;
  }, [mutationError]);

  const {
    data: session,
    isPending: sessionPending,
    isRetrying: sessionRetrying,
    error: sessionError,
  } = useStableSession();
  const user = session?.user ?? null;
  const {
    data: ordinaryOrganizations,
    isPending: ordinaryOrganizationsPending,
    error: organizationsError,
    refetch: refetchOrganizations,
  } = authClient.useListOrganizations();
  const {
    data: ordinaryActiveOrganization,
    isPending: activeOrganizationIsPending,
    refetch: refetchActiveOrganization,
    error: activeOrganizationQueryError,
  } = authClient.useActiveOrganization();

  const encryptedDirectory = useOptionalCloudPlatformQuery(
    cloudOperations.e2eeMembers.workspaces,
    user ? {} : 'skip'
  );
  const retainedDirectory = useRef<{
    accountId: string;
    items: typeof encryptedDirectory.data;
  } | null>(null);
  if (retainedDirectory.current?.accountId !== user?.id) retainedDirectory.current = null;
  if (user && encryptedDirectory.data !== undefined)
    retainedDirectory.current = { accountId: user.id, items: encryptedDirectory.data };
  // Navigation labels may survive an outage; native credentials/ledger still decide access.
  const encryptedWorkspaces = encryptedDirectory.data ?? retainedDirectory.current?.items;
  const [selectedEncryptedWorkspace, setSelectedEncryptedWorkspace] = useAtom(
    selectedEncryptedWorkspaceAtom
  );
  const encryptedOrganizations = useMemo(
    () =>
      encryptedWorkspaces?.map((workspace) => ({
        ...workspace,
        logo: null,
        createdAt: LOCAL_ORGANIZATION_EPOCH,
        metadata: null,
        members: workspace.members.map((member) => ({
          ...member,
          organizationId: workspace.id,
          createdAt: LOCAL_ORGANIZATION_EPOCH,
        })),
        invitations: [],
      })),
    [encryptedWorkspaces]
  );
  const organizationsRaw = useMemo(() => {
    if (!ordinaryOrganizations) return ordinaryOrganizations;
    const encryptedIds = new Set(encryptedOrganizations?.map((workspace) => workspace.id));
    return [
      ...ordinaryOrganizations.filter((workspace) => !encryptedIds.has(workspace.id)),
      ...(encryptedOrganizations ?? []),
    ];
  }, [ordinaryOrganizations, encryptedOrganizations]);
  const directoryNeeded =
    Boolean(user) &&
    (targetSlug
      ? !ordinaryOrganizations?.some(
          (workspace) =>
            workspace.slug === targetSlug &&
            !('contentMode' in workspace && workspace.contentMode === 'e2ee')
        )
      : selectedEncryptedWorkspace?.accountId === user?.id || ordinaryOrganizations?.length === 0);
  const directoryError =
    directoryNeeded && encryptedWorkspaces === undefined ? encryptedDirectory.error : null;
  const organizationsPending =
    ordinaryOrganizationsPending ||
    (ordinaryOrganizations?.length === 0 && encryptedWorkspaces === undefined && !directoryError);
  const selectedEncryptedId =
    selectedEncryptedWorkspace?.accountId === user?.id ? selectedEncryptedWorkspace?.id : null;
  const encryptedActive = encryptedOrganizations?.find((workspace) =>
    targetSlug
      ? workspace.slug === targetSlug
      : workspace.id === (selectedEncryptedId ?? ordinaryActiveOrganization?.id)
  );
  // This roster comes from current ledger projections and the account directory.
  // It is navigation/display metadata; native device authorization stays separate.
  const activeOrganization = encryptedActive ?? ordinaryActiveOrganization;
  useEffect(() => {
    if (user && targetSlug && encryptedActive && selectedEncryptedId !== encryptedActive.id)
      setSelectedEncryptedWorkspace({ accountId: user.id, id: encryptedActive.id });
    else if (
      user &&
      targetSlug &&
      !encryptedActive &&
      ordinaryActiveOrganization?.slug === targetSlug &&
      !(
        'contentMode' in ordinaryActiveOrganization &&
        ordinaryActiveOrganization.contentMode === 'e2ee'
      ) &&
      Array.isArray(ordinaryActiveOrganization.members) &&
      selectedEncryptedId
    )
      setSelectedEncryptedWorkspace(null);
  }, [
    encryptedActive,
    ordinaryActiveOrganization,
    selectedEncryptedId,
    setSelectedEncryptedWorkspace,
    targetSlug,
    user,
  ]);

  // A partial response is not a full organization. Keep membership-dependent
  // consumers gated and expose a retryable error instead of inventing an empty roster.
  const activeOrganizationDataError = useMemo(
    () =>
      activeOrganization && !Array.isArray(activeOrganization.members)
        ? new Error('Incomplete organization response: members are missing')
        : null,
    [activeOrganization]
  );
  const activeOrganizationMatchesTarget = !targetSlug || activeOrganization?.slug === targetSlug;
  const activeOrganizationError =
    activeOrganizationQueryError ??
    (activeOrganizationMatchesTarget ? activeOrganizationDataError : null);
  useEffect(() => {
    recordBootRequestResult('organizations', organizationsError);
  }, [organizationsError]);
  useEffect(() => {
    recordBootRequestResult('active_organization', activeOrganizationQueryError);
  }, [activeOrganizationQueryError]);

  const setWorkspaceContext = useSetAtom(setWorkspaceContextAtom);
  const setWorkspaceContextAtRevision = useSetAtom(setWorkspaceContextAtRevisionAtom);
  const workspaceContextStore = useStore();

  const organizationsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [organizationsRetryCount, setOrganizationsRetryCount] = useState(0);
  const maxOrganizationsRetries = 5;
  const retryBaseMs = 400;
  const retryMaxMs = 4000;

  const organizationsLooksEmpty = useMemo(() => {
    if (!user) return true;
    if (organizationsRaw == null) return true;
    return Array.isArray(organizationsRaw) && organizationsRaw.length === 0;
  }, [organizationsRaw, user]);

  useEffect(() => {
    if (organizationsRetryTimerRef.current) {
      clearTimeout(organizationsRetryTimerRef.current);
      organizationsRetryTimerRef.current = null;
    }
    setOrganizationsRetryCount(0);
  }, [user?.id]);

  const shouldRetryOrganizations =
    Boolean(user) &&
    Boolean(organizationsError) &&
    !organizationsPending &&
    organizationsLooksEmpty &&
    organizationsRetryCount < maxOrganizationsRetries;

  const shouldKickOrganizations =
    Boolean(user) &&
    organizationsRaw == null &&
    !organizationsPending &&
    !organizationsError &&
    organizationsRetryCount < maxOrganizationsRetries;

  // For new users, the workspace auto-creation trigger may not have completed yet.
  // Retry a few times when organizations list is empty to allow the trigger to finish.
  const shouldRetryEmptyOrganizations =
    Boolean(user) &&
    Array.isArray(organizationsRaw) &&
    organizationsRaw.length === 0 &&
    !organizationsPending &&
    !organizationsError &&
    organizationsRetryCount < maxOrganizationsRetries;

  const shouldRefetchOrganizations =
    shouldRetryOrganizations || shouldKickOrganizations || shouldRetryEmptyOrganizations;

  useEffect(() => {
    if (!shouldRefetchOrganizations) {
      if (organizationsRetryTimerRef.current) {
        clearTimeout(organizationsRetryTimerRef.current);
        organizationsRetryTimerRef.current = null;
      }
      return undefined;
    }
    if (organizationsRetryTimerRef.current) {
      return undefined;
    }

    // No delay for initial kick, but add delay for empty organizations retry
    // to give the auto-create trigger time to complete
    const delayMs = shouldKickOrganizations
      ? 0
      : shouldRetryEmptyOrganizations
        ? Math.min(retryBaseMs * 2 ** (organizationsRetryCount + 1), retryMaxMs) // Start with longer delay for empty
        : Math.min(retryBaseMs * 2 ** organizationsRetryCount, retryMaxMs);

    organizationsRetryTimerRef.current = setTimeout(() => {
      organizationsRetryTimerRef.current = null;
      setOrganizationsRetryCount((prev) => prev + 1);
      void refetchOrganizations();
    }, delayMs);

    return () => {
      if (organizationsRetryTimerRef.current) {
        clearTimeout(organizationsRetryTimerRef.current);
        organizationsRetryTimerRef.current = null;
      }
    };
  }, [
    organizationsRetryCount,
    refetchOrganizations,
    retryBaseMs,
    retryMaxMs,
    shouldKickOrganizations,
    shouldRefetchOrganizations,
    shouldRetryEmptyOrganizations,
  ]);

  const organizationsErrorFinal =
    Boolean(user) &&
    Boolean(organizationsError) &&
    !organizationsPending &&
    organizationsLooksEmpty &&
    organizationsRetryCount >= maxOrganizationsRetries;

  const organizationsIdleFinal =
    Boolean(user) &&
    organizationsRaw == null &&
    !organizationsPending &&
    !organizationsError &&
    organizationsRetryCount >= maxOrganizationsRetries;

  const organizationsFailureFinal =
    organizationsErrorFinal || organizationsIdleFinal || Boolean(directoryError);

  // A failed list must not stay failed for the life of the page: with no cached
  // workspace id, the route has nothing else to open with. After the retry burst
  // is spent, allow one more attempt when the network returns, when the app
  // comes back to the foreground (a phone resuming after a long absence often
  // fails its first requests), and every `ORGANIZATIONS_SLOW_RETRY_MS` while
  // visible. A hidden page does not poll: coming back to it retries at once.
  useEffect(() => {
    if (!organizationsFailureFinal || typeof window === 'undefined') return undefined;
    const retryOnce = () => setOrganizationsRetryCount(maxOrganizationsRetries - 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimer = () => {
      clearTimeout(timer);
      timer =
        document.visibilityState === 'hidden'
          ? undefined
          : setTimeout(retryOnce, ORGANIZATIONS_SLOW_RETRY_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') retryOnce();
      else armTimer();
    };
    armTimer();
    window.addEventListener('online', retryOnce);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', retryOnce);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [maxOrganizationsRetries, organizationsFailureFinal]);

  const organizations = useMemo(() => {
    if (!user) return undefined;
    if (organizationsPending) return undefined;
    if (shouldRefetchOrganizations) return undefined;
    // Keep `undefined` on final error; callers should branch on `error`.
    if (organizationsFailureFinal) return undefined;
    return organizationsRaw ?? undefined;
  }, [
    organizationsFailureFinal,
    organizationsPending,
    organizationsRaw,
    shouldRefetchOrganizations,
    user,
  ]);

  const organizationsLoading =
    Boolean(user) && organizations === undefined && !organizationsFailureFinal;

  // Cache all workspace slug->id+name mappings for offline-first runtime init and faster workspace switching.
  useEffect(() => {
    if (!Array.isArray(organizations)) {
      return;
    }
    for (const organization of organizations) {
      const slug = typeof organization.slug === 'string' ? organization.slug : null;
      const name = typeof organization.name === 'string' ? organization.name : null;
      if (!slug || !name) {
        continue;
      }
      cacheWorkspaceInfo(slug, organization.id, name);
    }
  }, [organizations]);

  const activeOrganizationInList = useMemo(() => {
    if (!activeOrganization) return false;
    if (targetSlug && activeOrganization.slug === targetSlug) return true;
    if (organizations === undefined) return true;
    return organizations.some((org) => org.id === activeOrganization.id);
  }, [activeOrganization, organizations, targetSlug]);

  // If the active org was deleted/left, or still points at a previous workspace while a target
  // route is opening, treat it as unavailable to avoid reusing a stale workspace.
  const resolvedActiveOrganization =
    activeOrganizationInList && activeOrganizationMatchesTarget && !activeOrganizationDataError
      ? activeOrganization
      : null;

  const role = useMemo(() => {
    return resolvedActiveOrganization?.members.find((member) => member.userId === user?.id)?.role;
  }, [resolvedActiveOrganization, user?.id]);

  // `activeOrganization` can be null even when `organizations` is ready (e.g. no active org yet,
  // or we are about to call `setActive`). Expose a dedicated loading flag for active-org-dependent UI.
  const activeOrganizationLoading =
    Boolean(user) &&
    organizations !== undefined &&
    organizations.length > 0 &&
    (activeOrganizationIsPending || !resolvedActiveOrganization);
  // While the list is still loading, an active-organization failure is not
  // final: right after sign-in Better Auth can answer that query before the new
  // session settles, and it only refetches on `setActive`, which the activation
  // effect below issues once the list arrives. Surfacing it earlier turns the
  // first-login wait into a failed-list screen.
  const shouldSurfaceActiveOrganizationError =
    Boolean(activeOrganizationError) &&
    !activeOrganizationIsPending &&
    organizations !== undefined &&
    organizations.length > 0 &&
    !resolvedActiveOrganization;
  const organizationsListError = organizationsFailureFinal
    ? (organizationsError ??
      (directoryError
        ? new Error('Encrypted membership directory is unavailable')
        : new Error('Failed to load organizations')))
    : null;
  const optimisticWorkspaceId = useMemo(() => {
    if (!user || !targetSlug) {
      return null;
    }
    // If the org list has loaded and the targetSlug is not in it, the user
    // does not (or no longer) belongs to this workspace. Returning a stale
    // cached id here drives currentWorkspaceIdAtom and triggers authed Convex
    // queries (e.g. listVisibleMachines) against a workspace the user has no
    // access to, which throws "Forbidden: not a workspace member" before the
    // route guard can redirect.
    if (Array.isArray(organizations) && !organizations.some((org) => org.slug === targetSlug)) {
      return null;
    }
    const cachedWorkspaceId = getCachedWorkspaceId(targetSlug);
    return cachedWorkspaceId ? (cachedWorkspaceId as WorkspaceId) : null;
  }, [organizations, targetSlug, user]);

  const switchOrganizationOrThrow = useCallback(
    async (organizationId: string) => {
      if (!user?.id) {
        throw new Error('User not available');
      }
      const currentWorkspaceId = resolvedActiveOrganization?.id as WorkspaceId | undefined;
      if (currentWorkspaceId === organizationId) {
        return;
      }
      if (encryptedOrganizations?.some((workspace) => workspace.id === organizationId)) {
        setSelectedEncryptedWorkspace({ accountId: user.id, id: organizationId });
        return;
      }
      await setActiveOrganizationOnce(authClient, user.id, organizationId);
      setSelectedEncryptedWorkspace(null);
    },
    [
      authClient,
      encryptedOrganizations,
      resolvedActiveOrganization?.id,
      setSelectedEncryptedWorkspace,
      user?.id,
    ]
  );

  /** Switch active organization and surface failure to callers that must await it. */
  const activateOrganization = useCallback(
    async (organizationId: string) => {
      try {
        await switchOrganizationOrThrow(organizationId);
        setMutationError(null);
        recordBootRequestResult('switch_organization', null);
      } catch (err) {
        setMutationError('Failed to switch organization');
        recordBootRequestResult('switch_organization', err);
        throw err;
      }
    },
    [switchOrganizationOrThrow]
  );

  /** Best-effort compatibility path for UI that reports failure through hook state. */
  const switchOrganization = useCallback(
    async (organizationId: string) => {
      try {
        await activateOrganization(organizationId);
      } catch (err) {
        console.error('Failed to switch organization:', err);
      }
    },
    [activateOrganization]
  );

  useEffect(() => {
    if (user?.id && activeOrganization?.id) {
      const observedRequestKey = getSetActiveRequestKey(user.id, activeOrganization.id);
      if (completedUnobservedSetActiveRequestKey === observedRequestKey) {
        completedUnobservedSetActiveRequestKey = null;
      }
    }

    // Only the route-scoped hook instance may publish render identity. Generic
    // consumers (for example the sidebar) can briefly observe the previous
    // Better Auth organization while a new URL target is already active.
    if (!targetSlug) return;

    if (resolvedActiveOrganization?.slug === targetSlug) {
      setWorkspaceContext({
        slug: targetSlug,
        workspaceId: resolvedActiveOrganization.id as WorkspaceId,
      });
      return;
    }
    if (optimisticWorkspaceId) {
      setWorkspaceContext({ slug: targetSlug, workspaceId: optimisticWorkspaceId });
    }
  }, [
    activeOrganization?.id,
    optimisticWorkspaceId,
    resolvedActiveOrganization,
    setWorkspaceContext,
    targetSlug,
    user?.id,
  ]);

  useEffect(() => {
    if (!user) return;
    if (organizations === undefined) return;
    if (organizations.length === 0) return;
    if (activeOrganizationIsPending) return;

    if (targetSlug) {
      const targetOrganization = organizations.find((org) => org.slug === targetSlug);
      if (!targetOrganization) {
        return;
      }
      if (activeOrganizationDataError && activeOrganization?.id === targetOrganization.id) return;
      if (resolvedActiveOrganization?.id !== targetOrganization.id) {
        void switchOrganization(targetOrganization.id);
      }
      return;
    }

    if (!resolvedActiveOrganization && !activeOrganizationDataError) {
      const first = organizations[0];
      if (first) {
        void switchOrganization(first.id);
      }
    }
  }, [
    activeOrganization?.id,
    activeOrganizationDataError,
    activeOrganizationIsPending,
    organizations,
    resolvedActiveOrganization,
    switchOrganization,
    targetSlug,
    user,
  ]);

  /**
   * Create a new organization and bootstrap the corresponding local workspace.
   */
  const createOrganization = useCallback(
    async (name: string, slug?: string) => {
      if (!user) {
        throw new Error('User not available');
      }
      setIsMutating(true);
      setMutationError(null);
      try {
        const normalizedSlug = slug ? normalizeWorkspaceSlug(slug) : '';
        if (normalizedSlug && !isUsableWorkspaceSlug(normalizedSlug)) {
          throw new Error('Workspace slug is not available');
        }
        const generatedSlug = generateWorkspaceSlug(name);
        const fallbackSlug = isUsableWorkspaceSlug(generatedSlug)
          ? generatedSlug
          : `workspace-${Date.now()}`;
        const { data, error } = await authClient.organization.create({
          name,
          slug: normalizedSlug || fallbackSlug,
        });
        if (data) {
          await switchOrganizationOrThrow(data.id);
        }
        if (error) {
          setMutationError(error.message || 'Failed to create organization');
          throw error;
        }
        return data;
      } catch (err) {
        console.error('Failed to create organization:', err);
        setMutationError('Failed to create organization');
        throw err;
      } finally {
        setIsMutating(false);
      }
    },
    [authClient, switchOrganizationOrThrow, user]
  );

  /**
   * Update organization metadata.
   */
  const updateOrganization = useCallback(
    async (organizationId: string, data: { name?: string; slug?: string; logo?: string }) => {
      setMutationError(null);
      try {
        const { data: updatedOrganization, error } = await authClient.organization.update({
          organizationId,
          data,
        });
        if (error) {
          setMutationError(error.message || 'Failed to update organization');
          throw error;
        }
        if (updatedOrganization?.slug && updatedOrganization.name) {
          cacheWorkspaceInfo(
            updatedOrganization.slug,
            updatedOrganization.id,
            updatedOrganization.name
          );
        }
        void refetchOrganizations();
        void refetchActiveOrganization();
        return updatedOrganization;
      } catch (err) {
        console.error('Failed to update organization:', err);
        setMutationError('Failed to update organization');
        throw err;
      }
    },
    [authClient, refetchActiveOrganization, refetchOrganizations]
  );

  /**
   * Delete organization (owner only).
   */
  const deleteOrganization = useCallback(
    async (organizationId: string) => {
      const draftOwner = workspaceContextStore.get(sessionRunConfigDraftAccountAtom);
      setIsMutating(true);
      setMutationError(null);
      const removalTransition = resolveWorkspaceRemovalTransition({
        organizationId,
        organizations,
        activeOrganization: resolvedActiveOrganization,
      });
      let didDelete = false;
      let transitionRevision: number | null = null;
      // Clear before the server removes membership so workspace-scoped Convex
      // subscriptions skip immediately; otherwise listVisibleMachines can run
      // with the just-deleted workspace id and throw a 403 during redirect.
      if (removalTransition.isActiveOrganization) {
        transitionRevision = setWorkspaceContext({ slug: null, workspaceId: null });
      }
      try {
        const { data, error } = await authClient.organization.delete({
          organizationId,
        });
        if (data) {
          didDelete = true;
          if (draftOwner.accountId) {
            workspaceContextStore.set(clearSessionRunConfigDraftsAtom, {
              workspaceId: organizationId,
              accountId: draftOwner.accountId,
              lifetime: draftOwner.lifetime,
            });
          }
          // Drop per-slug caches up front so the post-delete `/` redirect
          // doesn't bounce back into the deleted workspace via preferredSlug,
          // and so `optimisticWorkspaceId` stops resolving the
          // stale workspaceId — both routes triggered listVisibleMachines for
          // a workspace the user no longer belongs to (Convex 403 → error
          // boundary "Something went wrong").
          if (removalTransition.removedSlug) {
            clearCachedWorkspaceInfo(removalTransition.removedSlug);
            clearPreferredWorkspaceSlugIfMatch(removalTransition.removedSlug);
          }
          if (removalTransition.isActiveOrganization) {
            if (removalTransition.fallbackOrganization) {
              const fallbackOrganization = removalTransition.fallbackOrganization;
              const transitionIsCurrent = () =>
                transitionRevision !== null &&
                workspaceContextStore.get(workspaceContextSnapshotAtom).revision ===
                  transitionRevision;
              if (transitionIsCurrent()) {
                try {
                  await switchOrganizationOrThrow(fallbackOrganization.id);
                  const latestContext = workspaceContextStore.get(workspaceContextSnapshotAtom);
                  if (latestContext.revision !== transitionRevision) {
                    if (
                      latestContext.workspaceId &&
                      latestContext.workspaceId !== fallbackOrganization.id
                    ) {
                      await switchOrganizationOrThrow(latestContext.workspaceId);
                    }
                  } else {
                    setWorkspaceContextAtRevision({
                      revision: transitionRevision,
                      context: {
                        slug: fallbackOrganization.slug,
                        workspaceId: fallbackOrganization.id as WorkspaceId,
                      },
                    });
                  }
                } catch (switchError) {
                  console.error('Failed to switch organization after delete:', switchError);
                  setWorkspaceContextAtRevision({
                    revision: transitionRevision,
                    context: { slug: null, workspaceId: null },
                  });
                }
              }
            } else {
              setWorkspaceContextAtRevision({
                revision: transitionRevision,
                context: { slug: null, workspaceId: null },
              });
            }
          }
          // TODO: delete local workspace data
          void refetchOrganizations();
          void refetchActiveOrganization();
        }
        if (error) {
          setMutationError(error.message || 'Failed to delete organization');
          throw error;
        }
        return data;
      } catch (err) {
        if (removalTransition.isActiveOrganization && !didDelete) {
          setWorkspaceContextAtRevision({
            revision: transitionRevision,
            context: {
              slug: removalTransition.removedSlug,
              workspaceId: organizationId as WorkspaceId,
            },
          });
        }
        console.error('Failed to delete organization:', err);
        setMutationError('Failed to delete organization');
        throw err;
      } finally {
        setIsMutating(false);
      }
    },
    [
      authClient,
      organizations,
      refetchActiveOrganization,
      refetchOrganizations,
      resolvedActiveOrganization,
      setWorkspaceContext,
      setWorkspaceContextAtRevision,
      switchOrganizationOrThrow,
      workspaceContextStore,
    ]
  );

  /**
   * Leave organization.
   */
  const leaveOrganization = useCallback(
    async (organizationId: string) => {
      if (!user) {
        throw new Error('User not available');
      }
      const draftOwner = workspaceContextStore.get(sessionRunConfigDraftAccountAtom);
      setIsMutating(true);
      setMutationError(null);
      const removalTransition = resolveWorkspaceRemovalTransition({
        organizationId,
        organizations,
        activeOrganization: resolvedActiveOrganization,
      });
      let didLeave = false;
      let transitionRevision: number | null = null;
      if (removalTransition.isActiveOrganization) {
        transitionRevision = setWorkspaceContext({ slug: null, workspaceId: null });
      }
      try {
        const { data, error } = await authClient.organization.leave({
          organizationId,
        });
        if (data) {
          didLeave = true;
          if (draftOwner.accountId) {
            workspaceContextStore.set(clearSessionRunConfigDraftsAtom, {
              workspaceId: organizationId,
              accountId: draftOwner.accountId,
              lifetime: draftOwner.lifetime,
            });
          }
          if (removalTransition.removedSlug) {
            clearCachedWorkspaceInfo(removalTransition.removedSlug);
            clearPreferredWorkspaceSlugIfMatch(removalTransition.removedSlug);
          }
          if (removalTransition.isActiveOrganization) {
            if (removalTransition.fallbackOrganization) {
              const fallbackOrganization = removalTransition.fallbackOrganization;
              const transitionIsCurrent = () =>
                transitionRevision !== null &&
                workspaceContextStore.get(workspaceContextSnapshotAtom).revision ===
                  transitionRevision;
              if (transitionIsCurrent()) {
                try {
                  await switchOrganizationOrThrow(fallbackOrganization.id);
                  const latestContext = workspaceContextStore.get(workspaceContextSnapshotAtom);
                  if (latestContext.revision !== transitionRevision) {
                    if (
                      latestContext.workspaceId &&
                      latestContext.workspaceId !== fallbackOrganization.id
                    ) {
                      await switchOrganizationOrThrow(latestContext.workspaceId);
                    }
                  } else {
                    setWorkspaceContextAtRevision({
                      revision: transitionRevision,
                      context: {
                        slug: fallbackOrganization.slug,
                        workspaceId: fallbackOrganization.id as WorkspaceId,
                      },
                    });
                  }
                } catch (switchError) {
                  console.error('Failed to switch organization after leave:', switchError);
                  setWorkspaceContextAtRevision({
                    revision: transitionRevision,
                    context: { slug: null, workspaceId: null },
                  });
                }
              }
            } else {
              setWorkspaceContextAtRevision({
                revision: transitionRevision,
                context: { slug: null, workspaceId: null },
              });
            }
          }
          void refetchOrganizations();
          void refetchActiveOrganization();
        }
        if (error) {
          setMutationError(error.message || 'Failed to leave organization');
          throw error;
        }
        return data;
      } catch (err) {
        if (removalTransition.isActiveOrganization && !didLeave) {
          setWorkspaceContextAtRevision({
            revision: transitionRevision,
            context: {
              slug: removalTransition.removedSlug,
              workspaceId: organizationId as WorkspaceId,
            },
          });
        }
        console.error('Failed to leave organization:', err);
        setMutationError('Failed to leave organization');
        throw err;
      } finally {
        setIsMutating(false);
      }
    },
    [
      authClient,
      organizations,
      refetchActiveOrganization,
      refetchOrganizations,
      resolvedActiveOrganization,
      setWorkspaceContext,
      setWorkspaceContextAtRevision,
      switchOrganizationOrThrow,
      user,
      workspaceContextStore,
    ]
  );

  return {
    organizations,
    organizationsLoading,
    activeOrganizationLoading,
    refetchOrganizations,
    refetchActiveOrganization,
    role,
    hasAdminPermission: role === 'admin' || role === 'owner',
    loading:
      sessionPending ||
      sessionRetrying ||
      isMutating ||
      organizationsLoading ||
      (Boolean(user) &&
        organizations !== undefined &&
        organizations.length > 0 &&
        activeOrganizationIsPending),
    /** Final failure of the organization list alone; routes that only need the list gate on it. */
    organizationsError: organizationsListError,
    error:
      (!user ? sessionError : null) ||
      organizationsListError ||
      (shouldSurfaceActiveOrganizationError ? activeOrganizationError : null) ||
      mutationErrorObject,
    activeOrganization: resolvedActiveOrganization,
    activateOrganization,
    switchOrganization,
    createOrganization,
    updateOrganization,
    deleteOrganization,
    leaveOrganization,
  };
}
