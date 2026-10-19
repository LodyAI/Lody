import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useRef } from 'react';
import { useCloudAction } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useCloudQuery } from '@lody/platform/react';
import { useTranslation } from 'react-i18next';
import { usePostHog } from '@posthog/react';
import { CreateWorkspacePage } from '@/components/pages/create-workspace-page';
import { useOrganization } from '../../hooks/useOrganization';
import { useWorkspaceSlugField } from '../../hooks/useWorkspaceSlugField';
import { getPreferredWorkspaceSlug, readPreferredWorkspaceSlug } from '@/lib/workspace';
import { RouteMessage } from '@/components/route-message';
import { useStableSession } from '@/hooks/useStableSession';
import { useIsMobile } from '@/hooks/use-mobile';
import { isNativeAppShell } from '@/lib/native-platform';
import { getAppCurrentPathWithSearch, getAppOriginForUrlParsing } from '@/lib/app-location';
import { isSafeAuthRedirect } from '@/lib/auth-redirect';
import { isElectronRenderer } from '@/lib/electron';
import { openExternalUrl } from '@/lib/native-browser';
import {
  capturePostHogEvent,
  capturePostHogSampled,
  getDurationSinceMs,
  getPerformanceNowMs,
  identifyPostHogWorkspace,
} from '@/lib/posthog-analytics';

type WorkspaceCreateFailureReason =
  | 'missing_name'
  | 'slug_invalid'
  | 'slug_checking'
  | 'slug_unavailable'
  | 'create_rejected'
  | 'navigation_missing_slug'
  | 'unknown';

type CreateWorkspaceSearch = {
  redirect?: string;
  allowExisting?: boolean;
};

export const Route = createFileRoute('/workspace/create')({
  component: CreateWorkspace,
  validateSearch: (search: Record<string, unknown>): CreateWorkspaceSearch => {
    // Reuse the auth redirect allowlist: same-origin paths or https://*.lody.ai
    // subdomains. Rejects javascript:/data: schemes and arbitrary external hosts
    // that would otherwise enable open-redirect phishing through window.location.
    const candidate = typeof search.redirect === 'string' ? search.redirect : undefined;
    return {
      redirect:
        isSafeAuthRedirect(candidate, { appOrigin: getAppOriginForUrlParsing() }) ?? undefined,
      allowExisting:
        search.allowExisting === true ||
        (typeof search.allowExisting === 'string' && search.allowExisting === 'true'),
    };
  },
});

/**
 * 创建工作空间页面
 * 用于引导新用户创建他们的第一个工作空间
 * 如果用户已有组织，将自动重定向到主页
 */
function CreateWorkspace() {
  const { t } = useTranslation();
  const { data: session, isPending: sessionLoading, isRetrying, error } = useStableSession();
  const { redirect, allowExisting } = Route.useSearch();
  const [sessionSettled, setSessionSettled] = useState(!sessionLoading);

  useEffect(() => {
    if (!sessionLoading) setSessionSettled(true);
  }, [sessionLoading]);

  if (!sessionLoading && !session?.user) {
    const currentPath = getAppCurrentPathWithSearch();
    return <Navigate to="/login" search={{ redirect: currentPath }} replace />;
  }

  if (!sessionSettled) {
    return null;
  }

  if (sessionLoading || isRetrying) {
    return null;
  }

  if (error) {
    return (
      <RouteMessage
        gate="session_load_error"
        title={t('workspace.route.sessionLoadErrorTitle')}
        description={t('workspace.route.sessionLoadErrorDescription')}
      />
    );
  }

  return <CreateWorkspaceAuthed redirect={redirect} allowExisting={allowExisting} />;
}

