import { anyApi, type FunctionReference } from 'convex/server';
import type { ModelUsage } from 'acp-extension-core';
import type {
  MachinePairingView,
  WorktreeCleanupScriptConfig,
  WorktreeSetupScriptConfig,
} from '@lody/shared';

type Query<Args extends Record<string, unknown>, Result> = FunctionReference<
  'query',
  'public',
  Args,
  Result
>;
type Mutation<Args extends Record<string, unknown>, Result> = FunctionReference<
  'mutation',
  'public',
  Args,
  Result
>;
type Action<Args extends Record<string, unknown>, Result> = FunctionReference<
  'action',
  'public',
  Args,
  Result
>;

export type PlanTier = 'free' | 'plus' | 'enterprise';
export type BillingInterval = 'month' | 'year';
export type BillingEntitlementSource = 'free' | 'stripe' | 'stripe_gift' | 'enterprise';

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string | null;
  role: string;
};

export type WorkspaceRepository = {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  description?: string | null;
  worktreeSetup?: WorktreeSetupScriptConfig;
  worktreeCleanup?: WorktreeCleanupScriptConfig;
};

export type GitHubTokenErrorCode =
  | 'unauthorized'
  | 'not_a_member'
  | 'repo_not_linked'
  | 'installation_not_found'
  | 'repo_not_authorized'
  | 'token_generation_failed';

export type BasicGitHubTokenResult =
  | { success: true; token: string; expiresAt: string }
  | { success: false; errorCode: GitHubTokenErrorCode; errorMessage: string };

export type OperationGitHubTokenResult =
  | {
      success: true;
      token: string;
      expiresAt?: string;
      tokenSource: 'personal' | 'app';
      rateLimitScope: string;
      fallbackReason?:
        | 'preference_disabled'
        | 'personal_auth_missing'
        | 'personal_token_expired'
        | 'personal_token_refresh_failed';
    }
  | { success: false; errorCode: GitHubTokenErrorCode; errorMessage: string };

export type UsageRange = 'month' | 'day' | 'week' | 'total';
/** Requested timeline bucket size. The server validates which sizes each range supports. */
export type UsageTimelineGranularity = 'hour' | 'day';
export type UsageSummary = {
  workspaceId: string;
  range: UsageRange;
  totals: { tokens: number; costUSD: number; modelUsage: Record<string, ModelUsage> };
  byUser: Array<{
    userId: string;
    tokens: number;
    costUSD: number;
    modelUsage: Record<string, ModelUsage>;
  }>;
};

export type UsageTimelineBucket = {
  bucketStartMs: number;
  bucketLabel: string;
  tokens: number;
  costUSD: number;
  byModel: Array<{ modelId: string; tokens: number; costUSD: number }>;
  byUser: Array<{ userId: string; tokens: number; costUSD: number }>;
};

/** Token-type split of a range total. Optional: not every deployment reports it. */
export type UsageTokenBreakdown = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
};

export type UsageTimeline = {
  workspaceId: string;
  range: UsageRange;
  startMs: number;
  endMs: number;
  bucketSizeMs: number;
  totals: { tokens: number; costUSD: number; breakdown?: UsageTokenBreakdown };
  users: Record<string, { name?: string; email?: string; image?: string | null }>;
  buckets: UsageTimelineBucket[];
};

export type UsageCalendar = {
  workspaceId: string;
  timezone: 'UTC';
  startMs: number;
  endMs: number;
  days: Array<{
    dayStartMs: number;
    date: string;
    tokens: number;
    costUSD: number;
    isFuture: boolean;
  }>;
};

export type UsageDay = {
  workspaceId: string;
  dayStartMs: number;
  date: string;
  totals: {
    tokens: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningOutputTokens: number;
    webSearchRequests: number;
  };
  byModel: Array<{ modelId: string; tokens: number; costUSD: number }>;
  byUser: Array<{ userId: string; tokens: number; costUSD: number }>;
  users: Record<string, { name?: string; email?: string; image?: string | null }>;
};

