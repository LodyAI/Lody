import type { Meta, StoryObj } from '@storybook/react';
import { E2eeMemberJoin } from '@/components/pages/e2ee-member-join';
import { E2eeTeamSettings } from '@/components/settings/e2ee-team-settings';
import type { E2eeMemberOffer, E2eeMemberReplies } from '@lody/cloud-api';
const offer: E2eeMemberOffer = {
  version: 1,
  workspaceId: 'synthetic-team',
  genesisHash: '11'.repeat(32),
  genesisRecordHex: 'abcd',
  endorser: '22'.repeat(32),
  token: '33'.repeat(32),
  mode: 'email',
  expiresAt: Date.parse('2026-10-30T12:00:00Z'),
};
const request = {
  id: 'synthetic-request',
  workspaceId: offer.workspaceId,
  accountId: 'synthetic-account',
  keyPackageHex: 'abcd',
  signingPublicKey: '44'.repeat(32),
  requestId: '55'.repeat(16),
  source: 'email' as const,
  state: 'pending' as const,
  expiresAt: offer.expiresAt,
};
const meta = {
  title: 'Components/E2eeTeamJoining',
  component: E2eeMemberJoin,
  args: {
    offer,
    accountId: 'synthetic-account',
    email: 'riley@example.test',
    emailVerified: true,
    preview: {
      status: 'available' as const,
      offer,
      workspaceName: 'Cipher Lab',
      workspaceSlug: 'cipher-lab',
      recipientEmailMasked: 'r***@example.test',
      matchesRecipient: true,
    },
    runtime: {
      prepareMemberJoin: async () => request,
      pendingMemberJoin: async () => null,
      claimMemberJoin: async () => ({ ready: false, state: 'pending' }),
    },
    onSignInRequested: () => {},
    onEmailVerificationRequested: () => {},
    onWorkspaceRequested: () => {},
    onHomeRequested: () => {},
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof E2eeMemberJoin>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EmailInvitation: Story = {};
export const WaitingForAdminDevice: Story = {
  args: {
    runtime: {
      ...meta.args.runtime,
      pendingMemberJoin: async () => ({ offer, requestId: request.requestId }),
    },
  },
};
const linkOffer = { ...offer, token: '77'.repeat(32), mode: 'link' as const };
export const WaitingForApproval: Story = {
  args: {
    offer: linkOffer,
    preview: {
      ...meta.args.preview,
      offer: linkOffer,
      recipientEmailMasked: null,
      matchesRecipient: null,
    },
    runtime: {
      ...meta.args.runtime,
      pendingMemberJoin: async () => ({ offer: linkOffer, requestId: request.requestId }),
    },
  },
};
export const WaitingForKey: Story = {
  args: {
    runtime: {
      ...meta.args.runtime,
      pendingMemberJoin: async () => ({ offer, requestId: request.requestId }),
      claimMemberJoin: async () => ({ ready: false, state: 'committed' }),
    },
  },
};
export const Ready: Story = {
  args: {
    runtime: {
      ...meta.args.runtime,
      pendingMemberJoin: async () => ({ offer, requestId: request.requestId }),
      claimMemberJoin: async () => ({ ready: true, state: 'committed' }),
    },
  },
};
export const DesktopHandoff: Story = { args: { runtime: undefined } };
const pending: E2eeMemberReplies['pending'] = {
  items: [
    {
      ...request,
      source: 'link',
      applicantName: 'Riley Chen',
      applicantEmail: 'riley@example.test',
    },
    {
      ...request,
      id: 'second-synthetic',
      requestId: '66'.repeat(16),
      applicantName: 'Jordan with a longer display name',
      applicantEmail: 'jordan.long-name@example.test',
    },
  ],
  hasMore: false,
  invitations: [offer, linkOffer],
  seatPreview: {
    status: 'billed',
    interval: 'month',
    unitAmount: 2000,
    proratedAmount: 973,
    currentPeriodEnd: 1795000000000,
    seatCount: 2,
    nextSeatCount: 3,
    nextRenewalAmount: 6000,
    currency: 'usd',
  },
};
export const ApprovalQueue: Story = {
  render: () => (
    <div style={{ maxWidth: 600, margin: '24px auto', padding: 16 }}>
      <E2eeTeamSettings
        workspaceId={offer.workspaceId}
        canPromote
        members={[{ membershipId: '88'.repeat(16), role: 'member', name: 'Riley Chen' }]}
        runtime={{
          createMemberInvitation: async () => offer,
          memberJoinRequests: async () => pending,
          approveMemberJoin: async () => ({ admitted: true, keyPending: true }),
          rejectMemberJoin: async () => ({ state: 'rejected' }),
          revokeMemberInvitation: async () => ({ revoked: true }),
          setMemberRole: async () => {},
        }}
      />
    </div>
  ),
};
const settingsFrame = { maxWidth: 600, margin: '24px auto', padding: 16 };
const settingsRuntime = {
  createMemberInvitation: async () => offer,
  rejectMemberJoin: async () => ({ state: 'rejected' as const }),
  revokeMemberInvitation: async () => ({ revoked: true as const }),
};
/** Click Approve: the request shows progress while the relay commits. */
export const ApprovalSubmitting: Story = {
  render: () => (
    <div style={settingsFrame}>
      <E2eeTeamSettings
        workspaceId={offer.workspaceId}
        runtime={{
          ...settingsRuntime,
          memberJoinRequests: async () => ({ ...pending, items: [pending.items[0]!] }),
          approveMemberJoin: () => new Promise(() => {}),
        }}
      />
    </div>
  ),
};
let keyDeliveryReads = 0;
/** Admitted members stay listed while their key is sent; a failed delivery offers a retry. */
export const KeyDelivery: Story = {
  render: () => (
    <div style={settingsFrame}>
      <E2eeTeamSettings
        workspaceId={offer.workspaceId}
        runtime={{
          ...settingsRuntime,
          // The first read names both applicants; afterwards both are committed.
          memberJoinRequests: async () => ({
            ...pending,
            items: keyDeliveryReads++ === 0 ? pending.items : [],
          }),
          approveMemberJoin: async () => ({ admitted: true, keyPending: true }),
          memberKeyDeliveries: async () => ({
            items: [
              { requestId: pending.items[0]!.requestId, state: 'pending' },
              {
                requestId: pending.items[1]!.requestId,
                state: 'failed',
                code: 'e2ee_management_retry',
              },
            ],
          }),
          retryMemberKeyDelivery: async (_workspace, requestId) => ({
            requestId,
            state: 'pending',
          }),
        }}
      />
    </div>
  ),
};
export const ApprovalPaymentRequired: Story = {
  globals: { locale: 'zh_CN' },
  render: () => (
    <div style={settingsFrame}>
      <E2eeTeamSettings
        workspaceId={offer.workspaceId}
        onOpenBilling={() => {}}
        onRefreshBilling={async () => {}}
        runtime={{
          ...settingsRuntime,
          setMemberRole: async () => {},
          memberJoinRequests: async () => ({
            ...pending,
            seatPreview: {
              ...pending.seatPreview!,
              paymentAction: 'payment_required',
            } as E2eeMemberReplies['pending']['seatPreview'],
          }),
          approveMemberJoin: async () => ({ admitted: true, keyPending: true }),
        }}
      />
    </div>
  ),
};
