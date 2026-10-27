import { useReferralPolicyRefresh } from '@/hooks/use-referral-policy-refresh';
import {
  clearReferral,
  readReferral,
  attachStoredReferral,
  REFERRAL_ERROR_KEYS,
} from '@/lib/referral-attribution';
import { ConvexError } from 'convex/values';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useRef } from 'react';
import { useCloudAction, usePlatform, usePlatformSession } from '@lody/platform/react';
import { useAtomValue } from 'jotai';
import { e2eeWorkspaceCreationFeatureEnabledAtom } from '@/atoms/settings';
import { E2eeWorkspaceCreationOption } from '@/components/pages/e2ee-workspace-creation-option';
import {
  createPreparedE2eeWorkspace,
  e2eeCreationChoice,
  e2eeCreationErrorCode,
  isE2eeCreationNotEnabled,
} from '@/lib/create-e2ee-workspace';
import {
  listPendingE2eeWorkspaces,
  savePendingE2eeWorkspace,
  type PendingE2eeWorkspace,
} from '@/lib/e2ee-workspace-storage';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
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
  const platform = usePlatform();
  const platformSession = usePlatformSession();
  const accountId = platformSession.status === 'authenticated' ? platformSession.user.id : null;
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const creationEnabled = useAtomValue(e2eeWorkspaceCreationFeatureEnabledAtom);
  const [encrypted, setEncrypted] = useState(false);
  const [pendingCreation, setPendingCreation] = useState<PendingE2eeWorkspace | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingE2eeWorkspace[]>([]);
  const [intentAccount, setIntentAccount] = useState<string | null>(null);
  const [intentReadFailed, setIntentReadFailed] = useState(false);
  const submitInFlight = useRef(false);
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
  const [referralCode, setReferralCode] = useState(() => readReferral());
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
  const currentPending = pendingCreation?.accountId === accountId ? pendingCreation : null;
  const creationChoice = e2eeCreationChoice({
    featureEnabled: creationEnabled,
    selected: encrypted,
    resumable: Boolean(currentPending),
    savedRequests: pendingRequests.length,
  });
  const useEncryption = creationChoice.encrypt;
  useEffect(() => {
    setPendingCreation(null);
    setPendingRequests([]);
    setCreating(false);
    setEncrypted(false);
    setIntentReadFailed(false);
    if (!accountId) return;
    try {
      const requests = listPendingE2eeWorkspaces(localStorage, accountId);
      setPendingRequests(requests);
      const pending = requests[0] ?? null;
      setPendingCreation(pending);
      setWorkspaceName(pending?.name ?? '');
      if (pending) setWorkspaceSlug(pending.slug);
      else resetWorkspaceSlug();
      setEncrypted(Boolean(pending));
    } catch {
      setIntentReadFailed(true);
    }
    setIntentAccount(accountId);
  }, [accountId, setWorkspaceSlug, resetWorkspaceSlug]);
  useEffect(() => {
    if (!accountId) return undefined;
    const refresh = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith('lody-e2ee-pending-creation:')) return;
      try {
        setPendingRequests(listPendingE2eeWorkspaces(localStorage, accountId));
        setIntentReadFailed(false);
      } catch {
        setIntentReadFailed(true);
      }
    };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [accountId]);
  // Individual unreadable intents stay isolated in storage. A failure to read
  // storage itself still blocks encrypted creation because intent durability
  // cannot be established.
  const intentBlocked = intentReadFailed && creationEnabled;

  const hasExistingWorkspaces = Boolean(organizations && organizations.length > 0);
  const paidRequired = creationAvailability?.canCreateFree === false;
  const dismissLead = useCloudMutation(cloudOperations.referrals.dismissLead);
  const attachLead = useCloudMutation(cloudOperations.referrals.attachLead);
  // Preview account leads from other devices even without a browser referral code.
  const [policyRefreshKey, refreshPolicy] = useState(0);
  const referralOffer = useCloudQuery(
    cloudOperations.referrals.getCheckoutOffer,
    paidRequired ? { policyRefreshKey, ...(referralCode ? { code: referralCode } : {}) } : 'skip'
  );
  useReferralPolicyRefresh(referralOffer?.policy?.nextChangeAt, refreshPolicy);
  // Mirrors the early-return below: the form is only really shown when creating
  // is allowed for an existing-workspace user, or the user has none.
  const willRenderCreateForm =
    allowExisting === true ||
    Boolean(currentPending) ||
    pendingRequests.length > 0 ||
    !hasExistingWorkspaces;
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
    if (
      !allowExisting &&
      !currentPending &&
      pendingRequests.length === 0 &&
      intentAccount === accountId &&
      !intentBlocked &&
      !organizationsLoading &&
      organizations &&
      organizations.length > 0
    ) {
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
    } else if (
      !intentBlocked &&
      !currentPending &&
      !organizationsLoading &&
      (!organizations || organizations.length === 0)
    ) {
      // Only the stale "no workspace to open" message; a creation failure stays visible.
      setError((current) => (current === missingSlugMessage ? null : current));
    }
  }, [
    activeOrganization,
    allowExisting,
    currentPending,
    pendingRequests.length,
    intentAccount,
    accountId,
    intentBlocked,
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

  if (
    !allowExisting &&
    !currentPending &&
    pendingRequests.length === 0 &&
    intentAccount === accountId &&
    !intentBlocked &&
    organizations &&
    organizations.length > 0
  ) {
    return null;
  }

  if (hidesBillingUi && paidRequired && !currentPending) {
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
    if (
      !accountId ||
      submitInFlight.current ||
      creating ||
      intentBlocked ||
      intentAccount !== accountId
    )
      return;
    const startMs = getPerformanceNowMs();
    if (!workspaceName.trim()) {
      setError(t('organization.workspaceNameRequired'));
      captureCreateFailed('missing_name', startMs);
      return;
    }
    if (!currentPending && (slugErrorType || slugChecking || !slugAvailable || !workspaceSlug)) {
      captureCreateFailed(
        slugChecking ? 'slug_checking' : slugErrorType ? 'slug_invalid' : 'slug_unavailable',
        startMs
      );
      return;
    }
    setCreating(true);
    submitInFlight.current = true;
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
      if (useEncryption) {
        const port = platform.e2eeWorkspaces;
        if (!port?.prepareCreation || !accountId || (paidRequired && !currentPending)) {
          throw new Error('Encrypted workspace creation unavailable');
        }
        const intent = currentPending ?? {
          accountId,
          requestId: crypto.randomUUID(),
          name: workspaceName.trim(),
          slug: workspaceSlug,
        };
        // Persist before generating an identity or sending a request. A lost
        // response reuses these exact fields after reload, including its slug.
        savePendingE2eeWorkspace(localStorage, intent);
        setPendingRequests(listPendingE2eeWorkspaces(localStorage, accountId));
        setIntentReadFailed(false);
        setPendingCreation(intent);
        const result = await createPreparedE2eeWorkspace(port, localStorage, intent);
        if (accountRef.current !== accountId) return;
        setPendingCreation(null);
        await navigate({
          to: '/workspace/e2ee/$workspaceId',
          params: { workspaceId: result.workspaceId },
          replace: true,
        });
        return;
      }
      if (paidRequired) {
        await attachStoredReferral(attachLead);
        const isDesktop = isElectronRenderer();
        const billingUrl = `${window.location.origin}/${workspaceSlug}/settings/billing`;
        const result = await createPaidWorkspaceCheckout({
          name: workspaceName.trim(),
          slug: workspaceSlug,
          interval: billingInterval,
          ...(referralCode && referralOffer?.sendCode ? { referralCode } : {}),
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
      if (accountRef.current !== accountId) return;
      console.error('Failed to create workspace:', err);
      // A refusal that proves nothing was reserved removed the saved request:
      // unlock the fields (keeping what was typed) instead of retrying it forever.
      let removed = false;
      if (useEncryption && currentPending) {
        try {
          const requests = listPendingE2eeWorkspaces(localStorage, accountId);
          setPendingRequests(requests);
          removed = !requests.some((request) => request.requestId === currentPending.requestId);
          if (removed) setPendingCreation(null);
        } catch {
          // Storage stays authoritative; the next page load reads it again.
        }
      }
      const code =
        err instanceof ConvexError && err.data && typeof err.data === 'object'
          ? (err.data as { code?: unknown }).code
          : undefined;
      setError(
        !useEncryption
          ? typeof code === 'string' && code in REFERRAL_ERROR_KEYS
            ? t(REFERRAL_ERROR_KEYS[code])
            : t('organization.createFailed')
          : isE2eeCreationNotEnabled(err)
            ? t('e2ee.create.notEnabled')
            : removed
              ? t('e2ee.create.requestRemoved', { code: e2eeCreationErrorCode(err) })
              : t('e2ee.create.failed')
      );
      captureCreateFailed('create_rejected', startMs);
    } finally {
      submitInFlight.current = false;
      if (accountRef.current === accountId) setCreating(false);
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
      error={error ?? (intentBlocked ? t('e2ee.create.storageFailed') : null)}
      creating={creating}
      fieldsDisabled={Boolean(currentPending)}
      submitDisabled={
        !accountId ||
        intentBlocked ||
        intentAccount !== accountId ||
        (useEncryption &&
          (!platform.e2eeWorkspaces?.prepareCreation || (paidRequired && !currentPending)))
      }
      retryPendingCreation={Boolean(currentPending)}
      paidRequired={paidRequired && !useEncryption}
      creationOptions={
        creationChoice.showOption ? (
          <E2eeWorkspaceCreationOption
            selected={useEncryption}
            supported={Boolean(platform.e2eeWorkspaces?.prepareCreation)}
            pending={Boolean(currentPending)}
            disabled={creating}
            paidRequired={paidRequired}
            onChange={setEncrypted}
            requests={pendingRequests.filter((request) => request.accountId === accountId)}
            selectedRequestId={currentPending?.requestId ?? null}
            onSelectRequest={(requestId) => {
              const pending = pendingRequests.find(
                (request) => request.requestId === requestId && request.accountId === accountId
              );
              if (!pending || creating) return;
              setPendingCreation(pending);
              setWorkspaceName(pending.name);
              setWorkspaceSlug(pending.slug);
              setEncrypted(true);
              setError(null);
            }}
            onSetAside={
              !creationEnabled && currentPending
                ? () => {
                    setPendingCreation(null);
                    setEncrypted(false);
                    setError(null);
                  }
                : undefined
            }
            onNewRequest={
              creationEnabled && currentPending
                ? () => {
                    setPendingCreation(null);
                    setWorkspaceName('');
                    resetWorkspaceSlug();
                    setEncrypted(true);
                    setError(null);
                  }
                : undefined
            }
          />
        ) : undefined
      }
      billingInterval={billingInterval}
      pricing={newWorkspacePricing}
      referralOffer={
        referralOffer?.discount
          ? {
              policy: referralOffer.policy,
              onRemove: () => {
                clearReferral();
                // Also decline the link remembered on the account.
                void dismissLead({}).catch(() => {});
                setReferralCode(undefined);
              },
            }
          : null
      }
      slugChecking={slugChecking}
      slugAvailable={slugAvailable}
      slugErrorType={currentPending ? null : slugErrorType}
      canResetSlug={!currentPending && canResetSlug}
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
