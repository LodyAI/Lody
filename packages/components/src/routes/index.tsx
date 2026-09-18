import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useOrganization } from '@/hooks/useOrganization';
import { getPreferredWorkspaceSlug, readPreferredWorkspaceSlug } from '@/lib/workspace';
import { RouteMessage } from '@/components/route-message';
import { useEffect, useState } from 'react';
import { useStableSession } from '@/hooks/useStableSession';
import { getAppCurrentPathWithSearch } from '@/lib/app-location';
import { readLastAppRoutePath } from '@/lib/last-app-route';
import { LoadingPlaceholder } from '@/components/loading-placeholder';
import { isLocalAppPlatform } from '@/lib/app-platform';
import {
  getLocalWorkspaceSlug,
  useLocalPlatformWorkspacesState,
} from '../providers/local-platform-provider';

export const Route = createFileRoute('/')({
  component: HomeRoute,
});

export function HomeRoute() {
  // Local (open-source) platform: no login route exists. Land straight on the
  // single implicit workspace once the CLI has provisioned it.
  if (isLocalAppPlatform()) {
    return <LocalHomeRoute />;
  }
  return <CloudHomeRoute />;
}

function LocalHomeRoute() {
  const { t } = useTranslation();
  const workspacesState = useLocalPlatformWorkspacesState();
  const workspace =
    workspacesState.status === 'ready' ? (workspacesState.workspaces[0] ?? null) : null;

  if (workspacesState.status === 'error') {
    return (
      <RouteMessage
        title={t('workspace.route.loadingWorkspacesErrorTitle')}
        description={t('workspace.route.loadingWorkspacesErrorDescription')}
      />
    );
  }

  if (!workspace) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.localStartingTitle')}
        description={t('workspace.route.localStartingDescription')}
      />
    );
  }

  return (
    <Navigate
      to="/$workspaceName/chat"
      params={{ workspaceName: getLocalWorkspaceSlug(workspace) }}
      replace
    />
  );
}

function CloudHomeRoute() {
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
  if (hasLocalToken) {
    const lastRoutePath = readLastAppRoutePath();
    if (lastRoutePath) {
      return <Navigate to={lastRoutePath} replace />;
    }

    const preferredSlug = readPreferredWorkspaceSlug();
    if (preferredSlug) {
      return (
        <Navigate to="/$workspaceName/chat" params={{ workspaceName: preferredSlug }} replace />
      );
    }
    return <AuthedHomeRoute />;
  }

  if (isPending || isRetrying) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.signingInTitle')}
        description={t('workspace.route.signingInDescription')}
      />
    );
  }

  // Redirect based on auth state. Do not mount organization fetching when unauthenticated.
  if (!session?.user || sessionError) {
    const redirectPath = typeof window === 'undefined' ? '/' : getAppCurrentPathWithSearch();
    return <Navigate to="/login" search={{ redirect: redirectPath }} replace />;
  }

  return <AuthedHomeRoute />;
}

function AuthedHomeRoute() {
  const { t } = useTranslation();
  const lastRoutePath = readLastAppRoutePath();
  const preferredWorkspaceSlug = readPreferredWorkspaceSlug();
  const {
    activeOrganization,
    organizations,
    organizationsLoading,
    error: organizationsError,
    refetchOrganizations,
    refetchActiveOrganization,
  } = useOrganization();
  const [orgSettled, setOrgSettled] = useState(!organizationsLoading);

  useEffect(() => {
    if (!organizationsLoading) setOrgSettled(true);
  }, [organizationsLoading]);

  if (!orgSettled) {
    return (
      <LoadingPlaceholder
        title={t('workspace.route.loadingWorkspacesTitle')}
        description={t('workspace.route.loadingWorkspacesDescription')}
      />
    );
  }

  if (organizationsError) {
    return (
      <RouteMessage
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
      <LoadingPlaceholder
        title={t('workspace.route.loadingWorkspacesTitle')}
        description={t('workspace.route.loadingWorkspacesDescription')}
      />
    );
  }

  if (organizations.length === 0) {
    return <Navigate to="/workspace/create" replace />;
  }

  if (lastRoutePath) {
    return <Navigate to={lastRoutePath} replace />;
  }

  const targetSlug = getPreferredWorkspaceSlug(
    activeOrganization,
    organizations,
    preferredWorkspaceSlug
  );
  if (!targetSlug) {
    return <Navigate to="/workspace/create" replace />;
  }

  return <Navigate to="/$workspaceName/chat" params={{ workspaceName: targetSlug }} replace />;
}
