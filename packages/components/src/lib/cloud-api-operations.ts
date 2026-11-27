import { z } from 'zod';
import {
  decodeExternalList,
  decodeExternalObject,
  formatBoundaryDecodeDiagnostic,
  type BoundaryDecodeDiagnostic,
} from '@lody/shared/boundary-decode';
import { recordClientLog } from './client-log';
import type { PushRegistration } from './push-notifications';
import {
  defineCloudAction,
  defineCloudMutation,
  defineCloudQuery,
  definePublicCloudQuery,
  type CloudAction,
  type CloudMutation,
  type CloudOperationDecoder,
  type CloudQuery,
  type PlatformCapability,
} from '@lody/platform';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import type { MachinePairingView } from '@lody/shared';

type ConvexApi = typeof import('@lody/cloud-api').api;

type QueryDescriptor<Reference extends FunctionReference<'query'>> = CloudQuery<
  FunctionArgs<Reference>,
  FunctionReturnType<Reference>
>;
type MutationDescriptor<Reference extends FunctionReference<'mutation'>> = CloudMutation<
  FunctionArgs<Reference>,
  FunctionReturnType<Reference>
>;
type ActionDescriptor<Reference extends FunctionReference<'action'>> = CloudAction<
  FunctionArgs<Reference>,
  FunctionReturnType<Reference>
>;

export type InvitationPreview =
  | { status: 'unavailable' }
  | {
      status: 'available';
      organizationName: string;
      inviterName: string | null;
      recipientEmailMasked: string;
      recipientMatchesSession: boolean | null;
      role: string;
    };

export type WorkspaceJoinLinkPreview =
  | { status: 'unavailable' }
  | {
      status: 'available';
      workspaceName: string;
      workspaceSlug: string | null;
      expiresAt: number;
      viewer: null | {
        email: string;
        emailVerified: boolean;
        alreadyMember: boolean;
        request: null | {
          status: 'pending' | 'approved' | 'rejected';
          reason: string;
        };
      };
    };

export interface WorkspaceJoinOwnerState {
  /** Optional roster change marker; older servers omit it. Not a permission grant. */
  membershipVersion?: string;
  activeLink: null | { id: string; token: string; expiresAt: number };
  pendingRequests: Array<{
    id: string;
    applicantName: string;
    applicantEmail: string;
    reason: string;
    createdAt: number;
  }>;
  hasMorePendingRequests: boolean;
}

export interface CloudInboxItem {
  _id: string;
  kind: 'session_completed' | 'permission_requested' | 'sharing_review';
  title?: string;
  route?: string;
  requestKind?: 'permission' | 'ask_user_question';
  toolLabel?: string;
  updatedAt: number;
  readAt?: number;
}

export interface SharingReviewState {
  active: boolean;
  sourceRevision: string | null;
  reconcileWriterId: string | null;
  reconcileAttempt: number | null;
}

export interface SharingReviewReconcileResult extends SharingReviewState {
  conflict: boolean;
}

function capabilityForOperation(name: string): PlatformCapability {
  if (
    name.startsWith('e2eeWorkspaces:') ||
    name.startsWith('e2eeMembers:') ||
    // Personal device pairing relays: account-scoped, never on local composition.
    name.startsWith('e2eeAccountPairing:') ||
    name.startsWith('e2eeAutomaticPairing:') ||
    name.startsWith('e2eeJoinMailbox:')
  )
    return 'multiWorkspace';
  if (name.startsWith('workspaceMembers:')) return 'teamSharing';
  if (name.startsWith('e2eeMachineSharing:')) return 'teamSharing';
  if (name.startsWith('promptShortcuts:')) return 'cloudAccount';
  if (name.startsWith('billing:') || name.startsWith('referrals:')) return 'billing';
  if (name.startsWith('usage:')) return 'usageAnalytics';
  if (name.startsWith('github:') || name.startsWith('githubPersonalAuthorization:'))
    return 'githubIntegration';
  if (name.startsWith('activity:')) return 'telemetry';
  if (name.startsWith('deviceAuth:') || name === 'auth:getUserById') return 'cloudAccount';
  if (name.startsWith('auth:')) return 'multiWorkspace';
  if (name.startsWith('machineCredentials:') || name.startsWith('machinePairing:')) {
    return 'remoteMachines';
  }
  if (name === 'machines:listSessionAccess' || name === 'machines:setSessionReadSharedWithTeam')
    return 'teamSharing';
  if (name === 'machines:setMachineSharedWithTeam') return 'teamSharing';
  if (name.startsWith('machines:')) return 'remoteMachines';
  if (name.startsWith('localProjects:') || name.startsWith('sessionSharing:')) return 'teamSharing';
  throw new Error(`Cloud operation ${JSON.stringify(name)} has no capability assignment`);
}

