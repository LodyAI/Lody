import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { ReactNode } from 'react';
import { Provider as JotaiProvider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import {
  createCapabilitySet,
  createLocalPlatformProvider,
  createStaticStore,
  type CloudApi,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

import { currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import { MobileAboutSettings } from '@/components/mobile/mobile-about-settings';
import { MobileAccountSettings } from '@/components/mobile/mobile-account-settings';
import { MobileAppearanceSettings } from '@/components/mobile/mobile-appearance-settings';
import { MobileGeneralSettings } from '@/components/mobile/mobile-general-settings';
import { MobileSettingsLayout } from '@/components/mobile/mobile-settings-layout';
import { SettingsCategoryList } from '@/components/settings/settings-category-list';
import { WorkspaceJoinRequestsSettings } from '@/components/settings/workspace-join-requests-settings';
import { StableSessionContext, type StableSessionValue } from '@/hooks/useStableSession';
import type { LodyAuthClient } from '@/lib/auth';
import { cloudOperations, type WorkspaceJoinOwnerState } from '@/lib/cloud-api-operations';
import { AuthProvider } from '@/providers/convex-provider';
import { RoutedStory } from './settings-story-shell';

/* Renders the real mobile settings pages (home category list + per-area
   sub-pages) inside the production `MobileSettingsLayout` chrome, so visual
   iteration on spacing/grouping happens against the same components the app
   mounts — not a hand-drawn mock. */

const storyUser = {
  id: 'mobile-settings-story-user',
  name: 'Zixuan Chen',
  email: 'zixuan@example.com',
  image: null,
};
const storySession = {
  user: storyUser,
  session: {
    id: 'mobile-settings-story-session',
    userId: storyUser.id,
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
};
const storyOrganization = {
  id: 'mobile-settings-story-workspace',
  name: 'Lody',
  slug: 'lody',
  role: 'owner' as const,
  members: [
    {
      id: 'mobile-settings-story-membership',
      userId: storyUser.id,
      organizationId: 'mobile-settings-story-workspace',
      role: 'owner',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ],
};
const localStoryPlatform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'authenticated', user: storyUser }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [storyOrganization],
    activeWorkspaceId: storyOrganization.id,
  }),
});
const storyWorkspaceJoinOwnerState: WorkspaceJoinOwnerState = {
  activeLink: null,
  pendingRequests: [],
  hasMorePendingRequests: false,
};
const storyCloudApi = {
  useQuery: (operation) =>
    operation.name === cloudOperations.workspaceJoinRequests.getOwnerState.name
      ? storyWorkspaceJoinOwnerState
      : undefined,
  useMutation: () => async () => null,
  useAction: () => async () => null,
} as CloudApi;
const storyPlatform = {
  ...localStoryPlatform,
  cloudApi: storyCloudApi,
  capabilities: createCapabilitySet([
    ...localStoryPlatform.capabilities.list(),
    'cloudAccount',
    'githubIntegration',
    'usageAnalytics',
    'billing',
    'bugReport',
    'teamSharing',
  ]),
};
const storyAuthClient = {
  useSession: () => ({
    data: storySession,
    isPending: false,
    error: null,
    refetch: async () => ({ data: storySession, error: null }),
  }),
  useListOrganizations: () => ({
    data: [storyOrganization],
    isPending: false,
    error: null,
    refetch: async () => ({ data: [storyOrganization], error: null }),
  }),
  useActiveOrganization: () => ({
    data: storyOrganization,
    isPending: false,
    error: null,
    refetch: async () => ({ data: storyOrganization, error: null }),
  }),
  organization: {
    setActive: async () => ({ data: storyOrganization, error: null }),
  },
  signOut: async () => undefined,
} as unknown as LodyAuthClient;
const storyStableSessionValue = {
  data: storySession,
  rawData: storySession,
  bootstrapSnapshot: null,
  hasLocalToken: true,
  hasRawUser: true,
  isOptimistic: false,
  isPending: false,
  isRetrying: false,
  error: null,
  confirmedUnauthenticated: false,
  refetch: async () => ({ data: storySession, error: null }),
} as unknown as StableSessionValue;

function HydrateStoryAtoms({ children }: { children: ReactNode }) {
  useHydrateAtoms([
    [currentWorkspaceSlugAtom, storyOrganization.slug],
    [userAtom, storyUser],
  ]);
  return <>{children}</>;
}

function StoryProviders({ children }: { children: ReactNode }) {
  return (
    <JotaiProvider>
      <PlatformContext.Provider value={storyPlatform}>
        <AuthProvider authClient={storyAuthClient}>
          <StableSessionContext.Provider value={storyStableSessionValue}>
            <HydrateStoryAtoms>{children}</HydrateStoryAtoms>
          </StableSessionContext.Provider>
        </AuthProvider>
      </PlatformContext.Provider>
    </JotaiProvider>
  );
}

function PhoneFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <StoryProviders>
      <RoutedStory>
        <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
          <div className="h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
            <MobileSettingsLayout
              title={title}
              isNativeApp={false}
              isMachineDetail={false}
              isAgentConfigTab={false}
              onBack={fn()}
            >
              {children}
            </MobileSettingsLayout>
          </div>
        </div>
      </RoutedStory>
    </StoryProviders>
  );
}

