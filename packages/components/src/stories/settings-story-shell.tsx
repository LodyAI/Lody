import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import {
  createCapabilitySet,
  createLocalPlatformProvider,
  createStaticStore,
  type PlatformCapability,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { StableSessionContext, type StableSessionValue } from '@/hooks/useStableSession';
import type { LodyAuthClient } from '@/lib/auth';
import { AuthProvider } from '@/providers/convex-provider';

/* Shared shell for settings stories. Settings surfaces read the platform, the auth
   client, and the router, so a story that mounts one of them without all three fails
   at render instead of showing the layout it exists to demonstrate. */

const settingsStoryUser = {
  id: 'settings-story-user',
  name: 'Zixuan Chen',
  email: 'zixuan@example.com',
  image: null,
};

const settingsStoryOrganization = {
  id: 'settings-story-workspace',
  name: 'Lody',
  slug: 'lody',
  role: 'owner' as const,
  members: [
    {
      id: 'settings-story-membership',
      userId: settingsStoryUser.id,
      organizationId: 'settings-story-workspace',
      role: 'owner',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ],
};

const settingsStorySession = {
  user: settingsStoryUser,
  session: {
    id: 'settings-story-session',
    userId: settingsStoryUser.id,
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
};

const localStoryPlatform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'authenticated', user: settingsStoryUser }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [settingsStoryOrganization],
    activeWorkspaceId: settingsStoryOrganization.id,
  }),
});

function createStoryAuthClient(role: 'owner' | 'member') {
  const organization = {
    ...settingsStoryOrganization,
    role,
    members: settingsStoryOrganization.members.map((member) => ({ ...member, role })),
  };
  return {
    useSession: () => ({
      data: settingsStorySession,
      isPending: false,
      error: null,
      refetch: async () => ({ data: settingsStorySession, error: null }),
    }),
    useListOrganizations: () => ({
      data: [organization],
      isPending: false,
      error: null,
      refetch: async () => ({ data: [organization], error: null }),
    }),
    useActiveOrganization: () => ({
      data: organization,
      isPending: false,
      error: null,
      refetch: async () => ({ data: organization, error: null }),
    }),
    organization: {
      setActive: async () => ({ data: organization, error: null }),
    },
    signOut: async () => undefined,
  } as unknown as LodyAuthClient;
}

const storyStableSessionValue = {
  data: settingsStorySession,
  rawData: settingsStorySession,
  bootstrapSnapshot: null,
  hasLocalToken: true,
  hasRawUser: true,
  isOptimistic: false,
  isPending: false,
  isRetrying: false,
  error: null,
  confirmedUnauthenticated: false,
  refetch: async () => ({ data: settingsStorySession, error: null }),
} as unknown as StableSessionValue;

/**
 * Platform, auth, and session context for a settings story. `capabilities` are added
 * on top of the local platform's own set, so a story opts in to exactly the
 * cloud-gated entries it wants to show.
 */
export function SettingsStoryProviders({
  capabilities = [],
  role = 'owner',
  children,
}: {
  capabilities?: readonly PlatformCapability[];
  role?: 'owner' | 'member';
  children: ReactNode;
}) {
  const storyAuthClient = useMemo(() => createStoryAuthClient(role), [role]);
  const [platform] = useState(() => ({
    ...localStoryPlatform,
    capabilities: createCapabilitySet([...localStoryPlatform.capabilities.list(), ...capabilities]),
  }));

  return (
    <PlatformContext.Provider value={platform}>
      <AuthProvider authClient={storyAuthClient}>
        <StableSessionContext.Provider value={storyStableSessionValue}>
          {children}
        </StableSessionContext.Provider>
      </AuthProvider>
    </PlatformContext.Provider>
  );
}

/* The settings pages call `useParams({ strict: false })` (via `useClearCache`),
   which still throws without a nearest route match. Render the story through a
   real (memory) router so the page sits inside a matched route component —
   the global preview router only renders stories outside any route. */
function createStoryRouter(children: ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{children}</> });
  return createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    context: {},
  });
}

export function RoutedStory({ children }: { children: ReactNode }) {
  const [router] = useState(() => createStoryRouter(children));
  return <RouterProvider router={router} />;
}