function reportCloudBoundaryDiagnostic(diagnostic: BoundaryDecodeDiagnostic): void {
  const summary = formatBoundaryDecodeDiagnostic(diagnostic);
  console.warn(`[CloudBoundary] ${summary}`);
  recordClientLog('warn', 'boundary.decode', summary, {
    boundary: diagnostic.boundary,
    kind: diagnostic.kind,
    droppedCount: diagnostic.droppedCount,
    totalCount: diagnostic.totalCount,
    issueCount: diagnostic.issueCount,
  });
}

function listDecoder<T>(boundary: string, itemSchema: z.ZodType<T>): CloudOperationDecoder<T[]> {
  return (raw) => {
    const decoded = decodeExternalList(boundary, itemSchema, raw, {
      onDiagnostic: reportCloudBoundaryDiagnostic,
    });
    return decoded.ok ? { ok: true, data: decoded.data } : decoded;
  };
}

function objectDecoder<T>(boundary: string, schema: z.ZodType<T>): CloudOperationDecoder<T> {
  return (raw) =>
    decodeExternalObject(boundary, schema, raw, {
      onDiagnostic: reportCloudBoundaryDiagnostic,
    });
}

const E2eeMemberWorkspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    slug: z.string(),
    contentMode: z.literal('e2ee'),
    contentModeVersion: z.number(),
    cryptoOrgId: z.string(),
    genesisHash: z.string(),
    role: z.enum(['owner', 'admin', 'member', 'guest']),
    members: z.array(
      z
        .object({
          id: z.string().min(1),
          userId: z.string().min(1),
          role: z.string(),
          user: z
            .object({
              id: z.string().min(1),
              name: z.string(),
              email: z.string(),
              image: z.string().optional(),
            })
            .passthrough(),
        })
        .passthrough()
    ),
  })
  .passthrough();

const WorkspaceDirectoryMemberSchema = z
  .object({
    userId: z.string().min(1),
    name: z.string().nullable(),
    image: z.string().nullable(),
  })
  .passthrough();

const VisibleLocalProjectSchema = z
  .object({
    machineId: z.string().min(1),
    localProjectId: z.string().min(1),
    ownerUserId: z.string().min(1),
    sharedWithTeam: z.boolean(),
    updatedAt: z.number(),
  })
  .passthrough();

const VisibleMachineSchema = z
  .object({
    machineId: z.string().min(1),
    ownerUserId: z.string().min(1),
    sharedWithTeam: z.boolean(),
    updatedAt: z.number(),
  })
  .passthrough();

const MachineSessionAccessSchema = z
  .object({
    machineId: z.string().min(1),
    readSharedSessionIds: z.array(z.string()),
    canManage: z.boolean(),
  })
  .passthrough();

const CloudInboxItemSchema = z
  .object({
    _id: z.string().min(1),
    kind: z.enum(['session_completed', 'permission_requested', 'sharing_review']),
    title: z.string().optional(),
    route: z.string().optional(),
    requestKind: z.enum(['permission', 'ask_user_question']).optional(),
    toolLabel: z.string().optional(),
    updatedAt: z.number(),
    readAt: z.number().optional(),
  })
  .passthrough();

const WorkspaceAccessSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unauthenticated') }).passthrough(),
  z.object({ status: z.literal('not_found') }).passthrough(),
  z
    .object({
      status: z.literal('not_member'),
      organizationId: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      status: z.literal('member'),
      organizationId: z.string().min(1),
    })
    .passthrough(),
]);

const InvitationPreviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unavailable') }).passthrough(),
  z
    .object({
      status: z.literal('available'),
      organizationName: z.string(),
      inviterName: z.string().nullable(),
      recipientEmailMasked: z.string(),
      recipientMatchesSession: z.boolean().nullable(),
      role: z.string(),
    })
    .passthrough(),
]);

const WorkspaceJoinLinkPreviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unavailable') }).passthrough(),
  z
    .object({
      status: z.literal('available'),
      workspaceName: z.string(),
      workspaceSlug: z.string().nullable(),
      expiresAt: z.number(),
      viewer: z
        .object({
          email: z.string(),
          emailVerified: z.boolean(),
          alreadyMember: z.boolean(),
          request: z
            .object({
              status: z.enum(['pending', 'approved', 'rejected']),
              reason: z.string(),
            })
            .passthrough()
            .nullable(),
        })
        .passthrough()
        .nullable(),
    })
    .passthrough(),
]);

const query = <Reference extends FunctionReference<'query'>>(
  name: string,
  decode?: CloudOperationDecoder<FunctionReturnType<Reference>>
): QueryDescriptor<Reference> =>
  defineCloudQuery<FunctionArgs<Reference>, FunctionReturnType<Reference>>(
    capabilityForOperation(name),
    name,
    decode
  );

const mutation = <Reference extends FunctionReference<'mutation'>>(
  name: string
): MutationDescriptor<Reference> =>
  defineCloudMutation<FunctionArgs<Reference>, FunctionReturnType<Reference>>(
    capabilityForOperation(name),
    name
  );

const action = <Reference extends FunctionReference<'action'>>(
  name: string
): ActionDescriptor<Reference> =>
  defineCloudAction<FunctionArgs<Reference>, FunctionReturnType<Reference>>(
    capabilityForOperation(name),
    name
  );

/**
 * Public cloud operation catalogue consumed by shared UI. This is the single
 * Runtime values contain only stable operation names. DTOs come from the
 * public cloud client contract, never from generated server API declarations.
 */
