export type { E2eeAccountPairingMailboxPreview } from './e2ee-account-pairing';
import type { E2eeWorkspaceBatchReply } from './e2ee-workspaces';
export type { E2eeWorkspaceBatchReply } from './e2ee-workspaces';
export type WorkspaceDirectoryMember = {
  userId: string;
  name: string | null;
  image: string | null;
};
export type {
  MachineIdentityRestoreIntent,
  MachineIdentityRestoreResult,
} from './machine-identity-restore';
import type {
  E2eeAutomaticPairingRecord,
  E2eeAutomaticPairingCommand,
} from './e2ee-automatic-pairing';
export type * from './e2ee-automatic-pairing';
export type SubscriptionPaymentStatus = {
  billingInterval: BillingInterval;
  effectiveAt: number | null;
  payment?: {
    status: 'settled' | 'required' | 'checking';
    amountRemaining?: number;
    currency?: string;
    invoiceUrl?: string | null;
    hasMore?: boolean;
    outstandingInvoices?: Array<{
      id: string;
      status?: string;
      amountRemaining: number;
      currency: string;
      invoiceUrl: string | null;
    }>;
  };
};

import type {
  E2eeContentTokenRequest,
  E2eeContentToken,
  E2eeDeviceAccess,
  E2eeMailboxSlot,
  E2eeMailboxStatus,
  E2eeMailboxRequests,
  E2eeMailboxReplies,
  E2eeAppendRecordRequest,
  E2eeAppendRecordReply,
} from './e2ee-device';
import type { E2eeJoinRequests, E2eeJoinReplies } from './e2ee-join';
import type { E2eeAccountPairingRequests, E2eeAccountPairingReplies } from './e2ee-account-pairing';
import type { E2eeMemberRequests, E2eeMemberReplies } from './e2ee-members';
import type { E2eeMachineSharingRequests, E2eeMachineSharingReplies } from './e2ee-machine-sharing';
export type * from './e2ee-machine-sharing';
export type * from './e2ee-members';
export type * from './e2ee-join';
export type * from './e2ee-account-pairing';
export type * from './e2ee-device';
import type { NotificationPresentation } from '@lody/shared/notifications';
import type { TerminalOutcome } from '@lody/shared/notifications';
import { anyApi, type FunctionReference } from 'convex/server';
import type {
  WorkspaceAdmissionDescriptor,
  E2eeWorkspaceLedgerHead,
  E2eeWorkspaceCreateRequest,
  E2eeWorkspaceCreateResult,
  E2eeWorkspaceHistoryRequest,
  E2eeWorkspaceHistoryPage,
  E2eeDeviceProfile,
  E2eeDeviceProfileUpdate,
  E2eeWorkspaceMemberProfilesRequest,
  E2eeWorkspaceMemberProfiles,
} from './e2ee-workspaces';
export type {
  WorkspaceAdmissionDescriptor,
  WorkspaceModeDescriptor,
  E2eeWorkspaceCreateRequest,
  E2eeWorkspaceCreateResult,
  E2eeLedgerCheckpoint,
  E2eeWorkspaceLedgerHead,
  E2eeDeviceProfile,
  E2eeDeviceProfileUpdate,
  E2eeWorkspaceMemberProfilesRequest,
  E2eeWorkspaceMemberProfiles,
  E2eeWorkspaceHistoryRequest,
  E2eeWorkspaceHistoryPage,
} from './e2ee-workspaces';
import type {
  RecoveryVaultPutRequest,
  RecoveryVaultReadRequest,
  RecoveryVaultIndexReadRequest,
  RecoveryVaultIndexCasRequest,
  RecoveryVaultIndexCasReply,
  RecoveryVaultDeleteRequest,
  RecoveryVaultCiphertextDto,
} from './e2ee-recovery-vault';
export type {
  RecoveryVaultPutRequest,
  RecoveryVaultReadRequest,
  RecoveryVaultIndexReadRequest,
  RecoveryVaultIndexCasRequest,
  RecoveryVaultIndexCasReply,
  RecoveryVaultDeleteRequest,
  RecoveryVaultCiphertextDto,
} from './e2ee-recovery-vault';
import type {
  StageEpochGroupRequest,
  StageEpochGroupReply,
  ReadEpochGroupRequest,
  DeleteEpochGroupRequest,
  EpochStagedGroupDto,
} from './e2ee-epoch-staging';
export type {
  EpochStagedGroupKeyDto,
  EpochStagedEnvelopeDto,
  EpochStagedGroupDto,
  StageEpochGroupRequest,
  StageEpochGroupReply,
  ReadEpochGroupRequest,
  DeleteEpochGroupRequest,
} from './e2ee-epoch-staging';
import type {
  BeginShareDeployment,
  SessionShareManagement,
  SessionShareView,
  PublishedSessionSharePage,
  SessionShareRequestInput,
  SessionShareRequestResult,
  SessionShareRequest,
} from './session-sharing';
export type {
  PublishedSessionShare,
  PublishedSessionSharePage,
  SessionShareView,
  SessionShareManagementEntry,
  SessionShareManagement,
  SessionShareRequestInput,
  SessionShareRequestStatus,
  SessionShareRequestResult,
  SessionShareRequest,
} from './session-sharing';
import type { ModelUsage } from 'acp-extension-core';
import type {
  MachinePairingView,
  WorktreeCleanupScriptConfig,
  WorktreeSetupScriptConfig,
} from '@lody/shared';