function CreateWorkspaceAuthed({
  redirect,
  allowExisting,
}: {
  redirect?: string;
  allowExisting?: boolean;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const hidesBillingUi = isMobile || isNativeAppShell();
  const postHog = usePostHog();
  const {
    createOrganization,
    organizations,
    loading: organizationsLoading,
    activeOrganization,
  } = useOrganization();
  const [orgSettled, setOrgSettled] = useState(!organizationsLoading);

  useEffect(() => {
    if (!organizationsLoading) setOrgSettled(true);
  }, [organizationsLoading]);
  const navigate = useNavigate();
  const [workspaceName, setWorkspaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('year');
  const creationAvailability = useCloudQuery(
    cloudOperations.billing.getWorkspaceCreationAvailability
  );
  const newWorkspacePricing = useCloudQuery(cloudOperations.billing.getMyNewWorkspacePricing, {});
  const createPaidWorkspaceCheckout = useCloudAction(
    cloudOperations.billing.createPaidWorkspaceCheckout
  );
  const {
    slug: workspaceSlug,
    setSlug: setWorkspaceSlug,
    resetSlug: resetWorkspaceSlug,
    canReset: canResetSlug,
    isChecking: slugChecking,
    isAvailable: slugAvailable,
    error: slugErrorType,
  } = useWorkspaceSlugField(workspaceName);

  const hasExistingWorkspaces = Boolean(organizations && organizations.length > 0);
  const paidRequired = creationAvailability?.canCreateFree === false;
  // Mirrors the early-return below: the form is only really shown when creating
  // is allowed for an existing-workspace user, or the user has none.
  const willRenderCreateForm = allowExisting === true || !hasExistingWorkspaces;
  const pageViewedRef = useRef(false);
  // create_page_viewed: fire once the create form is actually rendered (org
  // list settled, not about to auto-redirect). is_first_workspace distinguishes
  // the activation-gate case from the allowExisting "create another" surface.
  useEffect(() => {
    if (pageViewedRef.current || !orgSettled || organizationsLoading || !willRenderCreateForm) {
      return;
    }
    pageViewedRef.current = true;
    capturePostHogEvent(postHog, 'workspace/create_page_viewed', {
      is_first_workspace: !hasExistingWorkspaces,
      allow_existing: allowExisting === true,
      has_redirect: Boolean(redirect),
    });
  }, [
    allowExisting,
    hasExistingWorkspaces,
    organizationsLoading,
    orgSettled,
    postHog,
    redirect,
    willRenderCreateForm,
  ]);

  // slug_check_result is tier C: it re-evaluates on every keystroke. Only emit
  // once the convex availability check has settled (not while checking), and
  // sample so high-velocity typing does not flood ingestion (spec §2.5).
  const lastSlugCheckRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceSlug || slugChecking) {
      return;
    }
    const checkKey = `${workspaceSlug}:${slugErrorType ?? 'ok'}:${slugAvailable}`;
    if (lastSlugCheckRef.current === checkKey) {
      return;
    }
    lastSlugCheckRef.current = checkKey;
    capturePostHogSampled(
      postHog,
      'workspace/slug_check_result',
      {
        slug_length: workspaceSlug.length,
        is_available: slugAvailable,
        rule_error: slugErrorType ?? null,
      },
      { tier: 'C' }
    );
  }, [postHog, slugAvailable, slugChecking, slugErrorType, workspaceSlug]);
  const missingSlugMessage = t(
    'organization.unableToResolveWorkspace',
    'Unable to find a workspace to open. Please try again or contact support.'
  );
  const workspaceReturnSlug =
    organizations && organizations.length > 0
      ? getPreferredWorkspaceSlug(activeOrganization, organizations, readPreferredWorkspaceSlug())
      : null;

  // 检查用户是否已有组织，如果有则重定向
  useEffect(() => {
    if (!allowExisting && !organizationsLoading && organizations && organizations.length > 0) {
      if (redirect) {
        window.location.href = redirect;
      } else {
        const targetSlug = getPreferredWorkspaceSlug(activeOrganization, organizations);
        if (targetSlug) {
          void navigate({
            to: '/$workspaceName/chat',
            params: { workspaceName: targetSlug },
            replace: true,
          });
        } else {
          setError(missingSlugMessage);
        }
      }
    } else if (!organizationsLoading && (!organizations || organizations.length === 0)) {
      setError(null);
    }
  }, [
    activeOrganization,
    allowExisting,
    organizations,
    organizationsLoading,
    redirect,
    navigate,
    missingSlugMessage,
  ]);

  if (!orgSettled) {
    return null;
  }

  if (organizationsLoading) return null;

  if (!allowExisting && organizations && organizations.length > 0) {
    return null;
  }

  if (hidesBillingUi && paidRequired) {
    return (
      <RouteMessage
        gate={null}
        title={t('organization.mobileWorkspaceLimitReachedTitle')}
        description={t('organization.mobileWorkspaceLimitReachedDescription')}
      />
    );
  }

  const captureCreateFailed = (reason: WorkspaceCreateFailureReason, startMs: number) => {
    capturePostHogEvent(postHog, 'workspace/create_failed', {
      reason_code: reason,
      is_first_workspace: !hasExistingWorkspaces,
      duration_ms: getDurationSinceMs(startMs),
    });
  };

  const handleCreateWorkspace = async () => {
    const startMs = getPerformanceNowMs();
    if (!workspaceName.trim()) {
      setError(t('organization.workspaceNameRequired'));
      captureCreateFailed('missing_name', startMs);
      return;
    }
    if (slugErrorType || slugChecking || !slugAvailable || !workspaceSlug) {
      captureCreateFailed(
        slugChecking ? 'slug_checking' : slugErrorType ? 'slug_invalid' : 'slug_unavailable',
        startMs
      );
      return;
    }
    setCreating(true);
    setError(null);

    // create_requested -> create_succeeded/create_failed kept as a triplet
    // because workspace creation is an authoritative multi-step async (spec §2.6,
    // §5.2). create_succeeded for the first workspace is the activation gate.
    capturePostHogEvent(postHog, 'workspace/create_requested', {
      slug_length: workspaceSlug.length,
      is_first_workspace: !hasExistingWorkspaces,
      has_redirect: Boolean(redirect),
    });

    try {
      if (paidRequired) {
        const isDesktop = isElectronRenderer();
        const billingUrl = `${window.location.origin}/${workspaceSlug}/settings/billing`;
        const result = await createPaidWorkspaceCheckout({
          name: workspaceName.trim(),
          slug: workspaceSlug,
          interval: billingInterval,
          ...(isDesktop
            ? { returnTarget: 'desktop' as const }
            : { successUrl: billingUrl, cancelUrl: billingUrl }),
        });
        identifyPostHogWorkspace(postHog, result.workspaceId);
        capturePostHogEvent(postHog, 'workspace/create_succeeded', {
          workspace_id: result.workspaceId,
          slug_length: result.workspaceSlug.length,
          is_first_workspace: false,
          paid_workspace: true,
          checkout_started: Boolean(result.url),
          duration_ms: getDurationSinceMs(startMs),
        });
        if (result.url) {
          // Desktop pays in the system browser; land the app on the new
          // workspace's billing page, which tracks the pending checkout.
          if (isDesktop && (await openExternalUrl(result.url))) {
            void navigate({
              to: '/$workspaceName/settings/billing',
              params: { workspaceName: result.workspaceSlug },
              replace: true,
            });
            return;
          }
          window.location.assign(result.url);
          return;
        }
        void navigate({
          to: '/$workspaceName/settings/billing',
          params: { workspaceName: result.workspaceSlug },
          replace: true,
        });
        return;
      }

      const createdWorkspace = await createOrganization(workspaceName.trim(), workspaceSlug);
      const createdWorkspaceId =
        typeof createdWorkspace?.id === 'string' ? createdWorkspace.id : null;
      identifyPostHogWorkspace(postHog, createdWorkspaceId);
      capturePostHogEvent(postHog, 'workspace/create_succeeded', {
        workspace_id: createdWorkspaceId,
        slug_length: workspaceSlug.length,
        is_first_workspace: !hasExistingWorkspaces,
        duration_ms: getDurationSinceMs(startMs),
      });
      if (redirect) {
        window.location.href = redirect;
      } else {
        const existingSlug = getPreferredWorkspaceSlug(activeOrganization, organizations);
        const targetSlug = createdWorkspace?.slug || workspaceSlug || existingSlug;
        if (targetSlug) {
          void navigate({
            to: '/$workspaceName/chat',
            params: { workspaceName: targetSlug },
            replace: true,
          });
        } else {
          setError(missingSlugMessage);
          captureCreateFailed('navigation_missing_slug', startMs);
        }
      }
    } catch (err) {
      console.error('Failed to create workspace:', err);
      setError(t('organization.createFailed'));
      captureCreateFailed('create_rejected', startMs);
    } finally {
      setCreating(false);
    }
  };

  const handleBackToWorkspace = () => {
    if (!workspaceReturnSlug) return;

    void navigate({
      to: '/$workspaceName/chat',
      params: { workspaceName: workspaceReturnSlug },
      replace: true,
    });
  };

  return (
    <CreateWorkspacePage
      workspaceName={workspaceName}
      workspaceSlug={workspaceSlug}
      error={error}
      creating={creating}
      paidRequired={paidRequired}
      billingInterval={billingInterval}
      pricing={newWorkspacePricing}
      slugChecking={slugChecking}
      slugAvailable={slugAvailable}
      slugErrorType={slugErrorType}
      canResetSlug={canResetSlug}
      onWorkspaceNameChange={(value) => {
        setWorkspaceName(value);
        setError(null);
      }}
      onWorkspaceSlugChange={setWorkspaceSlug}
      onResetWorkspaceSlug={resetWorkspaceSlug}
      onBackToWorkspace={workspaceReturnSlug ? handleBackToWorkspace : undefined}
      onBillingIntervalChange={setBillingInterval}
      onSubmit={() => {
        void handleCreateWorkspace();
      }}
    />
  );
}