export const cloudOperations = {
  analytics: {
    getUsageSharing: defineCloudQuery<Record<string, never>, boolean>(
      'telemetry',
      'analytics:getUsageSharing'
    ),
    setUsageSharing: defineCloudMutation<{ enabled: boolean }, null>(
      'telemetry',
      'analytics:setUsageSharing'
    ),
  },
  e2eeMachineSharing: {
    listVersions: query<ConvexApi['e2eeMachineSharing']['listVersions']>(
      'e2eeMachineSharing:listVersions'
    ),
  },
  /** Account-wide pairing relay for portable hosts. Opaque bytes; hosts verify every tag. */
  e2eeAccountPairing: {
    submit: mutation<ConvexApi['e2eeAccountPairing']['submit']>('e2eeAccountPairing:submit'),
    pending: query<ConvexApi['e2eeAccountPairing']['pending']>('e2eeAccountPairing:pending'),
    read: query<ConvexApi['e2eeAccountPairing']['read']>('e2eeAccountPairing:read'),
    decline: mutation<ConvexApi['e2eeAccountPairing']['decline']>('e2eeAccountPairing:decline'),
    publish: mutation<ConvexApi['e2eeAccountPairing']['publish']>('e2eeAccountPairing:publish'),
    claim: query<ConvexApi['e2eeAccountPairing']['claim']>('e2eeAccountPairing:claim'),
  },
  /** Per-workspace personal join mailbox, for a portable `PersonalHostRemote`. */
  e2eeJoinMailbox: {
    begin: mutation<ConvexApi['e2eeJoinMailbox']['begin']>('e2eeJoinMailbox:begin'),
    status: query<ConvexApi['e2eeJoinMailbox']['status']>('e2eeJoinMailbox:status'),
    readRequest: query<ConvexApi['e2eeJoinMailbox']['readRequest']>('e2eeJoinMailbox:readRequest'),
    cancel: mutation<ConvexApi['e2eeJoinMailbox']['cancel']>('e2eeJoinMailbox:cancel'),
    publish: mutation<ConvexApi['e2eeJoinMailbox']['publish']>('e2eeJoinMailbox:publish'),
    claim: query<ConvexApi['e2eeJoinMailbox']['claim']>('e2eeJoinMailbox:claim'),
  },
  e2eeMembers: {
    claim: query<ConvexApi['e2eeMembers']['claim']>('e2eeMembers:claim'),
    pending: query<ConvexApi['e2eeMembers']['pending']>('e2eeMembers:pending'),
    workspaces: query<ConvexApi['e2eeMembers']['workspaces']>(
      'e2eeMembers:workspaces',
      listDecoder('convex.e2eeMembers.workspaces', E2eeMemberWorkspaceSchema)
    ),
    preview: definePublicCloudQuery<
      import('@lody/cloud-api').E2eeMemberRequests['preview'],
      import('@lody/cloud-api').E2eeMemberReplies['preview']
    >('teamSharing', 'e2eeMembers:preview'),
  },
  e2eeAutomaticPairing: {
    pending: query<ConvexApi['e2eeAutomaticPairing']['pending']>('e2eeAutomaticPairing:pending'),
    read: query<ConvexApi['e2eeAutomaticPairing']['read']>('e2eeAutomaticPairing:read'),
    exchange: mutation<ConvexApi['e2eeAutomaticPairing']['exchange']>(
      'e2eeAutomaticPairing:exchange'
    ),
  },
  e2eeWorkspaces: {
    reportDeviceProfile: mutation<ConvexApi['e2eeWorkspaces']['reportDeviceProfile']>(
      'e2eeWorkspaces:reportDeviceProfile'
    ),
    ledgerHead: query<ConvexApi['e2eeWorkspaces']['ledgerHead']>('e2eeWorkspaces:ledgerHead'),
    memberProfiles: query<ConvexApi['e2eeWorkspaces']['memberProfiles']>(
      'e2eeWorkspaces:memberProfiles'
    ),
    create: action<ConvexApi['e2eeWorkspaces']['create']>('e2eeWorkspaces:create'),
    deleteWorkspace: action<ConvexApi['e2eeWorkspaces']['deleteWorkspace']>(
      'e2eeWorkspaces:deleteWorkspace'
    ),
    describe: query<ConvexApi['e2eeWorkspaces']['describe']>('e2eeWorkspaces:describe'),
    history: action<ConvexApi['e2eeWorkspaces']['history']>('e2eeWorkspaces:history'),
  },
  promptShortcuts: {
    getStreamTokenV2: action<ConvexApi['promptShortcuts']['getStreamTokenV2']>(
      'promptShortcuts:getStreamTokenV2'
    ),
    stageDocument: mutation<ConvexApi['promptShortcuts']['stageDocument']>(
      'promptShortcuts:stageDocument'
    ),
    activateDocument: mutation<ConvexApi['promptShortcuts']['activateDocument']>(
      'promptShortcuts:activateDocument'
    ),
    revokeShortcut: mutation<ConvexApi['promptShortcuts']['revokeShortcut']>(
      'promptShortcuts:revokeShortcut'
    ),
    settleDocument: mutation<ConvexApi['promptShortcuts']['settleDocument']>(
      'promptShortcuts:settleDocument'
    ),
    listAccessibleDocuments: query<ConvexApi['promptShortcuts']['listAccessibleDocuments']>(
      'promptShortcuts:listAccessibleDocuments'
    ),
    getStreamToken: action<ConvexApi['promptShortcuts']['getStreamToken']>(
      'promptShortcuts:getStreamToken'
    ),
  },
  sessionSharing: {
    listRequests: query<ConvexApi['sessionSharing']['listRequests']>('sessionSharing:listRequests'),
    cancelRequest: mutation<ConvexApi['sessionSharing']['cancelRequest']>(
      'sessionSharing:cancelRequest'
    ),
    list: query<ConvexApi['sessionSharing']['list']>('sessionSharing:list'),
    getManagement: query<ConvexApi['sessionSharing']['getManagement']>(
      'sessionSharing:getManagement'
    ),
    beginDeployment: mutation<ConvexApi['sessionSharing']['beginDeployment']>(
      'sessionSharing:beginDeployment'
    ),
    publishDeployment: mutation<ConvexApi['sessionSharing']['publishDeployment']>(
      'sessionSharing:publishDeployment'
    ),
    resetCredential: mutation<ConvexApi['sessionSharing']['resetCredential']>(
      'sessionSharing:resetCredential'
    ),
    revoke: mutation<ConvexApi['sessionSharing']['revoke']>('sessionSharing:revoke'),
  },
  activity: {
    recordMyWorkspaceDailyActiveUser: mutation<
      ConvexApi['activity']['recordMyWorkspaceDailyActiveUser']
    >('activity:recordMyWorkspaceDailyActiveUser'),
  },
  workspaceMembers: {
    list: query<ConvexApi['workspaceMembers']['list']>(
      'workspaceMembers:list',
      listDecoder('convex.workspaceMembers.list', WorkspaceDirectoryMemberSchema)
    ),
  },
  auth: {
    transferWorkspaceOwnership: mutation<ConvexApi['auth']['transferWorkspaceOwnership']>(
      'auth:transferWorkspaceOwnership'
    ),
    getInvitationPreview: definePublicCloudQuery<{ invitationId: string }, InvitationPreview>(
      'multiWorkspace',
      'auth:getInvitationPreview',
      objectDecoder('convex.auth.getInvitationPreview', InvitationPreviewSchema)
    ),
    getMyWorkspaceMembershipFingerprint: query<
      ConvexApi['auth']['getMyWorkspaceMembershipFingerprint']
    >('auth:getMyWorkspaceMembershipFingerprint'),
    getUserById: query<ConvexApi['auth']['getUserById']>('auth:getUserById'),
    getWorkspaceAccessBySlug: query<ConvexApi['auth']['getWorkspaceAccessBySlug']>(
      'auth:getWorkspaceAccessBySlug',
      objectDecoder('convex.auth.getWorkspaceAccessBySlug', WorkspaceAccessSchema)
    ),
    isWorkspaceSlugAvailable: query<ConvexApi['auth']['isWorkspaceSlugAvailable']>(
      'auth:isWorkspaceSlugAvailable'
    ),
  },
  pushSubscriptions: {
    configuration: defineCloudQuery<Record<string, never>, { selfHostedEnabled: boolean }>(
      'cloudAccount',
      'pushSubscriptions:configuration'
    ),
    register: defineCloudMutation<PushRegistration, null>(
      'cloudAccount',
      'pushSubscriptions:register'
    ),
    unregister: defineCloudMutation<{ installationId: string }, null>(
      'cloudAccount',
      'pushSubscriptions:unregister'
    ),
    sendTest: defineCloudMutation<Record<string, never>, { subscriptions: number }>(
      'cloudAccount',
      'pushSubscriptions:sendTest'
    ),
  },
  inbox: {
    listMine: defineCloudQuery<{ workspaceId: string; limit?: number }, CloudInboxItem[]>(
      'teamSharing',
      'inbox:listMine',
      listDecoder('convex.inbox.listMine', CloudInboxItemSchema)
    ),
    getSharingReviewState: defineCloudQuery<{ workspaceId: string }, SharingReviewState | null>(
      'teamSharing',
      'inbox:getSharingReviewState'
    ),
    reconcileSharingReview: defineCloudMutation<
      {
        workspaceId: string;
        active: boolean;
        sourceRevision: string;
        expectedSourceRevision: string | null;
        reconcileWriterId: string;
        reconcileAttempt: number;
      },
      SharingReviewReconcileResult
    >('teamSharing', 'inbox:reconcileSharingReview'),
    markRead: defineCloudMutation<{ itemId: string }, { updated: boolean }>(
      'teamSharing',
      'inbox:markRead'
    ),
    dismiss: defineCloudMutation<{ itemId: string }, { updated: boolean }>(
      'teamSharing',
      'inbox:dismiss'
    ),
    suppressSharingReview: defineCloudMutation<{ itemId: string }, { updated: boolean }>(
      'teamSharing',
      'inbox:suppressSharingReview'
    ),
  },
  referrals: {
    createLink: mutation<ConvexApi['referrals']['createLink']>('referrals:createLink'),
    getOverview: query<ConvexApi['referrals']['getOverview']>('referrals:getOverview'),
    listLedger: query<ConvexApi['referrals']['listLedger']>('referrals:listLedger'),
    getCheckoutOffer: query<ConvexApi['referrals']['getCheckoutOffer']>(
      'referrals:getCheckoutOffer'
    ),
    attachLead: mutation<ConvexApi['referrals']['attachLead']>('referrals:attachLead'),
    dismissLead: mutation<ConvexApi['referrals']['dismissLead']>('referrals:dismissLead'),
  },
  billing: {
    listDeletedWorkspaceBillingAccounts: query<
      ConvexApi['billing']['listDeletedWorkspaceBillingAccounts']
    >('billing:listDeletedWorkspaceBillingAccounts'),
    createBillingPortalSession: action<ConvexApi['billing']['createBillingPortalSession']>(
      'billing:createBillingPortalSession'
    ),
    createCheckoutSession: action<ConvexApi['billing']['createCheckoutSession']>(
      'billing:createCheckoutSession'
    ),
    createPaidWorkspaceCheckout: action<ConvexApi['billing']['createPaidWorkspaceCheckout']>(
      'billing:createPaidWorkspaceCheckout'
    ),
    getBillingOverview: query<ConvexApi['billing']['getBillingOverview']>(
      'billing:getBillingOverview'
    ),
    getMyNewWorkspacePricing: query<ConvexApi['billing']['getMyNewWorkspacePricing']>(
      'billing:getMyNewWorkspacePricing'
    ),
    getMyPaidWorkspacePlanTiers: query<ConvexApi['billing']['getMyPaidWorkspacePlanTiers']>(
      'billing:getMyPaidWorkspacePlanTiers'
    ),
    getWorkspaceBillingEntitlement: query<ConvexApi['billing']['getWorkspaceBillingEntitlement']>(
      'billing:getWorkspaceBillingEntitlement'
    ),
    getWorkspaceCreationAvailability: query<
      ConvexApi['billing']['getWorkspaceCreationAvailability']
    >('billing:getWorkspaceCreationAvailability'),
    getWorkspaceMemberLimitState: query<ConvexApi['billing']['getWorkspaceMemberLimitState']>(
      'billing:getWorkspaceMemberLimitState'
    ),
    getWorkspaceSeatInvitePreview: query<ConvexApi['billing']['getWorkspaceSeatInvitePreview']>(
      'billing:getWorkspaceSeatInvitePreview'
    ),
    purchaseWorkspaceMemberSeat: action<ConvexApi['billing']['purchaseWorkspaceMemberSeat']>(
      'billing:purchaseWorkspaceMemberSeat'
    ),
    getBillingInvoice: action<ConvexApi['billing']['getBillingInvoice']>(
      'billing:getBillingInvoice'
    ),
    cancelPendingSeatInvoice: action<ConvexApi['billing']['cancelPendingSeatInvoice']>(
      'billing:cancelPendingSeatInvoice'
    ),
    listBillingInvoices: action<ConvexApi['billing']['listBillingInvoices']>(
      'billing:listBillingInvoices'
    ),
    previewSubscriptionIntervalChange: action<
      ConvexApi['billing']['previewSubscriptionIntervalChange']
    >('billing:previewSubscriptionIntervalChange'),
    reconcileWorkspaceCheckout: action<ConvexApi['billing']['reconcileWorkspaceCheckout']>(
      'billing:reconcileWorkspaceCheckout'
    ),
    redeemStripePromotionCode: action<ConvexApi['billing']['redeemStripePromotionCode']>(
      'billing:redeemStripePromotionCode'
    ),
    setSubscriptionCancelAtPeriodEnd: action<
      ConvexApi['billing']['setSubscriptionCancelAtPeriodEnd']
    >('billing:setSubscriptionCancelAtPeriodEnd'),
    getSubscriptionPaymentStatus: action<ConvexApi['billing']['getSubscriptionPaymentStatus']>(
      'billing:getSubscriptionPaymentStatus'
    ),
    setSubscriptionInterval: action<ConvexApi['billing']['setSubscriptionInterval']>(
      'billing:setSubscriptionInterval'
    ),
  },
  github: {
    createGitHubInstallState: action<ConvexApi['github']['createGitHubInstallState']>(
      'github:createGitHubInstallState'
    ),
    beginPersonalAuthorization: action<ConvexApi['githubPersonalAuthorization']['begin']>(
      'githubPersonalAuthorization:begin'
    ),
    completePersonalAuthorization: action<ConvexApi['githubPersonalAuthorization']['complete']>(
      'githubPersonalAuthorization:complete'
    ),
    getPersonalOperationSettings: query<ConvexApi['github']['getPersonalOperationSettings']>(
      'github:getPersonalOperationSettings'
    ),
    getPrCacheVersions: query<ConvexApi['github']['getPrCacheVersions']>(
      'github:getPrCacheVersions'
    ),
    resolveLegacyPrRepositoryIdentity: mutation<
      ConvexApi['github']['resolveLegacyPrRepositoryIdentity']
    >('github:resolveLegacyPrRepositoryIdentity'),
    getWorkspaceRepositories: query<ConvexApi['github']['getWorkspaceRepositories']>(
      'github:getWorkspaceRepositories'
    ),
    listWorkspaceReposWithStatus: query<ConvexApi['github']['listWorkspaceReposWithStatus']>(
      'github:listWorkspaceReposWithStatus'
    ),
    refreshPersonalGitHubProfile: action<ConvexApi['github']['refreshPersonalGitHubProfile']>(
      'github:refreshPersonalGitHubProfile'
    ),
    removeRepoFromWorkspace: mutation<ConvexApi['github']['removeRepoFromWorkspace']>(
      'github:removeRepoFromWorkspace'
    ),
    setPersonalOperationPreference: mutation<ConvexApi['github']['setPersonalOperationPreference']>(
      'github:setPersonalOperationPreference'
    ),
    setRepoEnabled: mutation<ConvexApi['github']['setRepoEnabled']>('github:setRepoEnabled'),
    setRepoWorktreeCleanup: mutation<ConvexApi['github']['setRepoWorktreeCleanup']>(
      'github:setRepoWorktreeCleanup'
    ),
    setRepoWorktreeSetup: mutation<ConvexApi['github']['setRepoWorktreeSetup']>(
      'github:setRepoWorktreeSetup'
    ),
  },
  localProjects: {
    listVisibleLocalProjects: query<ConvexApi['localProjects']['listVisibleLocalProjects']>(
      'localProjects:listVisibleLocalProjects',
      listDecoder('convex.localProjects.listVisibleLocalProjects', VisibleLocalProjectSchema)
    ),
    setLocalProjectSharedWithTeam: mutation<
      ConvexApi['localProjects']['setLocalProjectSharedWithTeam']
    >('localProjects:setLocalProjectSharedWithTeam'),
  },
  machineCredentials: {
    getMachineCredentialState: query<ConvexApi['machineCredentials']['getMachineCredentialState']>(
      'machineCredentials:getMachineCredentialState'
    ),
    revokeMachineCredentials: mutation<ConvexApi['machineCredentials']['revokeMachineCredentials']>(
      'machineCredentials:revokeMachineCredentials'
    ),
  },
  machinePairing: {
    cancelRequest: defineCloudMutation<{ requestId: string }, { success: true }>(
      'remoteMachines',
      'machinePairing:cancelRequest'
    ),
    claimFromDesktop: mutation<ConvexApi['machinePairing']['claimFromDesktop']>(
      'machinePairing:claimFromDesktop'
    ),
    getRequest: defineCloudQuery<{ requestId: string }, MachinePairingView | null>(
      'remoteMachines',
      'machinePairing:getRequest'
    ),
  },
  machines: {
    listSessionAccess: query<ConvexApi['machines']['listSessionAccess']>(
      'machines:listSessionAccess',
      listDecoder('convex.machines.listSessionAccess', MachineSessionAccessSchema)
    ),
    setSessionReadSharedWithTeam: mutation<ConvexApi['machines']['setSessionReadSharedWithTeam']>(
      'machines:setSessionReadSharedWithTeam'
    ),
    listVisibleMachines: query<ConvexApi['machines']['listVisibleMachines']>(
      'machines:listVisibleMachines',
      listDecoder('convex.machines.listVisibleMachines', VisibleMachineSchema)
    ),
    setMachineSharedWithTeam: mutation<ConvexApi['machines']['setMachineSharedWithTeam']>(
      'machines:setMachineSharedWithTeam'
    ),
  },
  usage: {
    getWorkspaceUsageCalendar: query<ConvexApi['usage']['getWorkspaceUsageCalendar']>(
      'usage:getWorkspaceUsageCalendar'
    ),
    getWorkspaceUsageDay: query<ConvexApi['usage']['getWorkspaceUsageDay']>(
      'usage:getWorkspaceUsageDay'
    ),
    getWorkspaceUsageSummary: query<ConvexApi['usage']['getWorkspaceUsageSummary']>(
      'usage:getWorkspaceUsageSummary'
    ),
    getWorkspaceUsageTimeline: query<ConvexApi['usage']['getWorkspaceUsageTimeline']>(
      'usage:getWorkspaceUsageTimeline'
    ),
  },
  workspaceJoinRequests: {
    getLinkPreview: definePublicCloudQuery<{ token: string }, WorkspaceJoinLinkPreview>(
      'teamSharing',
      'workspaceJoinRequests:getLinkPreview',
      objectDecoder('convex.workspaceJoinRequests.getLinkPreview', WorkspaceJoinLinkPreviewSchema)
    ),
    getOwnerState: defineCloudQuery<{ workspaceId: string }, WorkspaceJoinOwnerState>(
      'teamSharing',
      'workspaceJoinRequests:getOwnerState'
    ),
    rotateLink: defineCloudMutation<
      { workspaceId: string; expiresInDays: number },
      { id: string; token: string; expiresAt: number }
    >('teamSharing', 'workspaceJoinRequests:rotateLink'),
    revokeLink: defineCloudMutation<{ workspaceId: string; linkId: string }, null>(
      'teamSharing',
      'workspaceJoinRequests:revokeLink'
    ),
    submitRequest: defineCloudMutation<
      { token: string; reason: string },
      { id: string; status: 'pending'; existing: boolean }
    >('teamSharing', 'workspaceJoinRequests:submitRequest'),
    reviewRequest: defineCloudMutation<
      { requestId: string; decision: 'approved' | 'rejected' },
      { status: 'rejected' } | { status: 'approved'; alreadyMember: boolean }
    >('teamSharing', 'workspaceJoinRequests:reviewRequest'),
  },
} as const;