import type {
  E2eeMachineBootstrapReply,
  E2eeMachinePairingCompleteReply,
  E2eeMachinePairingRequests,
  E2eeMachinePairingStatus,
} from './e2ee-machine-pairing';
export type {
  E2eeMachineBootstrapAuthorizedReply,
  E2eeMachineBootstrapReply,
  E2eeMachinePairingCompleteReply,
  E2eeMachinePairingRequests,
  E2eeMachinePairingStatus,
} from './e2ee-machine-pairing';

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
  | 'personal_unavailable'
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
  seatBilling?: {
    policy: 'deferred';
    capacity: number;
    available: number;
    renewalQuantity: number;
    periodEnd: number | null;
  } | null;
  checkoutPending: boolean;
  checkoutInterval: BillingInterval | null;
  offerKey:
    | 'founder_monthly_500_forever'
    | 'early_bird_yearly_6000_forever'
    | 'promo_yearly_6000_limited'
    | null;
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
  referralRewardsSupported?: boolean;
  pricing: Pricing;
};

type BillingInvoiceRecord = {
  id: string;
  number: string | null;
  status: string;
  amountPaid: number;
  /** Optional for clients connected to an older billing backend. */
  amountDue?: number | null;
  amountRemaining?: number | null;
  total?: number | null;
  reason?:
    | 'subscription_started'
    | 'subscription_renewed'
    | 'seats_added'
    | 'seats_removed'
    | 'plan_changed'
    | 'subscription_changed'
    | 'gift_redemption'
    | 'other';
  seatChange?: { from: number; to: number } | null;
  currency: string;
  periodStart: number | null;
  periodEnd: number | null;
  interval: BillingInterval | null;
  kind: 'subscription' | 'gift_redemption';
  giftDurationMonths: number | null;
  createdAt: number;
  hostedInvoiceUrl: string | null;
};