type CheckoutUrls = {
  successUrl?: string;
  cancelUrl?: string;
  returnTarget?: 'desktop' | 'web';
};

type Pricing = {
  monthlyAmountCents: number;
  yearlyAmountCents: number;
  monthlyOfferKey: null;
  yearlyOfferKey: string | null;
  yearlyOfferEndsAt: number | null;
};

type WorkspaceAccess =
  | { status: 'unauthenticated' | 'not_found' }
  | { status: 'not_member' | 'member'; organizationId: string };

type PersonalOperationSettings = {
  enabled: boolean;
  authorization:
    | { state: 'missing' }
    | {
        state: 'authorized';
        githubAccountId: string;
        updatedAt?: number;
        expiresAt?: number;
        scope?: string;
        profile?: GitHubProfile;
      }
    | {
        state: 'expired';
        githubAccountId?: string;
        updatedAt?: number;
        scope?: string;
        profile?: GitHubProfile;
      };
};

type GitHubProfile = {
  githubAccountId: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  htmlUrl?: string;
};

type BillingOverview = {
  billingAccountId: string | null;
  planTier: PlanTier;
  giftStackingSupported: boolean;
  checkoutPending: boolean;
  checkoutInterval: BillingInterval | null;
  offerKey:
    | 'founder_monthly_500_forever'
    | 'early_bird_yearly_6000_forever'
    | 'promo_yearly_6000_limited'
    | null;
  yearlyEarlyBirdEligible: boolean;
  effectivePlanTier: PlanTier;
  entitlementSource: BillingEntitlementSource;
  promotionalEntitlementEndsAt: number | null;
  giftStartsAt: number | null;
  giftEndsAt: number | null;
  nextBillingAt: number | null;
  autoRenewAfterGift: boolean;
  canResumeAfterGift: boolean;
  scheduledBillingInterval: BillingInterval | null;
  scheduleManaged: boolean;
  subscriptionSetupPending: boolean;
  subscriptionStatus: string | null;
  billingInterval: BillingInterval | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  seatCount: number;
  subscriptionQuantity: number | null;
  canManageBilling: boolean;
  pricing: Pricing;
};

type BillingInvoiceRecord = {
  id: string;
  number: string | null;
  status: string;
  amountPaid: number;
  currency: string;
  periodStart: number | null;
  periodEnd: number | null;
  interval: BillingInterval | null;
  kind: 'subscription' | 'gift_redemption';
  giftDurationMonths: number | null;
  createdAt: number;
  hostedInvoiceUrl: string | null;
};

type UpcomingInvoicePreview = {
  amountDue: number;
  currency: string;
  expectedAt: number | null;
  renewal: { amount: number; quantity: number | null } | null;
  discount: { amount: number } | null;
  adjustment: { amount: number } | null;
  creditApplied: { amount: number } | null;
};

/**
 * Cost of adding one more workspace member. `not_billed` covers free
 * workspaces and gift/enterprise entitlements that are not billed per seat;
 * `billed` quotes the prorated charge applied when the invitation is accepted.
 */
type SeatInvitePreview =
  | { status: 'not_billed'; reason: 'free' | 'covered' }
  | {
      status: 'billed';
      interval: BillingInterval;
      unitAmount: number;
      proratedAmount: number | null;
      currentPeriodEnd: number | null;
      seatCount: number;
      nextSeatCount: number;
      nextRenewalAmount: number;
    };

