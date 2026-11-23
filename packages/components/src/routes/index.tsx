import { createFileRoute } from '@tanstack/react-router';
import type { GitHubInstallErrorCode } from '@/lib/github-installation-recovery';
import { BootNavigate } from '@/components/boot-navigate';
import { useTranslation } from 'react-i18next';
import { useOrganization } from '@/hooks/useOrganization';
import { getPreferredWorkspaceSlug, readPreferredWorkspaceSlug } from '@/lib/workspace';
import { isWarmWindow } from '@/lib/desktop-window';
import { RouteMessage } from '@/components/route-message';
import { useEffect, useState } from 'react';
import { useStableSession } from '@/hooks/useStableSession';
import { getAppCurrentPathWithSearch } from '@/lib/app-location';
import { BlockingWaitPlaceholder } from '@/components/blocking-wait-placeholder';
import { isLocalAppPlatform } from '@/lib/app-platform';
import {
  getLocalWorkspaceSlug,
  useLocalPlatformWorkspacesState,
  retryLocalPlatformSnapshot,
} from '../providers/local-platform-provider';

export const Route = createFileRoute('/')({
  component: HomeRoute,
});

export type HomeDestination = {
  kind: 'github-settings';
  error: GitHubInstallErrorCode | 'unknown' | null;
  retryHash: string;
};

export function HomeRoute({ destination }: { destination?: HomeDestination } = {}) {
  // The spare stays natively hidden on `/` while RuntimeProvider prepares the
  // local workspace. Target UI mounts only after the window is claimed.
  if (isWarmWindow()) return null;
  // Local (open-source) platform: no login route exists. Land straight on the
  // single implicit workspace once the CLI has provisioned it.
  if (isLocalAppPlatform()) {
    return <LocalHomeRoute />;
  }
  return <CloudHomeRoute destination={destination} />;
}

function LocalHomeRoute() {
  const { t } = useTranslation();
  const workspacesState = useLocalPlatformWorkspacesState();
  const workspace =
    workspacesState.status === 'ready' ? (workspacesState.workspaces[0] ?? null) : null;

  if (workspacesState.status === 'error') {
    return (
      <RouteMessage
        gate="workspace_list_error"
        title={t('workspace.route.loadingWorkspacesErrorTitle')}
        description={t('workspace.route.loadingWorkspacesErrorDescription')}
        onRetry={retryLocalPlatformSnapshot}
      />
    );
  }

  if (!workspace) {
    return (
      <BlockingWaitPlaceholder
        gate="local_workspace_starting"
        variant="boot"
        title={t('workspace.route.localStartingTitle')}
        description={t('workspace.route.localStartingDescription')}
      />
    );
  }

  return (
    <BootNavigate
      to="/$workspaceName/chat"
      params={{ workspaceName: getLocalWorkspaceSlug(workspace) }}
      replace
    />
  );
}

function CloudHomeRoute({ destination }: { destination?: HomeDestination }) {
  const { t } = useTranslation();
  const {
    data: session,
    hasLocalToken,
    isPending,
    isRetrying,
    error: sessionError,
  } = useStableSession();
  // Returning user with cached workspace: redirect immediately without waiting
  // for session network queries. The _auth route guard handles the rest.
  // A workspace-independent GitHub return must resolve a live member target.
  if (hasLocalToken && !destination) {
    const preferredSlug = readPreferredWorkspaceSlug();
    if (preferredSlug) {
      return (
        <BootNavigate to="/$workspaceName/chat" params={{ workspaceName: preferredSlug }} replace />
      );
    }
    return <AuthedHomeRoute destination={destination} />;
  }

  if (isPending || isRetrying) {
    return (
      <BlockingWaitPlaceholder
        gate="session_loading"
        variant="boot"
        title={t('workspace.route.signingInTitle')}
        description={t('workspace.route.signingInDescription')}
      />
    );
  }

  // Redirect based on auth state. Do not mount organization fetching when unauthenticated.
  if (!session?.user || sessionError) {
    const redirectPath = destination
      ? `/settings/github${destination.error ? `?${new URLSearchParams({ github_install_error: destination.error })}` : ''}`
      : typeof window === 'undefined'
        ? '/'
        : getAppCurrentPathWithSearch();
    return <BootNavigate to="/login" search={{ redirect: redirectPath }} replace />;
  }

  return <AuthedHomeRoute destination={destination} />;
}

function AuthedHomeRoute({ destination }: { destination?: HomeDestination }) {
  const { t } = useTranslation();
  const preferredWorkspaceSlug = readPreferredWorkspaceSlug();
  const {
    activeOrganization,
    organizations,
    organizationsLoading,
    // Only the list decides the landing target; the active organization is
    // optional here and is activated in the background.
    organizationsError,
    refetchOrganizations,
    refetchActiveOrganization,
  } = useOrganization();
  const [orgSettled, setOrgSettled] = useState(!organizationsLoading);

  useEffect(() => {
    if (!organizationsLoading) setOrgSettled(true);
  }, [organizationsLoading]);

  if (!orgSettled) {
    return (
      <BlockingWaitPlaceholder
        gate="workspace_list_loading"
        variant="boot"
        title={t('workspace.route.loadingWorkspacesTitle')}
        description={t('workspace.route.loadingWorkspacesDescription')}
      />
    );
  }

  if (organizationsError) {
    return (
      <RouteMessage
        gate="workspace_list_error"
        title={t('workspace.route.loadingWorkspacesErrorTitle')}
        description={t('workspace.route.loadingWorkspacesErrorDescription')}
        onRetry={() => {
          void refetchOrganizations();
          void refetchActiveOrganization();
        }}
      />
    );
  }

  if (organizationsLoading || organizations === undefined) {
    return (
      <BlockingWaitPlaceholder
        gate="workspace_list_loading"
        variant="boot"
        title={t('workspace.route.loadingWorkspacesTitle')}
        description={t('workspace.route.loadingWorkspacesDescription')}
      />
    );
  }

  if (organizations.length === 0) {
    return <BootNavigate to="/workspace/create" replace />;
  }

  const memberActiveOrganization = destination
    ? (organizations.find(
        (org) => org.id === activeOrganization?.id && org.slug === activeOrganization.slug
      ) ?? null)
    : activeOrganization;
  const targetSlug = getPreferredWorkspaceSlug(
    memberActiveOrganization,
    organizations,
    preferredWorkspaceSlug
  );
  if (!targetSlug) {
    return <BootNavigate to="/workspace/create" replace />;
  }

  if (destination) {
    return (
      <BootNavigate
        to="/$workspaceName/settings/github"
        params={{ workspaceName: targetSlug }}
        search={destination.error ? { github_install_error: destination.error } : {}}
        hash={destination.retryHash}
        replace
      />
    );
  }
  return <BootNavigate to="/$workspaceName/chat" params={{ workspaceName: targetSlug }} replace />;
}
