import { useReferralPolicyRefresh } from '@/hooks/use-referral-policy-refresh';
import {
  clearReferral,
  readReferral,
  attachStoredReferral,
  REFERRAL_ERROR_KEYS,
} from '@/lib/referral-attribution';
import { ConvexError } from 'convex/values';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useCallback, useState, useEffect, useRef } from 'react';
import { useCloudAction, usePlatform, usePlatformSession } from '@lody/platform/react';
import { useAtomValue } from 'jotai';
import { e2eeWorkspaceCreationFeatureEnabledAtom } from '@/atoms/settings';
import { E2eeWorkspaceCreationOption } from '@/components/pages/e2ee-workspace-creation-option';
import {
  createPreparedE2eeWorkspace,
  deleteSavedE2eeCreation,
  E2eeCreationDeleteError,
  e2eeCreationChoice,
  e2eeCreationErrorCode,
  isE2eeCreationNotEnabled,
} from '@/lib/create-e2ee-workspace';
import {
  isPendingE2eeCreationStorageKey,
  listPendingE2eeWorkspacesByArchive,
  savePendingE2eeWorkspace,
  setPendingE2eeWorkspaceArchived,
  type PendingE2eeWorkspace,
} from '@/lib/e2ee-workspace-storage';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import { useTranslation } from 'react-i18next';
import { usePostHog } from '@posthog/react';
import { CreateWorkspacePage } from '@/components/pages/create-workspace-page';
import { useOrganization } from '../../hooks/useOrganization';
import { useWorkspaceSlugField } from '../../hooks/useWorkspaceSlugField';
import {
  getPreferredOrdinaryWorkspaceSlug,
  getPreferredWorkspaceSlug,
  readPreferredWorkspaceSlug,
} from '@/lib/workspace';
import { RouteMessage } from '@/components/route-message';
import { useAuthSignOut } from '../../providers/convex-provider';
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
  // Default list only; archived requests stay saved and are listed separately.
  const [pendingRequests, setPendingRequests] = useState<PendingE2eeWorkspace[]>([]);
  const [archivedRequests, setArchivedRequests] = useState<PendingE2eeWorkspace[]>([]);
  const [intentAccount, setIntentAccount] = useState<string | null>(null);
  const [intentReadFailed, setIntentReadFailed] = useState(false);
  const submitInFlight = useRef(false);
  const hidesBillingUi = isMobile || isNativeAppShell();
  const postHog = usePostHog();
  const {
    createOrganization,
    deleteOrganization,
    organizations,
    loading: organizationsLoading,
    activeOrganization,
  } = useOrganization();
  const [orgSettled, setOrgSettled] = useState(!organizationsLoading);

  useEffect(() => {
    if (!organizationsLoading) setOrgSettled(true);
  }, [organizationsLoading]);
  const navigate = useNavigate();
  const signOut = useAuthSignOut();
  const followRedirect = useCallback(
    (target: string) => {
      const appOrigin = getAppOriginForUrlParsing();
      const url = new URL(target, appOrigin);
      if (url.origin === appOrigin) {
        void navigate({ href: `${url.pathname}${url.search}${url.hash}`, replace: true });
      } else {
        window.location.assign(target);
      }
    },
    [navigate]
  );
  const [workspaceName, setWorkspaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingRequestId, setDeletingRequestId] = useState<string | null>(null);
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
    savedRequests: pendingRequests.length + archivedRequests.length,
  });
  const useEncryption = creationChoice.encrypt;
  const pendingCreationRef = useRef(pendingCreation);
  pendingCreationRef.current = pendingCreation;
  // Leave the selected saved request without touching it: the form starts a new,
  // independent intent. Never used for a request this page is still submitting.
  const detachFromRequest = useCallback(() => {
    setPendingCreation(null);
    setWorkspaceName('');
    resetWorkspaceSlug();
    setEncrypted(creationEnabled);
  }, [creationEnabled, resetWorkspaceSlug]);
  const applyRequestLists = useCallback(
    (lists: { active: PendingE2eeWorkspace[]; archived: PendingE2eeWorkspace[] }) => {
      setPendingRequests(lists.active);
      setArchivedRequests(lists.archived);
      const selected = pendingCreationRef.current;
      if (
        selected &&
        !submitInFlight.current &&
        lists.archived.some((request) => request.requestId === selected.requestId)
      )
        detachFromRequest();
    },
    [detachFromRequest]
  );
  useEffect(() => {
    setPendingCreation(null);
    setPendingRequests([]);
    setArchivedRequests([]);
    setCreating(false);
    setDeletingRequestId(null);
    setEncrypted(false);
    setIntentReadFailed(false);
    if (!accountId) return;
    try {
      const lists = listPendingE2eeWorkspacesByArchive(localStorage, accountId);
      setPendingRequests(lists.active);
      setArchivedRequests(lists.archived);
      const pending = lists.active[0] ?? null;
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
      if (!isPendingE2eeCreationStorageKey(event.key)) return;
      try {
        applyRequestLists(listPendingE2eeWorkspacesByArchive(localStorage, accountId));
        setIntentReadFailed(false);
      } catch {
        setIntentReadFailed(true);
      }
    };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [accountId, applyRequestLists]);
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
    followRedirect,
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
  const workspaceReturnSlug = getPreferredOrdinaryWorkspaceSlug(
    activeOrganization,
    organizations,
    readPreferredWorkspaceSlug()
  );

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
        followRedirect(redirect);
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
    followRedirect,
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
    // This replaces the whole form, including its way back, so it carries both
    // exits itself: the previous workspace when there is one, and the account.
    return (
      <RouteMessage
        gate={null}
        title={t('organization.mobileWorkspaceLimitReachedTitle')}
        description={t('organization.mobileWorkspaceLimitReachedDescription')}
        actionLabel={t('organization.backToPreviousWorkspace')}
        onRetry={
          workspaceReturnSlug
            ? () => {
                void navigate({
                  to: '/$workspaceName/chat',
                  params: { workspaceName: workspaceReturnSlug },
                  replace: true,
                });
              }
            : undefined
        }
        secondaryAction={{
          label: t('organization.signOut'),
          onClick: () => {
            void signOut();
          },
        }}
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
        applyRequestLists(listPendingE2eeWorkspacesByArchive(localStorage, accountId));
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
        followRedirect(redirect);
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
          const lists = listPendingE2eeWorkspacesByArchive(localStorage, accountId);
          setPendingRequests(lists.active);
          setArchivedRequests(lists.archived);
          const same = (request: PendingE2eeWorkspace) =>
            request.requestId === currentPending.requestId;
          removed = !lists.active.some(same) && !lists.archived.some(same);
          if (removed) setPendingCreation(null);
          // Another window archived it while this submit ran: the late result stays
          // in the archive instead of reviving the row or holding this form.
          else if (lists.archived.some(same)) detachFromRequest();
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

  const handleDeleteRequest = async (requestId: string) => {
    if (!accountId || submitInFlight.current || creating || intentAccount !== accountId) return;
    const request = [...pendingRequests, ...archivedRequests].find(
      (item) => item.requestId === requestId && item.accountId === accountId
    );
    const port = platform.e2eeWorkspaces;
    if (!request) return;
    if (!port?.prepareCreation) {
      setError(t('e2ee.create.deleteFailed'));
      return;
    }
    submitInFlight.current = true;
    setDeletingRequestId(requestId);
    setError(null);
    try {
      await deleteSavedE2eeCreation({
        port,
        storage: localStorage,
        pending: request,
        deleteWorkspace: deleteOrganization,
        isCurrent: () => accountRef.current === accountId,
      });
      if (accountRef.current !== accountId) return;
      if (pendingCreationRef.current?.requestId === requestId) detachFromRequest();
    } catch (err) {
      if (accountRef.current !== accountId) return;
      console.error('Failed to delete saved creation request:', err);
      setError(
        err instanceof E2eeCreationDeleteError && err.stage === 'delete'
          ? t('e2ee.create.deleteWorkspaceFailed')
          : t('e2ee.create.deleteFailed')
      );
    } finally {
      submitInFlight.current = false;
      if (accountRef.current === accountId) {
        setDeletingRequestId(null);
        try {
          applyRequestLists(listPendingE2eeWorkspacesByArchive(localStorage, accountId));
          setIntentReadFailed(false);
        } catch {
          setIntentReadFailed(true);
        }
      }
    }
  };

  const handleArchiveRequest = (requestId: string, archived: boolean) => {
    if (
      !accountId ||
      submitInFlight.current ||
      creating ||
      deletingRequestId ||
      intentAccount !== accountId
    )
      return;
    const request = (archived ? pendingRequests : archivedRequests).find(
      (item) => item.requestId === requestId && item.accountId === accountId
    );
    if (!request) return;
    try {
      setPendingE2eeWorkspaceArchived(localStorage, request, archived);
      setError(null);
    } catch (err) {
      console.error('Failed to change saved creation request archive:', err);
      setError(t('e2ee.create.archiveFailed'));
    }
    try {
      applyRequestLists(listPendingE2eeWorkspacesByArchive(localStorage, accountId));
      setIntentReadFailed(false);
    } catch {
      setIntentReadFailed(true);
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
        deletingRequestId !== null ||
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
            archivedRequests={archivedRequests.filter((request) => request.accountId === accountId)}
            onArchiveRequest={(requestId) => handleArchiveRequest(requestId, true)}
            onRestoreRequest={(requestId) => handleArchiveRequest(requestId, false)}
            onDeleteRequest={(requestId) => {
              void handleDeleteRequest(requestId);
            }}
            deletingRequestId={deletingRequestId}
            selectedRequestId={currentPending?.requestId ?? null}
            onSelectRequest={(requestId) => {
              const pending = pendingRequests.find(
                (request) => request.requestId === requestId && request.accountId === accountId
              );
              if (!pending || creating || deletingRequestId) return;
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
