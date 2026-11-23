import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { ReferralLedgerEntry, ReferralOverview } from '@lody/cloud-api';
import {
  ReferralDetailsDialog,
  ReferralOfferNotice,
  ReferralSettingsView,
} from '../components/settings/referral-settings-pure';
import { settingContainerClass } from '../components/settings';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 21);

const overview: ReferralOverview = {
  eligible: true,
  code: '3f9a1c0e8b7d4e2fa6c5b1d09e8f7a6c',
  url: 'https://lody.ai/login?ref=3f9a1c0e8b7d4e2fa6c5b1d09e8f7a6c',
  issued: 5000,
  spent: 1000,
  available: 4000,
  frozen: 0,
  adjustment: 0,
  newcomerDiscount: false,
};

const entries: ReferralLedgerEntry[] = [
  { id: 'e5', kind: 'release', amount: 500, frozen: 0, createdAt: NOW - 1 * DAY },
  { id: 'e4', kind: 'use', amount: -1500, frozen: 0, createdAt: NOW - 3 * DAY },
  { id: 'e3', kind: 'freeze', amount: 0, frozen: -1728, createdAt: NOW - 9 * DAY },
  { id: 'e2', kind: 'freeze', amount: 0, frozen: 1728, createdAt: NOW - 15 * DAY },
  { id: 'e1', kind: 'reward', amount: 1728, frozen: 0, createdAt: NOW - 20 * DAY },
  { id: 'e0', kind: 'reward', amount: 3272, frozen: 0, createdAt: NOW - 45 * DAY },
];

const empty: ReferralOverview = {
  ...overview,
  code: null,
  url: null,
  issued: 0,
  spent: 0,
  available: 0,
};

const meta = {
  title: 'Settings/Referral',
  component: ReferralSettingsView,
  decorators: [
    (Story) => (
      <div className={settingContainerClass}>
        <Story />
      </div>
    ),
  ],
  args: {
    overview,
    canManage: true,
    onCopy: fn(),
    onOpenDetails: fn(),
  },
} satisfies Meta<typeof ReferralSettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = {};

export const JustCopied: Story = { args: { copied: true } };

export const WithShareSheet: Story = { args: { onShare: fn() } };

/** A newly eligible workspace: no link and no credit yet. */
export const AdminWithoutLink: Story = { args: { overview: empty } };

export const CreatingLink: Story = { args: { overview: empty, linkPending: true } };

export const MemberWithoutLink: Story = { args: { overview: empty, canManage: false } };

/** Members can copy and share a link an admin created. */
export const MemberWithLink: Story = { args: { canManage: false } };

/** No longer able to share (e.g. canceled), but the credit is still the team's. */
export const IneligibleWithCredit: Story = {
  args: { overview: { ...overview, eligible: false } },
};

export const Loading: Story = { args: { overview: undefined } };

type DialogStory = StoryObj<typeof ReferralDetailsDialog>;

export const Details: DialogStory = {
  render: () => (
    <ReferralDetailsDialog overview={overview} entries={entries} onOlder={fn()} onClose={fn()} />
  ),
};

export const DetailsOnHoldAndOffset: DialogStory = {
  render: () => (
    <ReferralDetailsDialog
      overview={{
        ...overview,
        issued: 1728,
        spent: 2728,
        available: 0,
        frozen: 0,
        adjustment: 1000,
      }}
      entries={[
        { id: 'a1', kind: 'adjustment', amount: -1728, frozen: 0, createdAt: NOW - 2 * DAY },
        { id: 'a0', kind: 'use', amount: -2728, frozen: 0, createdAt: NOW - 10 * DAY },
        { id: 'r1', kind: 'reward', amount: 1728, frozen: 0, createdAt: NOW - 20 * DAY },
        { id: 'r0', kind: 'reward', amount: 1728, frozen: 0, createdAt: NOW - 30 * DAY },
      ]}
      onClose={fn()}
    />
  ),
};

export const DetailsEmpty: DialogStory = {
  render: () => <ReferralDetailsDialog overview={empty} entries={[]} onClose={fn()} />,
};

export const DetailsLoading: DialogStory = {
  render: () => <ReferralDetailsDialog overview={overview} entries={undefined} onClose={fn()} />,
};

export const OfferNoticeYearly: StoryObj<typeof ReferralOfferNotice> = {
  render: () => <ReferralOfferNotice interval="year" regularCents={9600} onRemove={fn()} />,
};

export const OfferNoticeMonthlyBound: StoryObj<typeof ReferralOfferNotice> = {
  render: () => <ReferralOfferNotice interval="month" regularCents={1000} />,
};

const campaignPolicy = {
  campaignId: 'example-autumn',
  discountPercent: 20,
  rewardPercent: 25,
  startsAt: Date.UTC(2026, 9, 23, 16),
  endsAt: Date.UTC(2026, 9, 28, 16),
};
export const Campaign: Story = { args: { overview: { ...overview, policy: campaignPolicy } } };
export const CampaignAnnualCheckout: StoryObj<typeof ReferralOfferNotice> = {
  render: () => <ReferralOfferNotice interval="year" regularCents={9600} policy={campaignPolicy} />,
};
export const RetainedCampaignCheckout: StoryObj<typeof ReferralOfferNotice> = {
  render: () => (
    <ReferralOfferNotice
      interval="year"
      regularCents={9600}
      retained={{ policy: campaignPolicy, expiresAt: campaignPolicy.endsAt + 31 * 60000 }}
    />
  ),
};
