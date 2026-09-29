import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStore,
  type PlatformProvider,
  type PlatformSessionState,
  type WorkspaceSummary,
  type WorkspacesState,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { useOrganization } from '@/hooks/useOrganization';
import { useStableSession } from '@/hooks/useStableSession';
import { useAuthSignOut } from './convex-provider';
import { isElectronRenderer } from '@/lib/electron';
import { cloudPlatformApi } from './cloud-platform-api';
import { installGitHubTokenPort } from '@/lib/github-token-port';
import { cloudGitHubTokenPort } from './cloud-github-token-port';
import { installCloudHttpPort } from '@/lib/cloud-http-port';
import { localAgentEnabledAtom } from '@/atoms/local-probe';
import { resolveCloudPlatformRuntimePolicy } from './cloud-platform-runtime-policy';

const CLOUD_HTTP_PORT = {
  authBaseUrl: import.meta.env.VITE_CONVEX_SITE_URL || null,
  serverBaseUrl: import.meta.env.VITE_API_BASE_URL || null,
} as const;

function toWorkspaceSummary(
  organization: { id: string; name: string; slug?: string | null },
  role: string | undefined
): WorkspaceSummary {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug ?? null,
    role: role ?? 'member',
  };
}

/**
 * Cloud assembly for the shared frontend platform contract. Better Auth and
 * Convex remain behind this component in Phase 0; Phase 1 moves this file to
 * the closed `platform-cloud` package without changing open UI consumers.
 */
export function CloudPlatformProvider({ children }: { children: ReactNode }) {
  const electron = isElectronRenderer();
  const localAgentEnabled = useAtomValue(localAgentEnabledAtom);
  const { syncMode: localAgentSyncMode } = resolveCloudPlatformRuntimePolicy({
    electron,
    localAgentEnabled,
  });
  const session = useStableSession();
  const organization = useOrganization();
  const {
    activateOrganization,
    createOrganization,
    refetchActiveOrganization,
    refetchOrganizations,
    updateOrganization,
  } = organization;
  const signOut = useAuthSignOut();
  const [sessionStore] = useState(() => createStore<PlatformSessionState>({ status: 'loading' }));
  const [workspacesStore] = useState(() => createStore<WorkspacesState>({ status: 'loading' }));
  const [uninstallGitHubTokenPort] = useState(() => installGitHubTokenPort(cloudGitHubTokenPort));
  const [uninstallCloudHttpPort] = useState(() => installCloudHttpPort(CLOUD_HTTP_PORT));

  useEffect(() => uninstallGitHubTokenPort, [uninstallGitHubTokenPort]);
  useEffect(() => uninstallCloudHttpPort, [uninstallCloudHttpPort]);

  useEffect(() => {
    if (session.isPending || session.isRetrying || session.isOptimistic) {
      sessionStore.set({ status: 'loading' });
      return;
    }
    const user = session.data?.user;
    if (!user) {
      sessionStore.set({ status: 'unauthenticated' });
      return;
    }
    sessionStore.set({
      status: 'authenticated',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      },
    });
  }, [
    session.data?.user,
    session.isOptimistic,
    session.isPending,
    session.isRetrying,
    sessionStore,
  ]);

  useEffect(() => {
    if (organization.error) {
      workspacesStore.set({
        status: 'error',
        message:
          organization.error instanceof Error
            ? organization.error.message
            : 'Failed to load workspaces',
      });
      return;
    }
    if (!organization.organizations) {
      workspacesStore.set({ status: 'loading' });
      return;
    }
    workspacesStore.set({
      status: 'ready',
      workspaces: organization.organizations.map((item) =>
        toWorkspaceSummary(
          item,
          item.id === organization.activeOrganization?.id ? organization.role : undefined
        )
      ),
      activeWorkspaceId: organization.activeOrganization?.id ?? null,
    });
  }, [
    organization.activeOrganization?.id,
    organization.error,
    organization.organizations,
    organization.role,
    workspacesStore,
  ]);

  // What the provider's methods call, read when they run. These callbacks change
  // identity on every session refetch (window focus, the keepalive) —
  // `createOrganization` closes over the refetched `user` object — and a
  // consumer that owns resources per platform object, like the Prompt Shortcut
  // runtime, tore them down and reopened them each time: an open Shortcut editor
  // lost its draft and closed. The platform object changes only with what it
  // states, not with a refetch that changed nothing.
  const actions = useRef({
    activateOrganization,
    createOrganization,
    refetchActiveOrganization,
    refetchOrganizations,
    updateOrganization,
    signOut,
    activeOrganizationId: organization.activeOrganization?.id,
    role: organization.role,
  });
  actions.current = {
    activateOrganization,
    createOrganization,
    refetchActiveOrganization,
    refetchOrganizations,
    updateOrganization,
    signOut,
    activeOrganizationId: organization.activeOrganization?.id,
    role: organization.role,
  };

  const provider = useMemo<PlatformProvider>(
    () => ({
      kind: 'cloud',
      identity: {
        session: sessionStore,
        signOut: () => actions.current.signOut(),
      },
      workspaces: {
        state: workspacesStore,
        retry: async () => {
          await Promise.all([
            actions.current.refetchOrganizations(),
            actions.current.refetchActiveOrganization(),
          ]);
        },
        setActive: async (workspaceId) => {
          await actions.current.activateOrganization(workspaceId);
        },
        updateSlug: async (workspaceId, slug) => {
          const updated = await actions.current.updateOrganization(workspaceId, { slug });
          if (!updated) {
            throw new Error('Cloud workspace update returned no workspace');
          }
          const { activeOrganizationId, role } = actions.current;
          return toWorkspaceSummary(
            updated,
            updated.id === activeOrganizationId ? role : undefined
          );
        },
        create: async (input) => {
          const created = await actions.current.createOrganization(input.name, input.slug);
          if (!created) {
            throw new Error('Cloud workspace creation returned no workspace');
          }
          return toWorkspaceSummary(created, 'owner');
        },
      },
      capabilities: CLOUD_PLATFORM_CAPABILITIES,
      cloudApi: cloudPlatformApi,
      sync: {
        mode: localAgentSyncMode,
      },
    }),
    [localAgentSyncMode, sessionStore, workspacesStore]
  );

  return <PlatformContext.Provider value={provider}>{children}</PlatformContext.Provider>;
}