export type BillingInvoiceDetail = {
  invoice: BillingInvoiceRecord;
  lines: Array<{
    id: string;
    description: string;
    amount: number;
    quantity: number | null;
    periodStart: number | null;
    periodEnd: number | null;
  }>;
  canCancel: boolean;
  cancellationPending?: boolean;
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
export type { SeatInvitePreview } from './seat-invite-preview';
import type { SeatInvitePreview } from './seat-invite-preview';

export type CloudApi = {
  e2eeMachineSharing: {
    /** Untrusted invalidation hints, never policy authority or content. */
    listVersions: Query<
      { workspaceId: string },
      Array<{
        machineId: string;
        generation: string;
        revision: number;
      }>
    >;

    readHead: Action<E2eeMachineSharingRequests['readHead'], E2eeMachineSharingReplies['readHead']>;
    readVersion: Action<
      E2eeMachineSharingRequests['readVersion'],
      E2eeMachineSharingReplies['readVersion']
    >;
    readRequest: Action<
      E2eeMachineSharingRequests['readRequest'],
      E2eeMachineSharingReplies['readRequest']
    >;
    commit: Action<E2eeMachineSharingRequests['commit'], E2eeMachineSharingReplies['commit']>;
  };
  e2eeMembers: {
    workspaces: Query<Record<string, never>, import('./e2ee-members').E2eeMemberWorkspace[]>;
    createInvitation: Mutation<
      E2eeMemberRequests['createInvitation'],
      E2eeMemberReplies['createInvitation']
    >;
    preview: Query<E2eeMemberRequests['preview'], E2eeMemberReplies['preview']>;
    submit: Mutation<E2eeMemberRequests['submit'], E2eeMemberReplies['submit']>;
    retire: Mutation<E2eeMemberRequests['retire'], E2eeMemberReplies['retire']>;
    pending: Query<E2eeMemberRequests['pending'], E2eeMemberReplies['pending']>;
    read: Query<E2eeMemberRequests['read'], E2eeMemberReplies['read']>;
    reject: Mutation<E2eeMemberRequests['reject'], E2eeMemberReplies['reject']>;
    revoke: Mutation<E2eeMemberRequests['revoke'], E2eeMemberReplies['revoke']>;
    claim: Query<E2eeMemberRequests['claim'], E2eeMemberReplies['claim']>;
  };
  /** Optional developer-only E2EE control plane; does not authorize content access. */
  e2eeContent: { contentStreamsToken: Action<E2eeContentTokenRequest, E2eeContentToken> };
  e2eeJoinMailbox: {
    begin: Mutation<E2eeJoinRequests['begin'], E2eeJoinReplies['begin']>;
    status: Query<E2eeJoinRequests['status'], E2eeJoinReplies['status']>;
    readRequest: Query<E2eeJoinRequests['readRequest'], E2eeJoinReplies['readRequest']>;
    cancel: Mutation<E2eeJoinRequests['cancel'], E2eeJoinReplies['cancel']>;
    publish: Mutation<E2eeJoinRequests['publish'], E2eeJoinReplies['publish']>;
    claim: Query<E2eeJoinRequests['claim'], E2eeJoinReplies['claim']>;
  };
  /** Account-wide personal device pairing relay; relays and notifies, never approves. */
  e2eeAutomaticPairing: {
    pending: Query<Record<string, never>, E2eeAutomaticPairingRecord[]>;
    read: Query<{ id: string }, E2eeAutomaticPairingRecord | null>;
    exchange: Mutation<E2eeAutomaticPairingCommand, E2eeAutomaticPairingRecord>;
  };
  e2eeAccountPairing: {
    submit: Mutation<E2eeAccountPairingRequests['submit'], E2eeAccountPairingReplies['submit']>;
    pending: Query<E2eeAccountPairingRequests['pending'], E2eeAccountPairingReplies['pending']>;
    read: Query<E2eeAccountPairingRequests['read'], E2eeAccountPairingReplies['read']>;
    decline: Mutation<E2eeAccountPairingRequests['decline'], E2eeAccountPairingReplies['decline']>;
    publish: Mutation<E2eeAccountPairingRequests['publish'], E2eeAccountPairingReplies['publish']>;
    claim: Query<E2eeAccountPairingRequests['claim'], E2eeAccountPairingReplies['claim']>;
  };
  e2eeMailbox: {
    put: Mutation<E2eeMailboxRequests['put'], E2eeMailboxReplies['put']>;
    read: Query<E2eeMailboxRequests['read'], E2eeMailboxReplies['read']>;
    fetch: Query<E2eeMailboxRequests['fetch'], E2eeMailboxReplies['fetch']>;
    status: Query<E2eeMailboxRequests['status'], E2eeMailboxReplies['status']>;
    batchStatus: Query<E2eeMailboxRequests['batchStatus'], E2eeMailboxReplies['batchStatus']>;
    report: Mutation<E2eeMailboxRequests['report'], E2eeMailboxReplies['report']>;
    repair: Mutation<E2eeMailboxRequests['repair'], E2eeMailboxReplies['repair']>;
  };
  e2eeMachinePairing: {
    begin: Mutation<E2eeMachinePairingRequests['begin'], E2eeMachinePairingStatus>;
    inspect: Query<E2eeMachinePairingRequests['inspect'], E2eeMachinePairingStatus>;
    cancel: Mutation<E2eeMachinePairingRequests['cancel'], E2eeMachinePairingStatus>;
    authorizeExisting: Mutation<E2eeMachinePairingRequests['inspect'], E2eeMachinePairingStatus>;
    bootstrap: Query<
      { workspaceId: string; credential: string; machineId: string },
      E2eeMachineBootstrapReply
    >;
    /** The paired machine's own workspace plan, authenticated by its device credential. */
    workspaceEntitlement: Query<
      { workspaceId: string; credential: string; machineId: string },
      | { valid: false; reason: string }
      | { valid: true; effectivePlanTier: PlanTier; checkoutPending: boolean }
    >;
    complete: Mutation<E2eeMachinePairingRequests['complete'], E2eeMachinePairingCompleteReply>;
  };
  e2eeWorkspaces: {
    ledgerHead: Query<{ workspaceId: string }, E2eeWorkspaceLedgerHead>;
    appendRecord: Action<E2eeAppendRecordRequest, E2eeAppendRecordReply>;
    appendRecordsBatch: Action<
      { items: E2eeAppendRecordRequest[] },
      E2eeWorkspaceBatchReply<E2eeAppendRecordReply>
    >;
    create: Action<E2eeWorkspaceCreateRequest, E2eeWorkspaceCreateResult>;
    deleteWorkspace: Action<{ workspaceId: string }, { workspaceId: string; deleted: true }>;
    describe: Query<{ workspaceId: string }, WorkspaceAdmissionDescriptor>;
    reportDeviceProfile: Mutation<
      | E2eeDeviceProfileUpdate
      | { workspaceId: string; credential: string; cliToken?: string; profile: E2eeDeviceProfile },
      null
    >;
    memberProfiles: Query<E2eeWorkspaceMemberProfilesRequest, E2eeWorkspaceMemberProfiles>;
    history: Action<E2eeWorkspaceHistoryRequest, E2eeWorkspaceHistoryPage>;
    historyBatch: Action<
      { items: E2eeWorkspaceHistoryRequest[] },
      E2eeWorkspaceBatchReply<E2eeWorkspaceHistoryPage>
    >;
  };
  /** Optional E2EE ciphertext staging. No ordinary/local product constructs it. */
  accountSecurityEvents: {
    list: Query<
      { cursor?: string | null; limit?: number },
      { events: E2eeAccountSecurityEvent[]; nextCursor: string | null }
    >;
  };
  e2eeRecoveryVault: {
    hasAccountVault: Query<Record<string, never>, { exists: boolean }>;
    replacementState: Query<
      Record<string, never>,
      { current: string | null; replacing: string | null }
    >;
    reserveReplacementVault: Mutation<{ vaultId: string }, { ok: true }>;
    finishReplacement: Mutation<{ oldVaultId: string; newVaultId: string }, { ok: true }>;
    abandonReplacement: Mutation<{ vaultId: string }, { ok: true }>;
    putImmutable: Mutation<RecoveryVaultPutRequest, { ok: true }>;
    readEntry: Query<RecoveryVaultReadRequest, RecoveryVaultCiphertextDto | null>;
    /** Bounded to eight distinct ids and 256 KiB combined ciphertext bodies, ordered. */
    readEntries: Query<
      { vaultId: string; entryIds: string[] },
      (RecoveryVaultCiphertextDto | null)[]
    >;
    readIndex: Query<RecoveryVaultIndexReadRequest, RecoveryVaultCiphertextDto | null>;
    compareAndSwapIndex: Mutation<RecoveryVaultIndexCasRequest, RecoveryVaultIndexCasReply>;
    deleteUnreferenced: Mutation<RecoveryVaultDeleteRequest, { ok: true }>;
  };
  e2eeEpochStaging: {
    stageGroup: Mutation<StageEpochGroupRequest, StageEpochGroupReply>;
    readGroup: Query<ReadEpochGroupRequest, EpochStagedGroupDto | null>;
    deleteGroup: Mutation<DeleteEpochGroupRequest, { ok: true; done: boolean }>;
  };
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
    settleDocument: Mutation<
      {
        workspaceId: string;
        shortcutId: string;
        bodyDocId: string;
        visibility: 'private' | 'workspace';
      },
      'active' | 'cancelled'
    >;
    revokeShortcut: Mutation<
      {
        workspaceId: string;
        shortcutId: string;
        bodyDocId: string;
        visibility: 'private' | 'workspace';
      },
      null
    >;
    listAccessibleDocuments: Query<
      { workspaceId: string },
      Array<{
        shortcutId: string;
        bodyDocId: string;
        ownerUserId: string;
        visibility: 'private' | 'workspace';
        revision: string | null;
        deleted?: boolean;
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
    getStreamTokenV2: Action<ShortcutTokenRequest, ShortcutTokenReply>;
  };
  sessionSharing: {
    requestFromCli: Mutation<
      SessionShareRequestInput & { cliToken: string },
      SessionShareRequestResult
    >;
    listRequests: Query<{ workspaceId: string; sourceSessionId: string }, SessionShareRequest[]>;
    getRequestResultFromCli: Query<
      {
        cliToken: string;
        workspaceId: string;
        shareRequestId: string;
        sourceSessionId: string;
        requesterUserId: string;
        deliveryPublicKey: string;
      },
      SessionShareRequestResult
    >;
    cancelRequest: Mutation<{ requestId: string }, void>;
    list: Query<
      { workspaceId: string; paginationOpts: { numItems: number; cursor: string | null } },
      PublishedSessionSharePage
    >;
    getManagement: Query<
      { workspaceId: string; rootSessionId: string; shareId?: string },
      SessionShareManagement
    >;
    beginDeployment: Mutation<BeginShareDeployment, SessionShareView & { deploymentId: string }>;
    publishDeployment: Mutation<{ deploymentId: string }, SessionShareView>;
    resetCredential: Mutation<
      { shareId: string; expectedRevision: number; credentialHash: string },
      SessionShareView
    >;
    revoke: Mutation<{ shareId: string; expectedRevision: number }, SessionShareView>;
  };
  activity: {
    recordMyWorkspaceDailyActiveUser: Mutation<
      { workspaceId: string },
      { created: boolean; dayStartMs: number }
    >;
  };
  workspaceMembers: {
    list: Query<{ workspaceId: string; accountId: string }, WorkspaceDirectoryMember[]>;
  };
  auth: {
    transferWorkspaceOwnership: Mutation<{ workspaceId: string; targetMemberId: string }, null>;
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
  referrals: {
    createLink: Mutation<{ workspaceId: string }, { code: string; url: string }>;
    getOverview: Query<{ workspaceId: string; policyRefreshKey?: number }, ReferralOverview | null>;
    listLedger: Query<
      { workspaceId: string; paginationOpts: { numItems: number; cursor: string | null } },
      { page: ReferralLedgerEntry[]; isDone: boolean; continueCursor: string }
    >;
    /** Without `workspaceId`, previews a workspace the caller is about to create. */
    getCheckoutOffer: Query<
      { workspaceId?: string; code?: string; policyRefreshKey?: number },
      ReferralCheckoutOffer
    >;
    /** Remember the referral link the signed-in person followed, across devices. */
    attachLead: Mutation<
      { code: string; clickedAt?: number },
      { status: 'attached' | 'kept' | 'self' | 'invalid' }
    >;
    /** The person declined the referral discount. */
    dismissLead: Mutation<Record<string, never>, null>;
  };
  billing: {
    createBillingPortalSession: Action<
      { workspaceId: string; returnUrl?: string; returnTarget?: 'web' | 'desktop' },
      { url: string }
    >;
    createCheckoutSession: Action<
      CheckoutUrls & { workspaceId: string; interval: BillingInterval; referralCode?: string },
      { url: string; checkoutKind?: 'subscription' | 'gift_setup' }
    >;
    createPaidWorkspaceCheckout: Action<
      CheckoutUrls & {
        name: string;
        slug: string;
        interval: BillingInterval;
        referralCode?: string;
      },
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
    getWorkspaceSeatInvitePreview: Query<
      { workspaceId: string; requestedSeats?: number },
      SeatInvitePreview | null
    >;
    listDeletedWorkspaceBillingAccounts: Query<
      Record<string, never>,
      Array<{ workspaceId: string; name: string }>
    >;
    listBillingInvoices: Action<
      { workspaceId: string },
      { invoices: BillingInvoiceRecord[]; upcoming: UpcomingInvoicePreview | null }
    >;
    purchaseWorkspaceMemberSeat: Action<{ workspaceId: string }, { status: 'ready' }>;
    getBillingInvoice: Action<{ workspaceId: string; invoiceId: string }, BillingInvoiceDetail>;
    cancelPendingSeatInvoice: Action<
      { workspaceId: string; invoiceId: string },
      { status: 'canceled' }
    >;
    previewSubscriptionIntervalChange: Action<
      { workspaceId: string; interval: BillingInterval },
      {
        quoteId: string;
        continuation?: boolean;
        currency: string;
        interval: BillingInterval;
        quantity: number;
        unitAmount: number;
        subtotalAmount: number;
        promoDiscountAmount: number;
        accruedSeatAmount?: number;
        adjustmentAmount?: number;
        taxAmount?: number;
        balanceAmount?: number;
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
    getSubscriptionPaymentStatus: Action<{ workspaceId: string }, SubscriptionPaymentStatus>;
    setSubscriptionInterval: Action<
      { workspaceId: string; interval: BillingInterval; quoteId?: string },
      SubscriptionPaymentStatus
    >;
  };
  githubPersonalAuthorization: {
    begin: Action<
      { workspaceId: string; challenge: string; callbackURL: string },
      { state: string; url: string }
    >;
    complete: Action<
      { workspaceId: string; state: string; code: string; verifier: string },
      { success: true }
    >;
  };
  github: {
    createGitHubInstallState: Action<
      { returnTarget?: 'desktop' | 'web'; workspaceSlug?: string; workspaceId: string },
      { state: string }
    >;
    getPersonalOperationSettings: Query<{ workspaceId: string }, PersonalOperationSettings>;
    resolveLegacyPrRepositoryIdentity: Mutation<
      { workspaceId: string; repoFullName: string; prNumber: number; sessionId: string },
      { resolved: boolean }
    >;
    getPrCacheVersions: Query<
      { workspaceId: string; repoFullName: string; prNumber: number; sessionId?: string },
      {
        repoFullName?: string;
        repositoryId?: number;
        identityPending?: boolean;
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
    getCredentialPolicyForCli: Action<
      { cliToken: string; workspaceId: string; requesterUserId: string; machineId: string },
      { personalEnabled: boolean }
    >;
    getOperationAccessTokenByRepoNameForCli: Action<
      {
        credentialSource?: 'personal' | 'app';
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
    /** Account-member directory of grants only; this never grants machine execution. */
    listSessionAccess: Query<
      { workspaceId: string },
      Array<{
        machineId: string;
        readSharedSessionIds: string[];
        memberReadSharedSessions?: Array<{ sessionId: string; userId: string }>;
        canManage: boolean;
      }>
    >;
    setSessionReadSharedWithTeam: Mutation<
      {
        workspaceId: string;
        machineId: string;
        sessionId: string;
        sharedWithTeam: boolean;
        audience?: 'team' | { userId: string };
      },
      { success: true }
    >;

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
    /** Both the token user and `requesterUserId` must be able to use the target. */
    canDelegateMachineUseFromCliToken: Query<
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
    canRequestSessionReadFromCliToken: Query<
      {
        cliToken: string;
        workspaceId: string;
        machineId: string;
        sessionId: string;
        rootSessionId: string;
        sessionOwnerUserId?: string;
        localProjectId?: string;
        requester: { userId: string; machineId: string };
      },
      { allowed: boolean }
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
      { token: string; includeEncrypted?: boolean },
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
        outcome?: TerminalOutcome;
        presentation?: NotificationPresentation;
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
        presentation?: NotificationPresentation;
        userId: string;
        workspaceId: string;
        sessionId: string;
        cliToken: string;
        workspaceSlug: string;
        deliveryVersion?: 1;
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

/** Convex refuses an unknown argument with `ArgumentValidationError`, naming the field. */
const rejectsOptionalField = (error: unknown, field: string) => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /ArgumentValidationError/.test(message) && message.includes(field);
};
/**
 * Ask `e2eeMailbox.put` to inline `{ frameHex, slot }`, saving the separate `read` and `status`
 * queries after each stored envelope. A backend that predates `includeReceipt` refuses it once;
 * this client instance retries without the field and stops asking.
 */
export function makeInlineMailboxPut() {
  let supported = true;
  return async <A>(
    input: E2eeMailboxRequests['put'],
    call: (input: E2eeMailboxRequests['put']) => Promise<A>
  ): Promise<A> => {
    const { includeReceipt: _, ...plain } = input;
    if (!supported) return call(plain);
    try {
      return await call({ ...plain, includeReceipt: true });
    } catch (error) {
      if (!rejectsOptionalField(error, 'includeReceipt')) throw error;
      supported = false;
      return call(plain);
    }
  };
}
/**
 * Ask `e2eeEpochStaging.stageGroup` to inline the stored `group`, saving the post-stage
 * `readGroup` query while keeping client-side `EpochPublisher` verification intact.
 */
export function makeInlineStageGroup() {
  let supported = true;
  return async <A>(
    input: StageEpochGroupRequest,
    call: (input: StageEpochGroupRequest) => Promise<A>
  ): Promise<A> => {
    const { includeReadback: _, ...plain } = input;
    if (!supported) return call(plain);
    try {
      return await call({ ...plain, includeReadback: true });
    } catch (error) {
      if (!rejectsOptionalField(error, 'includeReadback')) throw error;
      supported = false;
      return call(plain);
    }
  };
}
/**
 * Ask `e2eeMailbox.fetch` to inline the recipient's current `slot` status, saving
 * repeated status queries when `KeyReceiver` installs and finishes an envelope.
 */
export function makeInlineMailboxFetch() {
  let supported = true;
  return async <A>(
    input: E2eeMailboxRequests['fetch'],
    call: (input: E2eeMailboxRequests['fetch']) => Promise<A>
  ): Promise<A> => {
    const { includeSlot: _, ...plain } = input;
    if (!supported) return call(plain);
    try {
      return await call({ ...plain, includeSlot: true });
    } catch (error) {
      if (!rejectsOptionalField(error, 'includeSlot')) throw error;
      supported = false;
      return call(plain);
    }
  };
}
/**
 * Ask `e2eeMachinePairing.complete` to inline the machine's `bootstrap` authorization
 * snapshot so pairing completion followed by startup does not need a second query.
 */
export function makeInlineMachineComplete() {
  let supported = true;
  return async <A>(
    input: E2eeMachinePairingRequests['complete'],
    call: (input: E2eeMachinePairingRequests['complete']) => Promise<A>
  ): Promise<A> => {
    const { includeBootstrap: _, ...plain } = input;
    if (!supported) return call(plain);
    try {
      return await call({ ...plain, includeBootstrap: true });
    } catch (error) {
      if (!rejectsOptionalField(error, 'includeBootstrap')) throw error;
      supported = false;
      return call(plain);
    }
  };
}
const BATCH_STATUS_MAX_SLOTS = 100;
const rejectsBatchStatus = (error: unknown) => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /Could not find public function|ArgumentValidationError/.test(message);
};
export type BatchMailboxStatusCallbacks = {
  single: (input: E2eeMailboxRequests['status']) => Promise<E2eeMailboxStatus>;
  batch: (input: E2eeMailboxRequests['batchStatus']) => Promise<E2eeMailboxStatus[]>;
};
/**
 * Microtask coalescer per `(workspaceId, credential)` that batches concurrent
 * `e2eeMailbox.status` calls (such as `KeyDistributor` checking multiple recipients)
 * into `e2eeMailbox.batchStatus`, while keeping a single status call on `status`.
 */
export function makeBatchMailboxStatus() {
  let batchSupported = true;
  type Waiter = {
    resolve: (value: E2eeMailboxStatus) => void;
    reject: (reason?: unknown) => void;
  };
  type Entry = {
    slot: E2eeMailboxSlot;
    waiters: Waiter[];
    callbacks: BatchMailboxStatusCallbacks;
  };
  type Bucket = {
    access: E2eeDeviceAccess;
    slots: Map<string, Entry>;
  };
  const buckets = new Map<string, Bucket>();
  const accessKey = (access: E2eeDeviceAccess) =>
    `${access.workspaceId}\0${access.credential}\0${access.cliToken ?? ''}`;
  const slotKey = (slot: E2eeMailboxSlot) => `${slot.genesis}\0${slot.epoch}\0${slot.recipient}`;
  const runSingleEntry = (access: E2eeDeviceAccess, entry: Entry) =>
    entry.callbacks.single({ ...access, slot: entry.slot }).then(
      (result) => {
        for (const waiter of entry.waiters) waiter.resolve(result);
      },
      (error) => {
        for (const waiter of entry.waiters) waiter.reject(error);
      }
    );
  const flushBucket = async (key: string) => {
    const bucket = buckets.get(key);
    if (!bucket) return;
    buckets.delete(key);
    const entries = [...bucket.slots.entries()];
    if (entries.length === 0) return;
    const { access } = bucket;
    if (entries.length === 1 || !batchSupported) {
      await Promise.all(entries.map(([, entry]) => runSingleEntry(access, entry)));
      return;
    }
    const chunks: Array<Array<[string, Entry]>> = [];
    for (let i = 0; i < entries.length; i += BATCH_STATUS_MAX_SLOTS) {
      chunks.push(entries.slice(i, i + BATCH_STATUS_MAX_SLOTS));
    }
    try {
      const results = await Promise.all(
        chunks.map(async (chunk) => {
          const reply = await chunk[0]![1].callbacks.batch({
            ...access,
            slots: chunk.map(([, entry]) => entry.slot),
          });
          return { chunk, reply };
        })
      );
      for (const { chunk, reply } of results) {
        const bySlot = new Map<string, E2eeMailboxStatus>();
        for (const item of reply) bySlot.set(slotKey(item), item);
        for (const [entryKey, entry] of chunk) {
          const found = bySlot.get(entryKey);
          if (found) {
            for (const waiter of entry.waiters) waiter.resolve(found);
          } else {
            const missingError = new Error('e2ee_mailbox_batch_status_missing_slot');
            for (const waiter of entry.waiters) waiter.reject(missingError);
          }
        }
      }
    } catch (error) {
      if (!rejectsBatchStatus(error)) {
        for (const [, entry] of entries) {
          for (const waiter of entry.waiters) waiter.reject(error);
        }
        return;
      }
      batchSupported = false;
      await Promise.all(entries.map(([, entry]) => runSingleEntry(access, entry)));
    }
  };
  return (
    input: E2eeMailboxRequests['status'],
    callbacks: BatchMailboxStatusCallbacks
  ): Promise<E2eeMailboxStatus> => {
    const access: E2eeDeviceAccess = {
      workspaceId: input.workspaceId,
      credential: input.credential,
      ...(input.cliToken === undefined ? {} : { cliToken: input.cliToken }),
    };
    const key = accessKey(access);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { access, slots: new Map() };
      buckets.set(key, bucket);
      queueMicrotask(() => {
        void flushBucket(key);
      });
    }
    const sKey = slotKey(input.slot);
    let entry = bucket.slots.get(sKey);
    if (!entry) {
      entry = { slot: input.slot, waiters: [], callbacks };
      bucket.slots.set(sKey, entry);
    }
    return new Promise<E2eeMailboxStatus>((resolve, reject) => {
      entry.waiters.push({ resolve, reject });
    });
  };
}
/**
 * Short-lived in-memory status cache for a mailbox adapter so consecutive
 * `KeyReceiver.status(self)` reads within one operation avoid duplicate RTTs
 * while immediately invalidating on `put`, `report`, and `repair`.
 */
export function makeMailboxStatusCache(options?: {
  ttlMs?: number;
  now?: () => number;
  maxEntries?: number;
}) {
  const ttlMs = options?.ttlMs ?? 1000;
  const now = options?.now ?? (() => performance.now());
  const maxEntries = options?.maxEntries ?? 512;
  const cache = new Map<string, { value: E2eeMailboxStatus; at: number }>();
  const prefixOf = (access: E2eeDeviceAccess) =>
    `${access.workspaceId}\0${access.credential}\0${access.cliToken ?? ''}\0`;
  const keyOf = (access: E2eeDeviceAccess, slot: E2eeMailboxSlot) =>
    `${prefixOf(access)}${slot.genesis}\0${slot.epoch}\0${slot.recipient}`;
  return {
    get: (access: E2eeDeviceAccess, slot: E2eeMailboxSlot): E2eeMailboxStatus | undefined => {
      const key = keyOf(access, slot);
      const entry = cache.get(key);
      if (!entry) return undefined;
      const age = now() - entry.at;
      if (age >= 0 && age < ttlMs) return entry.value;
      cache.delete(key);
      return undefined;
    },
    set: (access: E2eeDeviceAccess, value: E2eeMailboxStatus) => {
      const key = keyOf(access, value);
      if (cache.size >= maxEntries && !cache.has(key)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { value, at: now() });
    },
    invalidateSlot: (access: E2eeDeviceAccess, slot: E2eeMailboxSlot) => {
      cache.delete(keyOf(access, slot));
    },
    invalidateAccess: (access: E2eeDeviceAccess) => {
      const prefix = prefixOf(access);
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    },
    clear: () => {
      cache.clear();
    },
  };
}

/** Server-selected display terms. Checkout remains authoritative. */
export interface ReferralPolicy {
  campaignId: string;
  discountPercent: number;
  rewardPercent: number;
  startsAt?: number;
  endsAt?: number;
  nextChangeAt?: number;
}

export interface ReferralOverview {
  policy?: ReferralPolicy;
  eligible: boolean;
  code: string | null;
  url: string | null;
  issued: number;
  spent: number;
  available: number;
  frozen: number;
  adjustment: number;
  newcomerDiscount: boolean;
}
/**
 * Whether a first checkout now would get the newcomer discount. `sendCode`: pass the
 * stored referral code to checkout. `bound`: the workspace already holds a referral.
 */
export interface ReferralCheckoutOffer {
  policy?: ReferralPolicy;
  /** A previously opened Checkout retains its own terms until its deadline. */
  retained?: { policy: ReferralPolicy; expiresAt: number };
  discount: boolean;
  sendCode: boolean;
  bound: boolean;
}
export interface ReferralLedgerEntry {
  id: string;
  kind: 'reward' | 'adjustment' | 'freeze' | 'use' | 'release';
  amount: number;
  frozen: number;
  createdAt: number;
}

/**
 * An account security event: only its kind and time. The client chooses where to send
 * the user; the service never supplies a destination. Unknown kinds are ignored.
 */
export type E2eeAccountSecurityEvent = {
  id: string;
  kind: 'vault_replacement_reserved' | 'vault_replacement_finished' | 'personal_device_recovered';
  occurredAt: number;
};

/** Additive protocol: V1's success token and rejection contract remain unchanged. */
export type ShortcutTokenRequest = {
  workspaceId: string;
  target:
    | { kind: 'index'; ownerUserId: string; visibility: 'private' | 'workspace' }
    | { kind: 'body'; bodyDocId: string };
  write: boolean;
};
export type ShortcutTokenFailure = {
  kind: 'denied' | 'retryable' | 'fatal';
  code:
    | 'unauthenticated'
    | 'forbidden'
    | 'account_deletion'
    | 'workspace_deletion'
    | 'e2ee_control_only'
    | 'workspace_mode_unclassified'
    | 'workspace_mode_unsupported'
    | 'workspace_not_found'
    | 'published_body_immutable'
    | 'authorization_changed'
    | 'exchange_unavailable'
    | 'exchange_rejected'
    | 'exchange_invalid'
    | 'exchange_not_configured'
    | 'token_expired';
  phase: 'authorize' | 'register' | 'exchange' | 'reauthorize' | 'delivery';
  status?: number;
};
export type ShortcutTokenGrant = {
  token: string;
  expiresIn: number;
  gatewayBaseUrl: string;
  streamId: string;
};
export type ShortcutTokenReply =
  | { ok: true; grant: ShortcutTokenGrant }
  | { ok: false; failure: ShortcutTokenFailure };