const meta = {
  title: 'Mobile/MobileSettingsPages',
  component: PhoneFrame,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PhoneFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Settings home — the iOS-style grouped category list. */
export const Home: Story = {
  args: { title: 'Settings', children: <SettingsCategoryList workspaceName="lody" /> },
};

/** General (preferences) sub-page: notifications, input, sessions. */
export const General: Story = {
  args: { title: 'General', children: <MobileGeneralSettings /> },
};

/** Appearance sub-page: theme, language, font size. */
export const Appearance: Story = {
  args: { title: 'Appearance', children: <MobileAppearanceSettings /> },
};

/** About sub-page: version rows, links, beta gates. */
export const About: Story = {
  args: { title: 'About', children: <MobileAboutSettings /> },
};

const storyCliApiKeys = [
  {
    id: 'key-1',
    name: 'MacBook Pro CLI',
    keyStart: 'lody_sk_9f3k',
    keyPreview: 'lody_sk_9f3k…8d2s',
    note: 'MacBook Pro CLI',
    source: 'manual' as const,
    createdAt: Date.parse('2026-07-20T09:24:00Z'),
    lastRequest: Date.parse('2026-08-13T18:02:00Z'),
    expiresAt: null,
    enabled: true,
  },
  {
    id: 'key-2',
    name: 'Untitled token',
    keyStart: 'lody_sk_51ab',
    keyPreview: 'lody_sk_51ab…c077',
    note: null,
    source: 'auto' as const,
    createdAt: Date.parse('2026-08-01T14:11:00Z'),
    lastRequest: null,
    expiresAt: null,
    enabled: true,
  },
];

const asyncNoop = async () => {};

/** Account sub-page: profile rows, bindings, password, CLI keys, sign out. */
export const Account: Story = {
  args: {
    title: 'Account',
    children: (
      <MobileAccountSettings
        surface="account"
        currentUser={storyUser}
        organization={storyOrganization}
        role="owner"
        hasAdminPermission
        members={[]}
        pendingInvitations={[]}
        onSignOut={fn()}
        onInviteMember={async () => null}
        onRemoveMember={asyncNoop}
        onUpdateRole={asyncNoop}
        onCopyInviteLink={asyncNoop}
        onCancelInvitation={asyncNoop}
        onLeaveOrganization={asyncNoop}
        onDeleteOrganization={asyncNoop}
        onDeleteAccount={asyncNoop}
        onRenameOrganization={asyncNoop}
        getInviteLink={() => 'https://example.com/invite/abc'}
        onUpdateUserName={asyncNoop}
        onUploadAvatar={async () => ''}
        linkedAccounts={[]}
        onConnectAccount={asyncNoop}
        hasPasswordCredential
        onChangePassword={asyncNoop}
        onVerifyCurrentPassword={async () => true}
        onSetupPassword={asyncNoop}
        canGenerateCliApiKey
        cliApiKeys={storyCliApiKeys}
        onGenerateCliApiKey={asyncNoop}
        onRevokeCliApiKey={asyncNoop}
      />
    ),
  },
};

const storyMembers = [
  {
    id: 'm-1',
    userId: storyUser.id,
    role: 'owner',
    user: storyUser,
  },
  {
    id: 'm-2',
    userId: 'user-2',
    role: 'admin',
    user: { id: 'user-2', name: 'Ada Lovelace', email: 'ada@example.com', image: null },
  },
  {
    id: 'm-3',
    userId: 'user-3',
    role: 'member',
    user: {
      id: 'user-3',
      name: 'Grace Hopper-With-A-Very-Long-Name',
      email: 'grace.hopper.with.a.very.long.email@example.com',
      image: null,
    },
  },
];

const storyInvitations = [
  {
    id: 'inv-1',
    organizationId: storyOrganization.id,
    email: 'new.teammate@example.com',
    role: 'member',
    status: 'pending' as const,
    inviterId: storyUser.id,
    expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  },
  {
    id: 'inv-2',
    organizationId: storyOrganization.id,
    email: 'another.person.with.long.address@example.com',
    role: 'admin',
    status: 'pending' as const,
    inviterId: storyUser.id,
    expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
  },
];

function WorkspaceSettingsStory({ showJoinRequests = false }: { showJoinRequests?: boolean }) {
  return (
    <MobileAccountSettings
      surface="workspace"
      currentUser={storyUser}
      organization={
        showJoinRequests
          ? { ...storyOrganization, name: 'Riverstone Research Workspace' }
          : storyOrganization
      }
      role="owner"
      hasAdminPermission
      members={storyMembers}
      pendingInvitations={showJoinRequests ? [] : storyInvitations}
      onSignOut={fn()}
      onInviteMember={async () => null}
      onRemoveMember={asyncNoop}
      onUpdateRole={asyncNoop}
      onCopyInviteLink={asyncNoop}
      onCancelInvitation={asyncNoop}
      onLeaveOrganization={asyncNoop}
      onDeleteOrganization={asyncNoop}
      onDeleteAccount={asyncNoop}
      onRenameOrganization={asyncNoop}
      getInviteLink={() => 'https://example.com/invite/abc'}
      onUploadAvatar={async () => ''}
      workspaceJoinRequestsSlot={
        showJoinRequests ? (
          <WorkspaceJoinRequestsSettings workspaceId={storyOrganization.id} />
        ) : undefined
      }
    />
  );
}

/** Workspace sub-page: name/logo, members, invitations, danger zone. */
export const Workspace: Story = {
  args: { title: 'Workspace', children: <WorkspaceSettingsStory /> },
};

/** Owner workspace with the join-request card and a long editable name. */
export const WorkspaceJoinRequests: Story = {
  args: { title: 'Workspace', children: <WorkspaceSettingsStory showJoinRequests /> },
};