export type CloudApi = {
  promptShortcuts: {
    stageDocument: Mutation<
      {
        workspaceId: string;
        ownerUserId: string;
        shortcutId: string;
        bodyDocId: string;
        visibility: 'private' | 'workspace';
      },
      { bodyDocId: string; status: 'staged' | 'active' }
    >;
    activateDocument: Mutation<
      {
        workspaceId: string;
        bodyDocId: string;
        previousBodyDocId: string | null;
        previousRevision: string | null;
        revision: string;
        slug: string;
        indexBytes: number;
      },
      null
    >;
    revokeShortcut: Mutation<{ workspaceId: string; shortcutId: string }, null>;
    listAccessibleDocuments: Query<
      { workspaceId: string },
      Array<{
        shortcutId: string;
        bodyDocId: string;
        ownerUserId: string;
        visibility: 'private' | 'workspace';
        revision: string | null;
      }>
    >;
    getStreamToken: Action<
      {
        workspaceId: string;
        target:
          | { kind: 'index'; ownerUserId: string; visibility: 'private' | 'workspace' }
          | { kind: 'body'; bodyDocId: string };
        write: boolean;
      },
      { token: string; expiresIn: number; gatewayBaseUrl: string; streamId: string }
    >;
  };
  activity: {
    recordMyWorkspaceDailyActiveUser: Mutation<
      { workspaceId: string },
      { created: boolean; dayStartMs: number }
    >;
  };
  auth: {
    getMyWorkspaceMembershipFingerprint: Query<Record<string, never>, string | null>;
    getUserById: Query<
      { workspaceId?: string; userId: string },
      { id: string; name?: string; email?: string; image?: string | null } | null
    >;
    getWorkspaceAccessBySlug: Query<{ slug: string }, WorkspaceAccess>;
    isWorkspaceSlugAvailable: Query<{ slug: string }, { available: boolean }>;
    getWorkspaceUserProfileForCliToken: Query<
      { userId: string; workspaceId: string; cliToken: string },
      {
        id: string;
        name?: string;
        email?: string;
        githubLogin?: string;
        githubAccountId?: string;
      } | null
    >;
  };
  billing: {
    createCheckoutSession: Action<
      CheckoutUrls & { workspaceId: string; interval: BillingInterval },
      { url: string; checkoutKind?: 'subscription' | 'gift_setup' }
    >;
    createPaidWorkspaceCheckout: Action<
      CheckoutUrls & { name: string; slug: string; interval: BillingInterval },
      { workspaceId: string; workspaceSlug: string; url: string | null; existing: boolean }
    >;
    getBillingOverview: Query<{ workspaceId: string }, BillingOverview | null>;
    getMyNewWorkspacePricing: Query<Record<string, never>, Pricing | null>;
    getMyPaidWorkspacePlanTiers: Query<
      Record<string, never>,
      Array<{ workspaceId: string; planTier: Exclude<PlanTier, 'free'> }>
    >;
    getWorkspaceBillingEntitlement: Query<
      { workspaceId: string },
      {
        planTier: PlanTier;
        effectivePlanTier: PlanTier;
        entitlementSource: BillingEntitlementSource;
        promotionalEntitlementEndsAt: number | null;
        checkoutPending: boolean;
      } | null
    >;
    getWorkspaceCreationAvailability: Query<
      Record<string, never>,
      {
        canCreateFree: boolean;
        current: number;
        limit: number;
        pendingWorkspace: { workspaceId: string; workspaceSlug: string } | null;
      } | null
    >;
    getWorkspaceMemberLimitState: Query<
      { workspaceId: string },
      {
        memberLimit: number | null;
        canInvite: boolean;
        isPaid: boolean;
        memberCount: number;
        pendingInvitationCount: number;
      } | null
    >;
    getWorkspaceSeatInvitePreview: Query<{ workspaceId: string }, SeatInvitePreview | null>;
    listBillingInvoices: Action<
      { workspaceId: string },
      { invoices: BillingInvoiceRecord[]; upcoming: UpcomingInvoicePreview | null }
    >;
    previewSubscriptionIntervalChange: Action<
      { workspaceId: string; interval: BillingInterval },
      {
        currency: string;
        interval: BillingInterval;
        quantity: number;
        unitAmount: number;
        subtotalAmount: number;
        promoDiscountAmount: number;
        creditAmount: number;
        deferredToBalanceAmount: number;
        amountDueNow: number;
        remainingCredit: number;
        nextRenewalAt: number | null;
        promoApplied: boolean;
      } | null
    >;
    reconcileWorkspaceCheckout: Action<
      { workspaceId: string },
      { status: 'pending' | 'expired' | 'paid' | 'none' }
    >;
    redeemStripePromotionCode: Action<
      CheckoutUrls & { workspaceId: string; code: string },
      | { status: 'gift_redeemed'; endsAt: number; durationMonths: number }
      | { status: 'checkout_required'; url: string }
      | {
          status:
            | 'invalid_code'
            | 'rate_limited'
            | 'workspace_already_plus'
            | 'subscription_not_eligible'
            | 'checkout_in_progress'
            | 'redemption_in_progress'
            | 'transfer_in_progress';
        }
    >;
    setSubscriptionCancelAtPeriodEnd: Action<
      { workspaceId: string; cancel: boolean },
      { cancelAtPeriodEnd: boolean; currentPeriodEnd: number | null }
    >;
    setSubscriptionInterval: Action<
      { workspaceId: string; interval: BillingInterval },
      { billingInterval: BillingInterval; effectiveAt: number | null }
    >;
  };
  github: {
    createGitHubInstallState: Action<
      { returnTarget?: 'desktop' | 'web'; workspaceSlug?: string; workspaceId: string },
      { state: string }
    >;
    getPersonalOperationSettings: Query<{ workspaceId: string }, PersonalOperationSettings>;
    getPrCacheVersions: Query<
      { workspaceId: string; repoFullName: string; prNumber: number },
      {
        prDetailsUpdatedAt: number | null;
        reviewCommentsUpdatedAt: number | null;
        reviewsUpdatedAt: number | null;
        issueCommentsUpdatedAt: number | null;
        checkRunsUpdatedAt: number | null;
        rowUpdatedAt: number;
      } | null
    >;
    getWorkspaceRepositories: Query<{ workspaceId: string }, WorkspaceRepository[] | null>;
    listWorkspaceReposWithStatus: Query<
      { workspaceId: string },
      Array<{
        repoFullName: string;
        name: string;
        repositoryId: number;
        private: boolean;
        enabled: boolean;
        worktreeSetup?: WorktreeSetupScriptConfig;
        worktreeCleanup?: WorktreeCleanupScriptConfig;
      }> | null
    >;
    refreshPersonalGitHubProfile: Action<{ workspaceId: string }, { success: boolean }>;
    removeRepoFromWorkspace: Mutation<
      { workspaceId: string; repoFullName: string },
      { removed: number }
    >;
    setPersonalOperationPreference: Mutation<{ workspaceId: string; enabled: boolean }, null>;
    setRepoEnabled: Mutation<
      { workspaceId: string; enabled: boolean; repoFullName: string },
      { updated: boolean }
    >;
    setRepoWorktreeCleanup: Mutation<
      { workspaceId: string; repoFullName: string; config: WorktreeCleanupScriptConfig },
      { updated: boolean }
    >;
    setRepoWorktreeSetup: Mutation<
      { workspaceId: string; repoFullName: string; config: WorktreeSetupScriptConfig },
      { updated: boolean }
    >;
    getAccessTokenByRepoNameForClient: Action<
      { workspaceId: string; repoFullName: string },
      BasicGitHubTokenResult
    >;
    getOperationAccessTokenByRepoNameForClient: Action<
      {
        forceAppFallback?: boolean;
        invalidatedPersonalToken?: string;
        workspaceId: string;
        repoFullName: string;
        operation: 'read' | 'write';
      },
      OperationGitHubTokenResult
    >;
    getAccessTokenByRepoNameForCli: Action<
      { workspaceId: string; repoFullName: string; cliToken: string },
      BasicGitHubTokenResult
    >;
    getOperationAccessTokenByRepoNameForCli: Action<
      {
        machineId?: string;
        requesterUserId?: string;
        forceAppFallback?: boolean;
        invalidatedPersonalToken?: string;
        workspaceId: string;
        repoFullName: string;
        cliToken: string;
        operation: 'read' | 'write';
      },
      OperationGitHubTokenResult
    >;
    listWorkspaceRepositoriesForCliToken: Query<
      {
        requesterUserId?: string;
        enabledOnly?: boolean;
        workspaceId: string;
        cliToken: string;
      },
      | { valid: false; repositories: WorkspaceRepository[] }
      | { valid: true; repositories: WorkspaceRepository[] }
    >;
  };
  localProjects: {
    listVisibleLocalProjects: Query<
      { workspaceId: string },
      Array<{
        machineId: string;
        localProjectId: string;
        ownerUserId: string;
        sharedWithTeam: boolean;
        updatedAt: number;
      }>
    >;
    setLocalProjectSharedWithTeam: Mutation<
      {
        workspaceId: string;
        machineId: string;
        sharedWithTeam: boolean;
        localProjectId: string;
      },
      { success: true; sharedWithTeam: boolean }
    >;
  };
  machineCredentials: {
    getMachineCredentialState: Query<
      { workspaceId: string; machineId: string },
      { revocableCount: number }
    >;
    revokeMachineCredentials: Mutation<
      { workspaceId: string; machineId: string },
      { revokedCount: number }
    >;
  };
  machinePairing: {
    cancelRequest: Mutation<{ requestId: string }, { success: true }>;
    claimFromDesktop: Mutation<
      { machineId: string; machineName: string; requestId: string },
      MachinePairingView
    >;
    getRequest: Query<{ requestId: string }, MachinePairingView | null>;
  };
  machines: {
    listVisibleMachines: Query<
      { workspaceId: string },
      Array<{
        machineId: string;
        ownerUserId: string;
        sharedWithTeam: boolean;
        updatedAt: number;
      }>
    >;
    setMachineSharedWithTeam: Mutation<
      { workspaceId: string; machineId: string; sharedWithTeam: boolean },
      { success: true; sharedWithTeam: boolean }
    >;
    upsertMachineRegistrationFromCliToken: Mutation<
      { machineName?: string; workspaceId: string; machineId: string; cliToken: string },
      { success: true; existing: boolean; sharedWithTeam: boolean }
    >;
    canUseMachineFromCliToken: Query<
      {
        localProjectId?: string;
        workspaceId: string;
        machineId: string;
        cliToken: string;
        requesterUserId: string;
      },
      | { allowed: true }
      | {
          allowed: false;
          reason:
            | 'requester_not_member'
            | 'machine_not_registered'
            | 'not_visible'
            | 'project_not_shared';
        }
    >;
    canRequestMachineFromCliToken: Query<
      {
        localProjectId?: string;
        workspaceId: string;
        machineId: string;
        cliToken: string;
      },
      | { allowed: true; requesterUserId: string }
      | {
          allowed: false;
          reason: 'machine_not_registered' | 'not_visible' | 'project_not_shared';
        }
    >;
  };
  usage: {
    getWorkspaceUsageSummary: Query<{ workspaceId: string; range: UsageRange }, UsageSummary>;
    getWorkspaceUsageTimeline: Query<
      { workspaceId: string; range: UsageRange; granularity?: UsageTimelineGranularity },
      UsageTimeline
    >;
    getWorkspaceUsageCalendar: Query<{ workspaceId: string }, UsageCalendar>;
    getWorkspaceUsageDay: Query<{ workspaceId: string; dayStartMs: number }, UsageDay>;
    getWorkspaceUsageSummaryBundleFromCliToken: Query<
      { workspaceId: string; cliToken: string },
      {
        workspaceId: string;
        endMs: number;
        total: UsageSummary;
        day: UsageSummary;
        week: UsageSummary;
        month: UsageSummary;
      }
    >;
    getWorkspaceUsageTimelineFromCliToken: Query<
      { workspaceId: string; cliToken: string; range: UsageRange },
      UsageTimeline
    >;
    upsertSessionUsageFromCli: Mutation<
      {
        usage: {
          cacheCreationInputTokens?: number;
          reasoningOutputTokens?: number;
          costUSD?: number;
          contextWindow?: number;
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
        };
        userId: string;
        workspaceId: string;
        sessionId: string;
        machineId: string;
        acpSessionId: string;
        cliType: string;
        modelUsage: Record<
          string,
          {
            cacheCreationInputTokens?: number;
            reasoningOutputTokens?: number;
            costUSD?: number;
            webSearchRequests?: number;
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
          }
        >;
        cliToken: string;
      },
      { success: boolean }
    >;
  };
  deviceAuth: {
    listMyWorkspacesForCliToken: Query<
      { token: string },
      | { valid: false; userId: null; workspaces: WorkspaceSummary[] }
      | { valid: true; userId: string; workspaces: WorkspaceSummary[] }
    >;
    getWorkspaceBillingEntitlementForCliToken: Query<
      { workspaceId: string; token: string },
      { valid: false } | { effectivePlanTier: PlanTier; checkoutPending: boolean; valid: true }
    >;
  };
  agentFeedback: {
    submitFromCli: Mutation<
      {
        source: 'cli' | 'mcp';
        feedback: string;
        systemInfo: { cliVersion: string; platform: string; arch: string };
        cliToken: string;
      },
      { ok: true; feedbackId: string }
    >;
  };
  notifications: {
    notifySessionCompleted: Action<
      {
        sessionTitle?: string;
        pullRequests?: Array<{ reportedAt?: string; number: number; status: string }>;
        userId: string;
        workspaceId: string;
        sessionId: string;
        occurrenceId: string;
        cliToken: string;
        workspaceSlug: string;
      },
      null
    >;
    notifyPermissionRequested: Action<
      {
        sessionTitle?: string;
        toolTitle?: string;
        toolKind?: string;
        requestKind?: 'permission' | 'ask_user_question';
        userId: string;
        workspaceId: string;
        sessionId: string;
        cliToken: string;
        workspaceSlug: string;
        requestId: string;
        toolCallId: string;
      },
      null
    >;
    recordPermissionRequested: Action<
      {
        sessionTitle?: string;
        toolTitle?: string;
        toolKind?: string;
        requestKind?: 'permission' | 'ask_user_question';
        userId: string;
        workspaceId: string;
        sessionId: string;
        cliToken: string;
        workspaceSlug: string;
        requestId: string;
        toolCallId: string;
      },
      { recorded: boolean }
    >;
    resolvePermissionRequested: Action<
      {
        userId: string;
        workspaceId: string;
        sessionId: string;
        cliToken: string;
        requestId: string;
        toolCallId: string;
      },
      { updated: boolean }
    >;
    syncLiveActivitySummary: Action<
      {
        permissionAlert?: { body: string; title: string };
        userId: string;
        workspaceId: string;
        updatedAt: number;
        cliToken: string;
        items: Array<{
          permissionRequestId?: string;
          permissionCommand?: string;
          id: string;
          updatedAt: number;
          status: 'permission' | 'question' | 'running' | 'unread';
          title: string;
          statusLabel: string;
          agentLogoKind: 'codex' | 'claude' | 'deepseek' | 'mimo' | 'minimax' | 'glm' | 'agent';
          agentLogoText: string;
          updatedAtLabel: string;
        }>;
        statusCounts: {
          permission: number;
          question: number;
          running: number;
          unread: number;
        };
        activityId: string;
        totalCount: number;
      },
      | { sent: boolean; reason: string; ended?: never }
      | { sent: boolean; ended: boolean; reason?: never }
    >;
  };
};

/**
 * Runtime Convex references without generated server imports. The cast is safe
 * because `anyApi` constructs the same module/function reference path that the
 * generated client would construct; `CloudApi` owns the public protocol types.
 */
export const api = anyApi as unknown as CloudApi;
