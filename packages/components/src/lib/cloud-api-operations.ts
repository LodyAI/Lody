import {
  defineCloudAction,
  defineCloudMutation,
  defineCloudQuery,
  definePublicCloudQuery,
  type CloudAction,
  type CloudMutation,
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
  if (name.startsWith('promptShortcuts:')) return 'cloudAccount';
  if (name.startsWith('billing:')) return 'billing';
  if (name.startsWith('usage:')) return 'usageAnalytics';
  if (name.startsWith('github:')) return 'githubIntegration';
  if (name.startsWith('activity:')) return 'telemetry';
  if (name.startsWith('deviceAuth:') || name === 'auth:getUserById') return 'cloudAccount';
  if (name.startsWith('auth:')) return 'multiWorkspace';
  if (name.startsWith('machineCredentials:') || name.startsWith('machinePairing:')) {
    return 'remoteMachines';
  }
  if (name === 'machines:setMachineSharedWithTeam') return 'teamSharing';
  if (name.startsWith('machines:')) return 'remoteMachines';
  if (name.startsWith('localProjects:')) return 'teamSharing';
  throw new Error(`Cloud operation ${JSON.stringify(name)} has no capability assignment`);
}

const query = <Reference extends FunctionReference<'query'>>(
  name: string
): QueryDescriptor<Reference> =>
  defineCloudQuery<FunctionArgs<Reference>, FunctionReturnType<Reference>>(
    capabilityForOperation(name),
    name
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
  promptShortcuts: {
    stageDocument: mutation<ConvexApi['promptShortcuts']['stageDocument']>(
      'promptShortcuts:stageDocument'
    ),
    activateDocument: mutation<ConvexApi['promptShortcuts']['activateDocument']>(
      'promptShortcuts:activateDocument'
    ),
    revokeShortcut: mutation<ConvexApi['promptShortcuts']['revokeShortcut']>(
      'promptShortcuts:revokeShortcut'
    ),
    listAccessibleDocuments: query<ConvexApi['promptShortcuts']['listAccessibleDocuments']>(
      'promptShortcuts:listAccessibleDocuments'
    ),
    getStreamToken: action<ConvexApi['promptShortcuts']['getStreamToken']>(
      'promptShortcuts:getStreamToken'
    ),
  },
  activity: {
    recordMyWorkspaceDailyActiveUser: mutation<
      ConvexApi['activity']['recordMyWorkspaceDailyActiveUser']
    >('activity:recordMyWorkspaceDailyActiveUser'),
  },
  auth: {
    getInvitationPreview: definePublicCloudQuery<{ invitationId: string }, InvitationPreview>(
      'multiWorkspace',
      'auth:getInvitationPreview'
    ),
    getMyWorkspaceMembershipFingerprint: query<
      ConvexApi['auth']['getMyWorkspaceMembershipFingerprint']
    >('auth:getMyWorkspaceMembershipFingerprint'),
    getUserById: query<ConvexApi['auth']['getUserById']>('auth:getUserById'),
    getWorkspaceAccessBySlug: query<ConvexApi['auth']['getWorkspaceAccessBySlug']>(
      'auth:getWorkspaceAccessBySlug'
    ),
    isWorkspaceSlugAvailable: query<ConvexApi['auth']['isWorkspaceSlugAvailable']>(
      'auth:isWorkspaceSlugAvailable'
    ),
  },
  inbox: {
    listMine: defineCloudQuery<{ workspaceId: string; limit?: number }, CloudInboxItem[]>(
      'teamSharing',
      'inbox:listMine'
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
  billing: {
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
    setSubscriptionInterval: action<ConvexApi['billing']['setSubscriptionInterval']>(
      'billing:setSubscriptionInterval'
    ),
  },
  github: {
    createGitHubInstallState: action<ConvexApi['github']['createGitHubInstallState']>(
      'github:createGitHubInstallState'
    ),
    getPersonalOperationSettings: query<ConvexApi['github']['getPersonalOperationSettings']>(
      'github:getPersonalOperationSettings'
    ),
    getPrCacheVersions: query<ConvexApi['github']['getPrCacheVersions']>(
      'github:getPrCacheVersions'
    ),
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
      'localProjects:listVisibleLocalProjects'
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
    listVisibleMachines: query<ConvexApi['machines']['listVisibleMachines']>(
      'machines:listVisibleMachines'
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
      'workspaceJoinRequests:getLinkPreview'
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
