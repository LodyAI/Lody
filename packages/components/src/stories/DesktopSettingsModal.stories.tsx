import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { Provider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { MemoryRouter } from 'react-router-dom';
import {
  createCapabilitySet,
  createLocalPlatformProvider,
  createStaticStore,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { settingsActiveTabAtom, settingsDialogOpenAtom } from '@/atoms';
import type { SettingsTabId } from '@/components/settings/settings-tabs';
import { DesktopSettingsModal } from '@/components/settings/desktop-settings-modal';
import { StableSessionContext, type StableSessionValue } from '@/hooks/useStableSession';
import type { LodyAuthClient } from '@/lib/auth';
import { AuthProvider } from '@/providers/convex-provider';

const storyUser = {
  id: 'settings-story-user',
  name: 'Zixuan Chen',
  email: 'zixuan@example.com',
  image: null,
};
const storySession = {
  user: storyUser,
  session: {
    id: 'settings-story-session',
    userId: storyUser.id,
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
};
const storyOrganization = {
  id: 'settings-story-workspace',
  name: 'Lody',
  slug: 'lody',
  role: 'owner' as const,
  members: [
    {
      id: 'settings-story-membership',
      userId: storyUser.id,
      organizationId: 'settings-story-workspace',
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
const storyPlatform = {
  ...localStoryPlatform,
  capabilities: createCapabilitySet([...localStoryPlatform.capabilities.list(), 'cloudAccount']),
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

/**
 * Desktop settings modal — the overlay that replaces the full-page settings route on
 * non-mobile viewports. These stories open it at low-dependency tabs (General / About);
 * runtime-heavy tabs (Account, Stats, Agent config, GitHub) need a live workspace
 * runtime and are exercised in the app rather than here.
 */
function OpenModalAt({ tab, children }: { tab: SettingsTabId; children: ReactNode }) {
  useHydrateAtoms([
    [settingsDialogOpenAtom, true],
    [settingsActiveTabAtom, tab],
  ]);
  return <>{children}</>;
}

function SettingsStoryProviders({ children }: { children: ReactNode }) {
  return (
    <PlatformContext.Provider value={storyPlatform}>
      <AuthProvider authClient={storyAuthClient}>
        <StableSessionContext.Provider value={storyStableSessionValue}>
          {children}
        </StableSessionContext.Provider>
      </AuthProvider>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Settings/DesktopSettingsModal',
  component: DesktopSettingsModal,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof DesktopSettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PreferencesTab: Story = {
  render: () => (
    <SettingsStoryProviders>
      <MemoryRouter>
        <Provider>
          <OpenModalAt tab="preferences">
            <DesktopSettingsModal />
          </OpenModalAt>
        </Provider>
      </MemoryRouter>
    </SettingsStoryProviders>
  ),
};

export const AboutTab: Story = {
  render: () => (
    <SettingsStoryProviders>
      <MemoryRouter>
        <Provider>
          <OpenModalAt tab="about">
            <DesktopSettingsModal />
          </OpenModalAt>
        </Provider>
      </MemoryRouter>
    </SettingsStoryProviders>
  ),
};

export const DarkModePreferencesTab: Story = {
  render: () => (
    <div className="dark">
      <SettingsStoryProviders>
        <MemoryRouter>
          <Provider>
            <OpenModalAt tab="preferences">
              <DesktopSettingsModal />
            </OpenModalAt>
          </Provider>
        </MemoryRouter>
      </SettingsStoryProviders>
    </div>
  ),
};
